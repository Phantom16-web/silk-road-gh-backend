import { assertRentalSettlementReady } from "../services/rentalSettlementGuard.js"
import express from 'express'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import Order from '../models/Order.js'
import CheckoutGroup from '../models/CheckoutGroup.js'
import RiderFundingChoice from '../models/RiderFundingChoice.js'
import PayoutIntent from '../models/PayoutIntent.js'
import PayoutRecipient from '../models/PayoutRecipient.js'
import { requireAdminAuth, requireOwner, requireReAuth, logAction } from '../middleware/adminAuth.js'
import { ghsToMinor } from '../services/settlementMath.js'
import { paystackKeyMode } from '../services/paystackTransfers.js'
import { submitApprovedPayout, reconcilePayout } from '../services/payoutExecutor.js'

const router=express.Router()
router.use(requireAdminAuth,requireOwner)
const error=(message,status=409)=>Object.assign(new Error(message),{status})
const handler=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error('Settlement:',e);res.status(e.status||503).json({message:e.status?e.message:'Settlement unavailable. No new transfer should be attempted until reconciled.'})})
const validRecipient=x=>typeof x==='string'&&/^RCP_[A-Za-z0-9]+$/.test(x)

router.get('/queue',handler(async(req,res)=>{
 const orders=await Order.find({paymentStatus:'release_pending',fulfillmentStatus:'completed'}).select('_id seller sellerAmount amount platformFee environment').sort({completedAt:1}).limit(100).lean()
 const intents=await PayoutIntent.find({order:{$in:orders.map(o=>o._id)}}).select('order role state amountMinor reference recipientCode').lean()
 res.json({orders:orders.map(o=>({...o,intents:intents.filter(p=>String(p.order)===String(o._id)).map(p=>({role:p.role,state:p.state,amountMinor:p.amountMinor,reference:p.reference}))})),keyMode:paystackKeyMode()})
}))

// A single atomic transaction creates the seller and rider obligations together.
// This route does NOT send money; it records Owner-reviewed entitlements.
router.post('/orders/:orderId/approve',requireReAuth,handler(async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.orderId))throw error('Invalid order',400)
 const session=await mongoose.startSession()
 let result
 try{await session.withTransaction(async()=>{
  const order=await Order.findById(req.params.orderId).session(session)
  if(!order||order.paymentStatus!=='release_pending'||order.fulfillmentStatus!=='completed'||order.cancelled)throw error('Order not eligible for settlement')
  await assertRentalSettlementReady(order, session)
  const group=await CheckoutGroup.findOne({orderIds:order._id,status:'verified',paymentMethod:'paystack'}).session(session)
  if(!group||group.environment!==order.environment)throw error('Verified Paystack checkout required')
  const environment=order.environment==='testing'?'test':'live'
  if(paystackKeyMode()!==environment)throw error('Paystack key environment mismatch')
  const rider=await RiderFundingChoice.findOne({order:order._id}).session(session)
  if(rider&&rider.status!=='delivery_confirmed')throw error('Rider funding not ready for settlement')
  if(rider?.fundingSource==='separate')throw error('Separate rider funding needs manual reconciliation')
  if(rider?.fundingSource==='earnings'&&!rider.deliveryId)throw error('Missing assigned rider delivery')
  const riderMinor=rider?.fundingSource==='earnings'?ghsToMinor(rider.quotedFee):0
  const sellerMinor=ghsToMinor(order.sellerAmount)-riderMinor
  if(sellerMinor<0)throw error('Rider fee exceeds seller proceeds')
  if(sellerMinor<1000||(riderMinor>0&&riderMinor<1000))throw error('Paystack minimum transfer GHS 10; manual settlement needed')
  if(await PayoutIntent.exists({order:order._id}).session(session))throw error('Payout already approved or in progress; reconcile existing intent')
  const items=[{role:'seller',beneficiary:order.seller,amountMinor:sellerMinor}]
  if(riderMinor){
   const Delivery=(await import('../models/Delivery.js')).default
   const delivery=await Delivery.findById(rider.deliveryId).session(session)
   if(!delivery?.rider)throw error('Assigned rider not found')
   items.push({role:'rider',beneficiary:delivery.rider,amountMinor:riderMinor})
  }
  for(const item of items){
    const bound=await PayoutRecipient.findOne({beneficiary:item.beneficiary,role:item.role,environment,status:'approved'}).session(session)
    if(!bound||!validRecipient(bound.recipientCode))throw error(`Approved ${item.role} payout destination required; beneficiary must enroll and Owner must verify`)
    item.recipientCode=bound.recipientCode
  }
  const rows=items.map(item=>({order:order._id,checkoutId:group.id,beneficiary:item.beneficiary,role:item.role,environment,provider:'paystack',amountMinor:item.amountMinor,recipientCode:item.recipientCode,reference:`SR-${item.role.toUpperCase()}-${crypto.randomBytes(16).toString('hex').toUpperCase()}`,approvedBy:req.adminUser._id||null,approvedAt:new Date()}))
  await PayoutIntent.insertMany(rows,{session})
  result={orderId:String(order._id),intents:rows.map(x=>({role:x.role,amountMinor:x.amountMinor,reference:x.reference})),message:'Payout intents approved. No transfers initiated.'}
 })}finally{await session.endSession()}
 await logAction(req,'paystack_payouts_approved','order',req.params.orderId,{references:result.intents.map(x=>x.reference)})
 res.status(201).json(result)
}))

router.post('/intents/:id/submit',requireReAuth,handler(async(req,res)=>{
 if(process.env.ENABLE_PAYSTACK_PAYOUT_EXECUTION!=='true')throw error('Automated payout execution disabled by server configuration',403)
 if(!mongoose.isValidObjectId(req.params.id))throw error('Invalid payout intent',400)
 const intent=await PayoutIntent.findById(req.params.id)
 if(!intent)throw error('Intent not found',404)
 const order=await Order.findById(intent.order)
 const group=await CheckoutGroup.findById(intent.checkoutId)
 if(!order||!group||group.status!=='verified'||order.paymentStatus!=='release_pending'||order.fulfillmentStatus!=='completed'||order.cancelled||order.environment!==(intent.environment==='test'?'testing':'live'))throw error('Financial state changed. Do not transfer.')
 await assertRentalSettlementReady(order)
 const other=await PayoutIntent.find({order:order._id,state:{$in:['failed','reversed','cancelled']}})
 if(other.length)throw error('Other payout entitlement needs reconciliation')
 const output=await submitApprovedPayout(intent.id)
 await logAction(req,'paystack_payout_submitted','payout_intent',intent.id,{reference:intent.reference,result:output.state})
 res.json(output)
}))
router.post('/intents/:id/reconcile',handler(async(req,res)=>{
 const intent=await PayoutIntent.findById(req.params.id)
 if(!intent)throw error('Intent not found',404)
 const output=await reconcilePayout(intent.reference)
 res.json({id:output.id,state:output.state,reference:output.reference})
}))
export default router

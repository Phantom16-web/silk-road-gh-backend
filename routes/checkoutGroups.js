import express from 'express'
import mongoose from 'mongoose'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import Listing from '../models/Listing.js'
import Order from '../models/Order.js'
import CheckoutGroup from '../models/CheckoutGroup.js'
import { getEnvironmentMode } from '../models/Environment.js'
import { getPaymentMode } from '../models/PaymentSettings.js'
import { commissionAt, feeInPesewas } from '../services/commissionPolicy.js'
import CommissionOrderSnapshot from '../models/CommissionOrderSnapshot.js'
const router=express.Router()
const money=n=>Math.round(n*100)/100
const mongoId=x=>mongoose.isValidObjectId(x)&&String(x).length===24
function buyerId(req){try{const h=req.headers.authorization;if(!h?.startsWith('Bearer '))return null;const p=jwt.verify(h.slice(7),process.env.JWT_SECRET);return mongoId(p.id)?p.id:null}catch{return null}}
router.post('/',async(req,res)=>{
 const {items,localOrderId,location,landmark,extraInfo,contactInfo,payerName,payerPhone,promoCode,deliveryMethod='pickup'}=req.body||{}
 if(!Array.isArray(items)||items.length<1||items.length>50||items.some(i=>!mongoId(i.listingId)||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>100))return res.status(400).json({message:'Cart must contain 1–50 valid listings with quantities from 1 to 100.'})
 if(!localOrderId||!/^\w[\w-]{5,89}$/.test(localOrderId))return res.status(400).json({message:'Invalid checkout reference.'})
 if(!['pickup','rider'].includes(deliveryMethod))return res.status(400).json({message:'Invalid delivery method.'})
 if(!payerName?.trim()||!payerPhone?.trim())return res.status(400).json({message:'Name and phone are required.'})
 if(promoCode)return res.status(409).json({message:'Promo checkout disabled until discounts are server-validated.'})
 // Rider delivery is a REQUEST only. No buyer delivery charge is collected here.
 // The seller later obtains a server-calculated quote and reserves the rider fee from seller proceeds.
 const buyer=buyerId(req),checkoutId=`SC-${crypto.randomUUID()}`,claimToken=crypto.randomBytes(32).toString('hex'),claimTokenHash=crypto.createHash('sha256').update(claimToken).digest('hex')
 try{
  const paymentMode=await getPaymentMode()
  if(!['manual','paystack'].includes(paymentMode))return res.status(503).json({message:'Payment mode unavailable.'})
  const environment=await getEnvironmentMode()
  if(paymentMode==='paystack'){
   const key=process.env.PAYSTACK_SECRET_KEY||''
   if(process.env.ENABLE_HYBRID_PAYSTACK!=='true'||!(key.startsWith('sk_test_')&&environment==='testing'||key.startsWith('sk_live_')&&environment==='live'))return res.status(503).json({message:'Paystack configuration and marketplace environment do not match.'})
  }
  const paymentMethod=paymentMode==='paystack'?'paystack':'manual_momo'
  const uniqueIds=[...new Set(items.map(i=>String(i.listingId)))]
  if(uniqueIds.length!==items.length)return res.status(400).json({message:'Merge duplicate listings in your cart.'})
  const listings=await Listing.find({_id:{$in:uniqueIds},status:'Active',type:'product'}).lean()
  if(listings.length!==uniqueIds.length)return res.status(409).json({message:'A product is no longer available.'})
  const byId=new Map(listings.map(l=>[String(l._id),l]))
  const lines=items.map(i=>{const listing=byId.get(String(i.listingId)),price=Number(listing.price);if(!Number.isFinite(price)||price<=0||!mongoId(listing.seller))throw Error('Invalid product price or seller.');return {listing,quantity:i.quantity,unitPrice:money(price),lineTotal:money(price*i.quantity)}})
  const subtotal=money(lines.reduce((s,i)=>s+i.lineTotal,0)),total=subtotal
  const paymentReference=paymentMode==='manual'?`SR-MANUAL-${crypto.randomBytes(9).toString('hex').toUpperCase()}`:`SR-AWAITING-${crypto.randomBytes(9).toString('hex').toUpperCase()}`
  const groupItems=[],session=await mongoose.startSession()
  let chargedRateBps = null
  try{await session.withTransaction(async()=>{
   const chargedAt = new Date()
   const commission = await commissionAt(chargedAt, session)
   chargedRateBps = commission.rateBasisPoints
   for(const line of lines){const amount=line.lineTotal,platformFee=feeInPesewas(Math.round(amount*100), commission.rateBasisPoints)/100
    const [order]=await Order.create([{buyer:buyer||null,seller:line.listing.seller,listing:line.listing._id,localOrderId,type:'product',environment,amount,platformFee,sellerAmount:money(amount-platformFee),discount:0,paymentMethod,paymentStatus:'pending',fulfillmentStatus:'pending_payment',status:'Pending Confirmation',location:location||null,landmark:landmark||null,extraInfo:extraInfo||null,contactInfo:contactInfo||null,payerName:payerName.trim(),payerPhone:payerPhone.trim(),deliveryMethod}],{session})
    await CommissionOrderSnapshot.create([{order:order._id,checkoutId,rateBasisPoints:commission.rateBasisPoints,schedule:commission.scheduleId,chargedAt,feeGHS:platformFee}],{session})
    groupItems.push({orderId:String(order._id),listingId:String(line.listing._id),sellerId:String(line.listing.seller),title:line.listing.title,quantity:line.quantity,unitPrice:line.unitPrice,amount,platformFee,sellerAmount:money(amount-platformFee)})
   }
   await CheckoutGroup.create([{_id:checkoutId,localOrderId,buyer:buyer||null,orderIds:groupItems.map(i=>i.orderId),amount:total,paymentMethod,paymentReference,environment,claimTokenHash,payerName:payerName.trim(),payerPhone:payerPhone.trim()}],{session})
  })}finally{await session.endSession()}
  return res.status(201).json({checkoutId,claimToken,total,subtotal,commissionRatePercent:chargedRateBps/100,deliveryFee:0,paymentReference:paymentMode==='manual'?paymentReference:null,paymentMethod,paymentStatus:'pending',orders:groupItems,environment,paystackInitializePath:paymentMode==='paystack'?`/api/checkout-paystack/${encodeURIComponent(checkoutId)}/initialize`:null,message:deliveryMethod==='rider'?'Rider delivery requested. Seller must accept a server-calculated rider fee from seller proceeds after payment verification.':'Orders created. Payment has not been verified.'})
 }catch(e){console.error('Grouped checkout failed',e);return res.status(503).json({message:'Checkout could not be committed. No payment was verified.'})}
})
export default router

import {Router} from 'express';
import mongoose from 'mongoose';
import protect from '../middleware/auth.js';
import Listing from '../models/Listing.js';
import ServiceRequest from '../models/ServiceRequest.js';
import Order from '../models/Order.js';
import {getEnvironmentMode} from '../models/Environment.js';
import PaymentSettings, {getPaymentMode} from '../models/PaymentSettings.js';
import CheckoutGroup from '../models/CheckoutGroup.js';
import CommissionOrderSnapshot from '../models/CommissionOrderSnapshot.js';
import {commissionAt,feeInPesewas} from '../services/commissionPolicy.js';
import crypto from 'node:crypto';
const router=Router();
router.use(protect);
const safeId=id=>mongoose.isValidObjectId(id);
const responseFields='listing buyer provider description scheduledFor location contact quotedPrice status createdAt expiresAt respondedAt paymentOrder';
const money=n=>Math.round(n*100)/100;
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
router.post('/',async(req,res)=>{
 try{
  const {listingId,description,scheduledFor,location='',contact}=req.body||{};
  if(!safeId(listingId))return res.status(400).json({message:'Invalid listing.'});
  const listing=await Listing.findOne({_id:listingId,type:'service',status:'Active'}).select('seller price');
  if(!listing)return res.status(404).json({message:'Service unavailable.'});
  if(String(listing.seller)===req.user.id)return res.status(400).json({message:'You cannot book your own service.'});
  const when=new Date(scheduledFor);
  if(!Number.isFinite(when.getTime())||when.getTime()<=Date.now()||when.getTime()>Date.now()+180*86400000)return res.status(400).json({message:'Choose a future date within 180 days.'});
  if(typeof description!=='string'||description.trim().length<10||description.length>2000||typeof contact!=='string'||!contact.trim()||contact.length>200||typeof location!=='string'||location.length>300)return res.status(400).json({message:'Provide a valid description, contact and location.'});
  if(!Number.isFinite(listing.price)||listing.price<0)return res.status(400).json({message:'Service price unavailable.'});
  const item=await ServiceRequest.create({listing:listing._id,buyer:req.user.id,provider:listing.seller,description:description.trim(),scheduledFor:when,location:location.trim(),contact:contact.trim(),quotedPrice:listing.price,expiresAt:new Date(Date.now()+48*3600000)});
  return res.status(201).json({request:item,message:'Request sent. Payment is unavailable until the provider accepts.'});
 }catch(e){console.error('service request create',e);return res.status(500).json({message:'Could not create request.'})}
});
router.get('/mine',async(req,res)=>{
 try{
  const role=req.query.role==='provider'?'provider':'buyer';
  const items=await ServiceRequest.find({[role]:req.user.id}).select(responseFields).populate('listing','title image type category serviceDelivery').sort({createdAt:-1}).limit(100).lean();
  const ids=items.filter(i=>i.paymentOrder).map(i=>i.paymentOrder);
  const orders=await Order.find({_id:{$in:ids}}).select('_id paymentStatus fulfillmentStatus paymentMethod environment').lean();
  const orderMap=new Map(orders.map(o=>[String(o._id),o]));
  res.json({requests:items.map(i=>({...i,payment:orderMap.get(String(i.paymentOrder))||null}))});
 }catch(e){res.status(500).json({message:'Could not load requests.'})}
});
router.post('/:id/respond',async(req,res)=>{
 try{
  if(!safeId(req.params.id)||!['accept','decline'].includes(req.body?.decision))return res.status(400).json({message:'Invalid response.'});
  const now=new Date();
  const request=await ServiceRequest.findOneAndUpdate({_id:req.params.id,provider:req.user.id,status:'requested',expiresAt:{$gt:now}},{$set:{status:req.body.decision==='accept'?'accepted':'declined',respondedAt:now}},{new:true});
  if(!request)return res.status(409).json({message:'Request is unavailable, expired, or already answered.'});
  res.json({request,message:request.status==='accepted'?'Request accepted. Payment integration is not enabled in this staging phase.':'Request declined.'});
 }catch(e){res.status(500).json({message:'Could not respond.'})}
});
router.post('/:id/cancel',async(req,res)=>{
 try{
  if(!safeId(req.params.id))return res.status(400).json({message:'Invalid request.'});
  const request=await ServiceRequest.findOneAndUpdate({_id:req.params.id,buyer:req.user.id,status:{$in:['requested','accepted']}},{$set:{status:'cancelled'}},{new:true});
  if(!request)return res.status(409).json({message:'Request cannot be cancelled here.'});
  res.json({request});
 }catch(e){res.status(500).json({message:'Could not cancel request.'})}
});

// Payment is available only after provider acceptance. Creation of the order,
// commission snapshot, checkout group and request linkage is one MongoDB transaction.
router.post('/:id/checkout',async(req,res)=>{
 if(!safeId(req.params.id))return res.status(400).json({message:'Invalid request.'});
 const session=await mongoose.startSession();
 try{
  let result;
  await session.withTransaction(async()=>{
   const sr=await ServiceRequest.findOne({_id:req.params.id,buyer:req.user.id}).session(session);
   if(!sr)throw fail('Request not found.',404);
   if(sr.paymentOrder)throw fail('Checkout already exists. Open your request to continue it.');
   if(sr.status!=='accepted')throw fail('Provider must accept before payment.');
   if(sr.scheduledFor<=new Date())throw fail('Appointment time has passed; request rescheduling.');
   const listing=await Listing.findOne({_id:sr.listing,type:'service',status:'Active',seller:sr.provider}).session(session);
   if(!listing||!Number.isFinite(listing.price)||listing.price<=0||money(listing.price)!==money(sr.quotedPrice))throw fail('Service or agreed price changed; request a new quote.');
   const mode=await getPaymentMode(),environment=await getEnvironmentMode();
   if(!['manual','paystack'].includes(mode))throw fail('Payment mode unavailable.',503);
   if(mode==='paystack'){
    const key=process.env.PAYSTACK_SECRET_KEY||'';
    if(process.env.ENABLE_HYBRID_PAYSTACK!=='true'||!(environment==='testing'&&key.startsWith('sk_test_')||environment==='live'&&key.startsWith('sk_live_')))throw fail('Paystack configuration and environment mismatch.',503);
   }
   const paymentMethod=mode==='paystack'?'paystack':'manual_momo';
   let manualMomoSnapshot=null;
   if(paymentMethod==='manual_momo' && environment==='live'){
    const cfg=await PaymentSettings.findById('global').session(session).lean();
    const m=cfg?.manualMomo;
    if(!m?.enabled || !m?.number || !m?.accountName || !['MTN','Telecel','AT'].includes(m.network))throw fail('Manual MoMo receiving account is not configured by the Owner.',503);
    manualMomoSnapshot={network:m.network,number:m.number,accountName:m.accountName};
   }
   const commission=await commissionAt(new Date(),session);
   const amount=money(sr.quotedPrice),platformFee=feeInPesewas(Math.round(amount*100),commission.rateBasisPoints)/100;
   const checkoutId=`SC-${crypto.randomUUID()}`,localOrderId=`SVC-${crypto.randomUUID()}`;
   const claimToken=crypto.randomBytes(32).toString('hex'),claimTokenHash=crypto.createHash('sha256').update(claimToken).digest('hex');
   const paymentReference=paymentMethod==='manual_momo'?`SR-MANUAL-${crypto.randomBytes(9).toString('hex').toUpperCase()}`:`SR-AWAITING-${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
   const [order]=await Order.create([{buyer:sr.buyer,seller:sr.provider,listing:sr.listing,localOrderId,type:'service',environment,amount,platformFee,sellerAmount:money(amount-platformFee),discount:0,paymentMethod,paymentStatus:'pending',fulfillmentStatus:'pending_payment',status:'Pending Confirmation',contactInfo:sr.contact,location:sr.location||null,deliveryMethod:'pickup'}],{session});
   await CommissionOrderSnapshot.create([{order:order._id,checkoutId,rateBasisPoints:commission.rateBasisPoints,schedule:commission.scheduleId,chargedAt:new Date(),feeGHS:platformFee}],{session});
   await CheckoutGroup.create([{_id:checkoutId,localOrderId,buyer:sr.buyer,orderIds:[order._id],amount,paymentMethod,paymentReference,environment,claimTokenHash,manualMomoSnapshot}],{session});
   const changed=await ServiceRequest.updateOne({_id:sr._id,status:'accepted',paymentOrder:null},{$set:{status:'payment_pending',paymentOrder:order._id}},{session});
   if(changed.modifiedCount!==1)throw fail('Another checkout is already in progress.');
   result={checkoutId,claimToken,orderId:String(order._id),amount,paymentMethod,environment,commissionRatePercent:commission.rateBasisPoints/100,paymentReference:paymentMethod==='manual_momo'?paymentReference:null,manualMomo:manualMomoSnapshot,paystackInitializePath:paymentMethod==='paystack'?`/api/checkout-paystack/${encodeURIComponent(checkoutId)}/initialize`:null,message:'Checkout created. No funds have been verified.'};
  });
  res.status(201).json(result);
 }catch(e){console.error('Service checkout',e);res.status(e.status||503).json({message:e.status?e.message:'Checkout failed safely. No payment was verified.'})}
 finally{await session.endSession()}
});

// Buyer can inspect the existing checkout after a page reload. Only the buyer
// who owns the service request receives the claim token at creation time.
router.get('/:id/checkout',async(req,res)=>{
 try{
  if(!safeId(req.params.id))return res.status(400).json({message:'Invalid request.'});
  const sr=await ServiceRequest.findOne({_id:req.params.id,buyer:req.user.id});
  if(!sr)return res.status(404).json({message:'Request not found.'});
  if(!sr.paymentOrder)return res.json({checkout:null});
  const group=await CheckoutGroup.findOne({orderIds:sr.paymentOrder}).select('_id amount status paymentMethod paymentReference environment manualMomoSnapshot');
  if(!group)return res.status(409).json({message:'Checkout requires support reconciliation.'});
  res.json({checkout:{checkoutId:group.id,amount:group.amount,status:group.status,paymentMethod:group.paymentMethod,environment:group.environment,paymentReference:group.paymentMethod==='manual_momo'?group.paymentReference:null,manualMomo:group.paymentMethod==='manual_momo'?group.manualMomoSnapshot:null},message:'For payment actions, use the original checkout claim token. Contact support if lost.'});
 }catch(e){res.status(500).json({message:'Unable to load checkout.'})}
});

// Service completion is a two-party process. Provider declares work done;
// buyer confirms it. Neither party can approve their own payout.
router.post('/:id/provider-complete',async(req,res)=>{
 try{
  if(!safeId(req.params.id))return res.status(400).json({message:'Invalid request.'});
  const sr=await ServiceRequest.findOne({_id:req.params.id,provider:req.user.id});
  if(!sr?.paymentOrder)return res.status(409).json({message:'No funded service request.'});
  const group=await CheckoutGroup.findOne({orderIds:sr.paymentOrder,status:'verified'});
  const order=await Order.findById(sr.paymentOrder);
  if(!group||!order||order.paymentStatus!=='escrow_held'||group.environment!==order.environment)return res.status(409).json({message:'Payment is not verified or settlement is frozen.'});
  const updated=await ServiceRequest.findOneAndUpdate({_id:sr._id,status:{$in:['payment_pending','paid','in_progress']}},{$set:{status:'provider_completed'}},{new:true});
  if(!updated)return res.status(409).json({message:'Request already completed or disputed.'});
  res.json({request:updated,message:'Customer confirmation is required before settlement.'});
 }catch(e){res.status(500).json({message:'Could not mark service complete.'})}
});
router.post('/:id/confirm-complete',async(req,res)=>{
 const session=await mongoose.startSession();
 try{
  await session.withTransaction(async()=>{
   if(!safeId(req.params.id))throw fail('Invalid request.',400);
   const sr=await ServiceRequest.findOne({_id:req.params.id,buyer:req.user.id,status:'provider_completed'}).session(session);
   if(!sr?.paymentOrder)throw fail('Provider has not completed this service.');
   const order=await Order.findById(sr.paymentOrder).session(session);
   const group=await CheckoutGroup.findOne({orderIds:sr.paymentOrder,status:'verified'}).session(session);
   if(!order||!group||order.paymentStatus!=='escrow_held'||order.environment!==group.environment||order.cancelled)throw fail('Escrow is not eligible for release.');
   const changed=await Order.updateOne({_id:order._id,paymentStatus:'escrow_held',cancelled:{$ne:true}},{$set:{paymentStatus:'release_pending',fulfillmentStatus:'completed',completedAt:new Date(),status:'Awaiting Settlement'}},{session});
   if(changed.modifiedCount!==1)throw fail('Order state changed.');
   const done=await ServiceRequest.updateOne({_id:sr._id,status:'provider_completed'},{$set:{status:'completed'}},{session});
   if(done.modifiedCount!==1)throw fail('Request state changed.');
  });
  res.json({message:'Completion confirmed. Payout remains subject to Owner review and verified settlement.'});
 }catch(e){res.status(e.status||500).json({message:e.status?e.message:'Could not confirm completion.'})}
 finally{await session.endSession()}
});
router.post('/:id/dispute',async(req,res)=>{
 const reason=req.body?.reason;
 if(typeof reason!=='string'||reason.trim().length<10||reason.length>2000)return res.status(400).json({message:'Explain the issue (10–2000 characters).'});
 const session=await mongoose.startSession();
 try{
  await session.withTransaction(async()=>{
   if(!safeId(req.params.id))throw fail('Invalid request.',400);
   const sr=await ServiceRequest.findOne({_id:req.params.id,buyer:req.user.id}).session(session);
   if(!sr?.paymentOrder)throw fail('No funded service to dispute.');
   const order=await Order.findById(sr.paymentOrder).session(session);
   const group=await CheckoutGroup.findOne({orderIds:sr.paymentOrder,status:'verified'}).session(session);
   if(!order||!group||order.paymentStatus!=='escrow_held')throw fail('Contact support for this payment state.');
   const changed=await Order.updateOne({_id:order._id,paymentStatus:'escrow_held'},{$set:{paymentStatus:'disputed',fulfillmentStatus:'disputed',status:'Disputed'}},{session});
   if(changed.modifiedCount!==1)throw fail('Order state changed.');
   group.status='disputed';group.disputeOpenedAt=new Date();group.disputeReason=reason.trim();await group.save({session});
   sr.status='disputed';await sr.save({session});
  });
  res.json({message:'Dispute recorded. Funds are frozen pending support investigation; no automatic refund was issued.'});
 }catch(e){res.status(e.status||500).json({message:e.status?e.message:'Dispute could not be opened.'})}
 finally{await session.endSession()}
});
export default router;

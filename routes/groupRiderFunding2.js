import express from "express"
import mongoose from "mongoose"
import protect from "../middleware/auth.js"
import Delivery from "../models/Delivery.js"
import CheckoutGroup from "../models/CheckoutGroup.js"
import Order from "../models/Order.js"
import RiderFundingChoice from "../models/RiderFundingChoice.js"
import { getEnvironmentMode } from "../models/Environment.js"
import { haversineKm, calculateDeliveryFee } from "../utils/distance.js"

const router = express.Router()
const money = value => Math.round(Number(value) * 100) / 100
const conflict = message => Object.assign(new Error(message), { status: 409 })
const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
const activeStates = ["pending", "accepted", "picked_up", "delivered", "completed"]

async function eligibleOrder(orderId, sellerId, session) {
  const mode = await getEnvironmentMode()
  if (!["testing", "live"].includes(mode)) throw conflict("Marketplace mode is unavailable.")
  const order = await Order.findOne({ _id: orderId, seller: sellerId, environment: mode,
    paymentStatus: "escrow_held", fulfillmentStatus: "awaiting_delivery", cancelled: { $ne: true } }).session(session)
  if (!order) throw conflict("Order is not eligible for rider funding in the current environment.")
  // Simulated escrow is not real money. Never permit simulated orders in Live Mode,
  // or non-simulated orders to masquerade as testing transactions.
  if (mode === "testing" && order.isSimulatedPayment !== true) throw conflict("A verified simulated payment is required.")
  if (mode === "live" && order.isSimulatedPayment === true) throw conflict("Simulated payments cannot fund live delivery.")
  const group = await CheckoutGroup.findOne({ orderIds: order._id, environment: mode, status: "verified" }).session(session)
  if (!group) throw conflict("A verified checkout group in the same environment is required.")
  return { order, group, mode }
}

router.post("/:orderId/choose", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId) || req.body?.fundingSource !== "earnings")
    return res.status(400).json({ message: "Rider fees must be reserved from seller proceeds." })
  const { pickupLat, pickupLng, dropLat, dropLng, pickupAddress = "", dropAddress = "" } = req.body || {}
  const [a, b, c, d] = [pickupLat, pickupLng, dropLat, dropLng].map(Number)
  if (!validPoint(a, b) || !validPoint(c, d)) return res.status(400).json({ message: "Valid pickup and drop-off coordinates are required." })
  if (typeof pickupAddress !== "string" || typeof dropAddress !== "string" || pickupAddress.length > 300 || dropAddress.length > 300)
    return res.status(400).json({ message: "Invalid location description." })
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      const { order, group, mode } = await eligibleOrder(req.params.orderId, req.user.id, session)
      if (await RiderFundingChoice.exists({ order: order._id }).session(session)) throw conflict("A funding choice already exists.")
      const distanceKm = haversineKm(a, b, c, d)
      const quotedFee = money(calculateDeliveryFee(distanceKm))
      if (!Number.isFinite(quotedFee) || quotedFee <= 0) throw conflict("Invalid delivery fee.")
      if (!Number.isFinite(Number(order.sellerAmount)) || money(order.sellerAmount) < quotedFee)
        throw conflict("Insufficient seller proceeds for the delivery fee.")
      await RiderFundingChoice.create([{ order: order._id, checkoutId: group.id, seller: order.seller,
        fundingSource: "earnings", quotedFee, distanceKm,
        pickupLocation: { lat: a, lng: b, address: pickupAddress.trim() },
        dropLocation: { lat: c, lng: d, address: dropAddress.trim() }, status: "reserved" }], { session })
      result = { orderId: String(order._id), fundingSource: "earnings", deliveryFee: quotedFee,
        sellerEarningsAfterFee: money(order.sellerAmount - quotedFee), status: "reserved",
        environment: mode, simulated: mode === "testing",
        message: mode === "testing" ? "TEST ONLY: simulated rider fee reserved; no funds moved." : "Rider fee reserved from eligible seller proceeds." }
    })
    return res.status(201).json(result)
  } catch (e) {
    return res.status(e.code === 11000 ? 409 : e.status || 500).json({ message: e.status ? e.message : e.code === 11000 ? "Funding choice already exists." : "Unable to reserve rider fee." })
  } finally { await session.endSession() }
})

router.get("/:orderId", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ message: "Invalid order." })
  const choice = await RiderFundingChoice.findOne({ order: req.params.orderId, seller: req.user.id })
    .select("order fundingSource quotedFee distanceKm status createdAt deliveryId").lean()
  return res.json({ choice: choice || null })
})

router.post("/:orderId/dispatch", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ message: "Invalid order." })
  const sellerContact = typeof req.body?.sellerContact === "string" ? req.body.sellerContact.trim() : ""
  const buyerContact = typeof req.body?.buyerContact === "string" ? req.body.buyerContact.trim() : ""
  if (sellerContact.length > 40 || buyerContact.length > 40) return res.status(400).json({ message: "Invalid contact details." })
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      const { order, group, mode } = await eligibleOrder(req.params.orderId, req.user.id, session)
      if (mode === "testing") throw conflict("Simulated orders cannot dispatch real riders; no real rider payout may be created.")
      const funding = await RiderFundingChoice.findOne({ order: order._id, seller: order.seller,
        checkoutId: group.id, fundingSource: "earnings", status: "reserved", deliveryId: null }).session(session)
      if (!funding) throw conflict("A reserved rider fee is required.")
      if (!Number.isFinite(Number(order.sellerAmount)) || money(order.sellerAmount) < money(funding.quotedFee))
        throw conflict("Insufficient eligible seller proceeds.")
      if (await Delivery.exists({ order: order._id, status: { $in: activeStates } }).session(session))
        throw conflict("An active delivery already exists.")
      const [delivery] = await Delivery.create([{ order: order._id, localOrderId: order.localOrderId,
        seller: order.seller, buyer: order.buyer || null, pickupLocation: funding.pickupLocation,
        dropLocation: funding.dropLocation, sellerContact, buyerContact,
        distanceKm: funding.distanceKm, deliveryFee: funding.quotedFee,
        deliveryType: "rider", status: "pending", itemTitle: "Grouped checkout order" }], { session })
      const changed = await RiderFundingChoice.updateOne({ _id: funding._id, status: "reserved", deliveryId: null },
        { $set: { status: "dispatched", deliveryId: delivery._id } }, { session })
      if (changed.modifiedCount !== 1) throw conflict("Funding changed during dispatch.")
      const moved = await Order.updateOne({ _id: order._id, paymentStatus: "escrow_held", fulfillmentStatus: "awaiting_delivery" },
        { $set: { fulfillmentStatus: "delivery_in_progress" } }, { session })
      if (moved.modifiedCount !== 1) throw conflict("Order changed during dispatch.")
      result = { deliveryId: String(delivery._id), orderId: String(order._id), status: "pending",
        deliveryFee: funding.quotedFee, environment: mode, simulated: mode === "testing",
        message: mode === "testing" ? "TEST ONLY: rider job created; no actual payment or payout." : "Rider request posted; payout requires buyer confirmation." }
    })
    return res.status(201).json(result)
  } catch (e) {
    return res.status(e.code === 11000 ? 409 : e.status || 500).json({ message: e.status ? e.message : e.code === 11000 ? "Delivery already exists." : "Dispatch failed; no rider job committed." })
  } finally { await session.endSession() }
})

router.post("/:orderId/cancel-dispatch", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ message: "Invalid order." })
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      const funding = await RiderFundingChoice.findOne({ order: req.params.orderId, seller: req.user.id, status: "dispatched" }).session(session)
      if (!funding?.deliveryId) throw conflict("No cancellable rider request found.")
      const delivery = await Delivery.findOne({ _id: funding.deliveryId, order: funding.order, status: "pending", rider: null }).session(session)
      if (!delivery) throw conflict("Assigned deliveries require supervised cancellation.")
      const order = await Order.findOne({ _id: funding.order, seller: req.user.id,
        paymentStatus: "escrow_held", fulfillmentStatus: "delivery_in_progress" }).session(session)
      if (!order) throw conflict("Order is not eligible for cancellation.")
      if ((await getEnvironmentMode()) !== order.environment) throw conflict("Marketplace environment changed.")
      const changed = await Delivery.updateOne({ _id: delivery._id, status: "pending", rider: null }, { $set: { status: "cancelled" } }, { session })
      if (changed.modifiedCount !== 1) throw conflict("Delivery was accepted during cancellation.")
      const moved = await Order.updateOne({ _id: order._id, fulfillmentStatus: "delivery_in_progress" },
        { $set: { fulfillmentStatus: "awaiting_delivery" } }, { session })
      if (moved.modifiedCount !== 1) throw conflict("Order changed during cancellation.")
      const updated = await RiderFundingChoice.updateOne({ _id: funding._id, status: "dispatched" },
        { $set: { status: "cancelled" } }, { session })
      if (updated.modifiedCount !== 1) throw conflict("Funding changed during cancellation.")
      result = { cancelled: true, orderId: String(order._id), simulated: order.environment === "testing",
        message: "Unassigned rider request cancelled. Rider fee reservation is no longer active." }
    })
    return res.json(result)
  } catch (e) { return res.status(e.status || 500).json({ message: e.status ? e.message : "Unable to cancel rider request." }) }
  finally { await session.endSession() }
})

import Rider from "../models/Rider.js"

// Seller-only rider identity check. Never expose rider identity documents or credentials.
router.get('/:orderId/rider-identity', protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({message:'Invalid order.'})
    const funding = await RiderFundingChoice.findOne({order:req.params.orderId,seller:req.user.id,status:'dispatched'})
    if (!funding?.deliveryId) return res.status(404).json({message:'No active rider assignment.'})
    const delivery = await Delivery.findOne({_id:funding.deliveryId,order:funding.order,seller:req.user.id,status:{$in:['accepted','picked_up','delivered','completed']}})
    if (!delivery?.rider) return res.status(404).json({message:'No assigned rider.'})
    const rider = await Rider.findById(delivery.rider).select('name photoUrl photoReviewStatus isApproved isActive')
    if (!rider) return res.status(404).json({message:'Rider no longer available.'})
    return res.json({deliveryId:String(delivery._id),rider:{id:String(rider._id),name:rider.name,photoUrl:rider.photoReviewStatus==='approved'?rider.photoUrl:null,photoApproved:rider.photoReviewStatus==='approved'&&rider.isApproved&&rider.isActive},status:delivery.status,verified:!!delivery.sellerIdentityVerifiedAt,verificationRequired:delivery.status==='accepted'&&!delivery.sellerIdentityVerifiedAt})
  } catch (e) {return res.status(500).json({message:'Unable to load assigned rider identity.'})}
})

// Seller can reject an assigned rider BEFORE pickup; never release any funds here.
router.post('/:orderId/report-rider-mismatch', protect, async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({message:'Invalid order.'})
  const reason = typeof req.body?.reason==='string' ? req.body.reason.trim() : ''
  if (reason.length<10||reason.length>1000) return res.status(400).json({message:'Describe the mismatch (10–1000 characters).'})
  const session=await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async()=>{
      const funding=await RiderFundingChoice.findOne({order:req.params.orderId,seller:req.user.id,status:'dispatched'}).session(session)
      if (!funding?.deliveryId) throw conflict('No active rider assignment to report.')
      const delivery=await Delivery.findOne({_id:funding.deliveryId,order:funding.order,seller:req.user.id,status:'accepted',rider:{$ne:null}}).session(session)
      if (!delivery) throw conflict('Mismatch cancellation is allowed only before pickup. Contact support if handover occurred.')
      const order=await Order.findOne({_id:funding.order,seller:req.user.id,paymentStatus:'escrow_held',fulfillmentStatus:'delivery_in_progress'}).session(session)
      if (!order) throw conflict('Order is no longer eligible for reassignment.')
      const riderId=delivery.rider
      const updated=await Delivery.updateOne({_id:delivery._id,status:'accepted',rider:riderId},{$set:{status:'cancelled',notes:[delivery.notes||'', '[IDENTITY MISMATCH '+new Date().toISOString()+'] Seller '+String(req.user.id)+': '+reason].filter(Boolean).join('\n').slice(-3000)}} ,{session})
      if(updated.modifiedCount!==1)throw conflict('Rider assignment changed. Refresh and retry.')
      await Rider.updateOne({_id:riderId,activeDelivery:delivery._id},{$set:{activeDelivery:null}},{session})
      const moved=await Order.updateOne({_id:order._id,fulfillmentStatus:'delivery_in_progress'},{$set:{fulfillmentStatus:'awaiting_delivery'}},{session})
      if(moved.modifiedCount!==1)throw conflict('Order changed during cancellation.')
      const reset=await RiderFundingChoice.updateOne({_id:funding._id,status:'dispatched',deliveryId:delivery._id},{$set:{status:'reserved',deliveryId:null}},{session})
      if(reset.modifiedCount!==1)throw conflict('Funding changed during reassignment.')
      result={reported:true,cancelled:true,mayDispatchAgain:true,orderId:String(order._id),message:'Identity mismatch reported. Assignment cancelled before pickup. Rider fee reservation retained for a new dispatch; no payout made.'}
    })
    return res.json(result)
  } catch(e){return res.status(e.status||500).json({message:e.status?e.message:'Unable to report rider mismatch.'})}
  finally{await session.endSession()}
})


// Seller confirms the assigned rider's face before handover. This is not a biometric identity guarantee.
router.post('/:orderId/verify-rider', protect, async(req,res)=>{
 try{
  if(!mongoose.isValidObjectId(req.params.orderId))return res.status(400).json({message:'Invalid order.'})
  const funding=await RiderFundingChoice.findOne({order:req.params.orderId,seller:req.user.id,status:'dispatched'})
  if(!funding?.deliveryId)return res.status(404).json({message:'No active rider assignment.'})
  const delivery=await Delivery.findOne({_id:funding.deliveryId,order:funding.order,seller:req.user.id,status:'accepted',rider:{$ne:null}})
  if(!delivery)return res.status(409).json({message:'Rider assignment is not awaiting handover.'})
  const rider=await Rider.findById(delivery.rider).select('isActive isApproved photoUrl photoReviewStatus')
  if(!rider?.isActive||!rider.isApproved||rider.photoReviewStatus!=='approved'||!rider.photoUrl)return res.status(409).json({message:'Rider has no currently approved photograph. Do not hand over the item.'})
  const order=await Order.findById(delivery.order)
  if(!order||order.environment!==await getEnvironmentMode()||order.paymentStatus!=='escrow_held'||(order.environment==='testing'&&order.isSimulatedPayment!==true))return res.status(409).json({message:'Order is not eligible for rider handover in the current environment.'})
  const changed=await Delivery.updateOne({_id:delivery._id,status:'accepted',rider:rider._id,sellerIdentityVerifiedAt:null},{$set:{sellerIdentityVerifiedAt:new Date(),sellerIdentityVerifiedBy:req.user.id,riderPhotoAtAssignment:rider.photoUrl}})
  if(changed.modifiedCount!==1)return res.status(409).json({message:'Already verified or assignment changed.'})
  return res.json({verified:true,message:'Seller confirmed that the rider matches the approved photograph. Item handover is now permitted.'})
 }catch(e){return res.status(500).json({message:'Unable to record identity verification.'})}
})

export default router

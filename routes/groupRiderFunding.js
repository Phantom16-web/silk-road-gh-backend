import express from "express"
import Delivery from "../models/Delivery.js"
import mongoose from "mongoose"
import protect from "../middleware/auth.js"
import CheckoutGroup from "../models/CheckoutGroup.js"
import Order from "../models/Order.js"
import RiderFundingChoice from "../models/RiderFundingChoice.js"
import { getEnvironmentMode } from "../models/Environment.js"
import { haversineKm, calculateDeliveryFee } from "../utils/distance.js"

const router = express.Router()
const valid = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a)<=90 && Math.abs(b)<=180
const money = n => Math.round(Number(n)*100)/100
const conflict = msg => Object.assign(new Error(msg), { status: 409 })

// Save a seller's rider funding decision. Does NOT create a rider job or transfer money.
router.post("/:orderId/choose", protect, async (req,res) => {
  const { fundingSource, pickupLat, pickupLng, dropLat, dropLng, pickupAddress="", dropAddress="" } = req.body || {}
  const coords = [pickupLat,pickupLng,dropLat,dropLng].map(Number)
  if (!mongoose.isValidObjectId(req.params.orderId) || fundingSource !== "earnings") return res.status(400).json({message:"Rider fees must be funded from eligible seller proceeds. Separate rider payments are not available for new assignments."})
  if (!valid(coords[0],coords[1]) || !valid(coords[2],coords[3])) return res.status(400).json({message:"Valid pickup and drop-off coordinates are required."})
  if (typeof pickupAddress!=="string" || typeof dropAddress!=="string" || pickupAddress.length>300 || dropAddress.length>300) return res.status(400).json({message:"Location details are too long."})
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async()=>{
      const order = await Order.findOne({_id:req.params.orderId,seller:req.user.id,paymentStatus:"escrow_held",environment:"live",cancelled:{$ne:true},fulfillmentStatus:"awaiting_delivery"}).session(session)
      if (!order || await getEnvironmentMode()!=="live") throw conflict("This order is not ready for a rider.")
      const group = await CheckoutGroup.findOne({orderIds:order._id,status:"verified",environment:"live"}).session(session)
      if (!group) throw conflict("A verified grouped checkout is required.")
      if (await RiderFundingChoice.exists({order:order._id}).session(session)) throw conflict("A funding choice already exists for this order.")
      const distanceKm = haversineKm(coords[0],coords[1],coords[2],coords[3])
      const quotedFee = money(calculateDeliveryFee(distanceKm))
      if (!Number.isFinite(quotedFee) || quotedFee<=0) throw conflict("A valid rider fee is unavailable.")
      if (!Number.isFinite(Number(order.sellerAmount)) || money(order.sellerAmount) < quotedFee) throw conflict("Insufficient eligible seller proceeds to cover this rider fee. Select a lower-cost delivery option or fulfill the order yourself.")
      const [record] = await RiderFundingChoice.create([{order:order._id,checkoutId:group.id,seller:order.seller,fundingSource,quotedFee,distanceKm,
        pickupLocation:{lat:coords[0],lng:coords[1],address:pickupAddress.trim()},dropLocation:{lat:coords[2],lng:coords[3],address:dropAddress.trim()},
        status:"reserved"}],{session})
      result={orderId:String(order._id),fundingSource,deliveryFee:quotedFee,status:record.status,
        sellerEarningsAfterFee:money(order.sellerAmount-quotedFee),
        message:"Rider fee reserved from eligible seller proceeds. Rider assignment is not active yet."}
    })
    return res.status(201).json(result)
  }catch(e){return res.status(e.code===11000?409:e.status||500).json({message:e.status?e.message:e.code===11000?"Funding choice already exists.":"Unable to save rider funding choice."})}
  finally{await session.endSession()}
})
router.get("/:orderId",protect,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.orderId))return res.status(400).json({message:"Invalid order."})
  const choice=await RiderFundingChoice.findOne({order:req.params.orderId,seller:req.user.id}).select("order fundingSource quotedFee distanceKm status createdAt").lean()
  return res.json({choice:choice||null})
})
// Dispatch only a fully funded, verified, live grouped order. The existing
// delivery endpoint intentionally continues to reject grouped order creation.
router.post("/:orderId/dispatch", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({message:"Invalid order."})
  const sellerContact = typeof req.body?.sellerContact === "string" ? req.body.sellerContact.trim() : ""
  const buyerContact = typeof req.body?.buyerContact === "string" ? req.body.buyerContact.trim() : ""
  if (sellerContact.length > 40 || buyerContact.length > 40) return res.status(400).json({message:"Invalid contact details."})
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      if (await getEnvironmentMode() !== "live") throw conflict("Rider dispatch is available in live mode only.")
      const order = await Order.findOne({_id:req.params.orderId,seller:req.user.id,paymentStatus:"escrow_held",fulfillmentStatus:"awaiting_delivery",environment:"live",cancelled:{$ne:true}}).session(session)
      if (!order) throw conflict("Order is not eligible for rider dispatch.")
      const group = await CheckoutGroup.findOne({orderIds:order._id,status:"verified",environment:"live"}).session(session)
      if (!group) throw conflict("Checkout payment must be verified first.")
      const funding = await RiderFundingChoice.findOne({order:order._id,seller:order.seller,checkoutId:group.id,status:{$in:["reserved","funded"]}}).session(session)
      if (!funding || funding.fundingSource !== "earnings" || funding.status !== "reserved") throw conflict("A reservation from eligible seller proceeds is required for new rider dispatches.")
      if (!Number.isFinite(Number(order.sellerAmount)) || !Number.isFinite(Number(funding.quotedFee)) || Number(funding.quotedFee) <= 0 || Math.round(Number(order.sellerAmount)*100) < Math.round(Number(funding.quotedFee)*100)) throw conflict("Insufficient eligible seller proceeds for rider fee.")
      const duplicate = await Delivery.exists({order:order._id,status:{$in:["pending","accepted","picked_up","delivered","completed"]}}).session(session)
      if (duplicate || funding.deliveryId) throw conflict("A rider job already exists for this order.")
      const [delivery] = await Delivery.create([{order:order._id,localOrderId:order.localOrderId,seller:order.seller,buyer:order.buyer || null,
        pickupLocation:funding.pickupLocation,dropLocation:funding.dropLocation,
        sellerContact,buyerContact,distanceKm:funding.distanceKm,deliveryFee:funding.quotedFee,
        deliveryType:"rider",status:"pending",itemTitle:"Grouped checkout order"}],{session})
      const changed = await RiderFundingChoice.updateOne({_id:funding._id,status:funding.status,deliveryId:null},{$set:{status:"dispatched",deliveryId:delivery._id}},{session})
      if (changed.modifiedCount !== 1) throw conflict("Funding changed during dispatch.")
      const moved = await Order.updateOne({_id:order._id,paymentStatus:"escrow_held",fulfillmentStatus:"awaiting_delivery"},{$set:{fulfillmentStatus:"delivery_in_progress"}},{session})
      if (moved.modifiedCount !== 1) throw conflict("Order changed during dispatch.")
      result={deliveryId:String(delivery._id),orderId:String(order._id),status:"pending",deliveryFee:funding.quotedFee,message:"Funded rider request posted. Payout requires buyer delivery confirmation."}
    })
    return res.status(201).json(result)
  } catch(e) { return res.status(e.code===11000?409:e.status||500).json({message:e.status?e.message:e.code===11000?"A rider job already exists.":"Dispatch failed; no rider job was committed."}) }
  finally { await session.endSession() }
})
// Seller cancellation is permitted ONLY while the job is unassigned.
// A picked-up or assigned delivery needs supervised reconciliation.
router.post("/:orderId/cancel-dispatch", protect, async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({message:"Invalid order."})
  const session=await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async()=>{
      const funding=await RiderFundingChoice.findOne({order:req.params.orderId,seller:req.user.id,status:"dispatched"}).session(session)
      if (!funding?.deliveryId) throw conflict("No cancellable rider request found.")
      const delivery=await Delivery.findOne({_id:funding.deliveryId,order:funding.order,status:"pending",rider:null}).session(session)
      if (!delivery) throw conflict("A rider has already accepted this job. Contact support for cancellation.")
      const order=await Order.findOne({_id:funding.order,seller:req.user.id,paymentStatus:"escrow_held",fulfillmentStatus:"delivery_in_progress"}).session(session)
      if (!order) throw conflict("Order is not eligible for cancellation.")
      const changed=await Delivery.updateOne({_id:delivery._id,status:"pending",rider:null},{$set:{status:"cancelled"}},{session})
      if(changed.modifiedCount!==1)throw conflict("Delivery was accepted during cancellation.")
      const moved=await Order.updateOne({_id:order._id,fulfillmentStatus:"delivery_in_progress"},{$set:{fulfillmentStatus:"awaiting_delivery"}},{session})
      if(moved.modifiedCount!==1)throw conflict("Order changed during cancellation.")
      const updated=await RiderFundingChoice.updateOne({_id:funding._id,status:"dispatched"},{$set:{status:"cancelled"}},{session})
      if(updated.modifiedCount!==1)throw conflict("Funding changed during cancellation.")
      result={cancelled:true,orderId:String(order._id),fundingSource:funding.fundingSource,
        message:funding.fundingSource==="separate"?"Job cancelled. Separate payment remains held for manual refund/reconciliation; no automatic refund has been issued.":"Job cancelled before assignment. Earnings are no longer reserved for this rider request."}
    })
    return res.json(result)
  }catch(e){return res.status(e.status||500).json({message:e.status?e.message:"Unable to cancel rider request."})}
  finally{await session.endSession()}
})

export default router

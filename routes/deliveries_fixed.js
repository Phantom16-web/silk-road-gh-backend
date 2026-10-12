import express from "express"
import jwt from "jsonwebtoken"
import crypto from "crypto"

import Delivery from "../models/Delivery.js"
import Rider from "../models/Rider.js"
import Order from "../models/Order.js"

import { haversineKm, calculateDeliveryFee } from "../utils/distance.js"

const router = express.Router()
const MAX_OTP_ATTEMPTS = 5
const OTP_TTL_MS = 30 * 60 * 1000

// Authentication helper retained to match the existing rider/customer JWT setup.
function getAnyUserId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    return decoded?.id ? String(decoded.id) : null
  } catch {
    return null
  }
}

function pushTo(req, userId, event, data) {
  try {
    const io = req.app.get("io")
    const sockets = req.app.get("sellerSockets")
    const queueNotif = req.app.get("queueNotification")
    if (!io || !sockets || !userId) return
    const userSockets = sockets.get(String(userId))
    if (!userSockets || userSockets.size === 0) {
      const queueable = ["delivery_accepted", "delivery_picked_up", "delivery_at_door", "delivery_completed", "delivery_cancelled_by_rider", "sale_completed"]
      if (queueNotif && queueable.includes(event)) queueNotif(String(userId), event, data)
      return
    }
    userSockets.forEach((socketId) => io.to(socketId).emit(event, data))
  } catch (err) {
    console.error("pushTo error:", err.message)
  }
}

function isMongoId(value) {
  return Boolean(value && /^[a-f\d]{24}$/i.test(String(value)))
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString()
}

function findOrderForDelivery(delivery) {
  if (delivery.order) return Order.findById(delivery.order)
  if (delivery.localOrderId) return Order.findOne({ localOrderId: delivery.localOrderId })
  return null
}

function isPaymentClearedForDelivery(order) {
  return Boolean(order && order.paymentStatus === "escrow_held")
}

function isOrderAlreadyCompleted(order) {
  return Boolean(order && (order.fulfillmentStatus === "completed" || order.paymentStatus === "released"))
}

function safeDeliveryObject(delivery) {
  const safe = delivery?.toObject ? delivery.toObject() : { ...delivery }
  if (!safe) return safe
  delete safe.otp
  delete safe.otpExpiresAt
  delete safe.otpAttempts
  delete safe.otpLocked
  return safe
}

function safeJobPayload(delivery) {
  // Broadcast only non-sensitive job information. Full addresses and phone numbers
  // are returned only after a rider is assigned and authorized to see the job.
  return {
    _id: String(delivery._id),
    itemTitle: delivery.itemTitle,
    itemImage: delivery.itemImage,
    distanceKm: delivery.distanceKm,
    deliveryFee: delivery.deliveryFee,
    createdAt: delivery.createdAt || new Date(),
  }
}

async function getApprovedRider(riderId) {
  if (!riderId || !isMongoId(riderId)) return null
  return Rider.findOne({ _id: riderId, isApproved: true, isActive: true })
}

function hasDeliveryAccess(delivery, userId) {
  if (!delivery || !userId) return false
  return [delivery.seller, delivery.buyer, delivery.rider]
    .some((id) => id && String(id) === String(userId))
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY QUOTE
// ─────────────────────────────────────────────────────────────────────────────
router.post("/quote", async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body
    const pLat = Number(pickupLat)
    const pLng = Number(pickupLng)
    const dLat = Number(dropLat)
    const dLng = Number(dropLng)
    const validCoords = [pLat, pLng, dLat, dLng].every(Number.isFinite) &&
      pLat >= -90 && pLat <= 90 && dLat >= -90 && dLat <= 90 &&
      pLng >= -180 && pLng <= 180 && dLng >= -180 && dLng <= 180
    if (!validCoords) return res.status(400).json({ message: "Invalid coordinates." })
    const distanceKm = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)
    return res.json({ distanceKm, deliveryFee })
  } catch (err) {
    console.error("Delivery quote error:", err)
    return res.status(500).json({ message: "Unable to calculate delivery quote." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABLE RIDER JOBS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/available", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })

    if (rider.activeDelivery) {
      const active = await Delivery.findById(rider.activeDelivery)
      if (active && !["completed", "cancelled"].includes(active.status)) {
        return res.json({ jobs: [], activeDelivery: String(active._id) })
      }
      await Rider.updateOne({ _id: rider._id, activeDelivery: rider.activeDelivery }, { $set: { activeDelivery: null } })
    }

    const jobs = await Delivery.find({ status: "pending" })
      .select("itemTitle itemImage distanceKm deliveryFee status createdAt")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()
    return res.json({ jobs, activeDelivery: null })
  } catch (err) {
    console.error("Available delivery jobs error:", err)
    return res.status(500).json({ message: "Unable to load available delivery jobs." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RIDER ACTIVE DELIVERY
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my-active", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!rider.activeDelivery) return res.json({ delivery: null })

    const delivery = await Delivery.findOne({ _id: rider.activeDelivery, rider: rider._id })
    if (!delivery || ["completed", "cancelled"].includes(delivery.status)) {
      await Rider.updateOne({ _id: rider._id, activeDelivery: rider.activeDelivery }, { $set: { activeDelivery: null } })
      return res.json({ delivery: null })
    }
    return res.json({ delivery: safeDeliveryObject(delivery) })
  } catch (err) {
    console.error("Active delivery error:", err)
    return res.status(500).json({ message: "Unable to load active delivery." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// BUYER OTP LOOKUP — authenticated buyer only
// ─────────────────────────────────────────────────────────────────────────────
router.get("/otp-for-order/:localOrderId", async (req, res) => {
  try {
    const buyerId = getAnyUserId(req)
    if (!buyerId) return res.status(401).json({ message: "Buyer authentication required." })
    const { localOrderId } = req.params
    const order = await Order.findOne({ localOrderId })
    if (!order) return res.status(404).json({ message: "Order not found." })
    if (!order.buyer || String(order.buyer) !== String(buyerId)) {
      return res.status(403).json({ message: "You are not authorized to view this delivery OTP." })
    }
    const delivery = await Delivery.findOne({ localOrderId, buyer: buyerId, status: "delivered" }).select("otp otpExpiresAt _id itemTitle")
    if (!delivery || !delivery.otp) return res.json({ otp: null })
    if (!delivery.otpExpiresAt || Date.now() > new Date(delivery.otpExpiresAt).getTime()) {
      return res.json({ otp: null, expired: true })
    }
    return res.json({ otp: delivery.otp, expiresAt: delivery.otpExpiresAt, deliveryId: String(delivery._id), itemTitle: delivery.itemTitle })
  } catch (err) {
    console.error("Buyer OTP lookup error:", err)
    return res.status(500).json({ message: "Unable to retrieve delivery OTP." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// FORCE CLEAR — only clears a stale pointer, never an active job
// ─────────────────────────────────────────────────────────────────────────────
router.put("/force-clear", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!rider.activeDelivery) return res.json({ message: "No active delivery to clear.", cleared: null })

    const previous = String(rider.activeDelivery)
    const delivery = await Delivery.findById(previous).select("status rider")
    if (delivery && delivery.rider && String(delivery.rider) === String(rider._id) && !["completed", "cancelled"].includes(delivery.status)) {
      return res.status(409).json({ message: "You cannot clear an active delivery. Complete or cancel the delivery through its normal workflow." })
    }
    const result = await Rider.updateOne({ _id: rider._id, activeDelivery: rider.activeDelivery }, { $set: { activeDelivery: null } })
    if (!result.modifiedCount) return res.status(409).json({ message: "Active delivery changed. Refresh and try again." })
    return res.json({ message: "Stale active-delivery reference cleared.", cleared: previous })
  } catch (err) {
    console.error("Force clear rider error:", err)
    return res.status(500).json({ message: "Unable to clear stale delivery reference." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY BY ORDER — only the buyer, seller, or assigned rider may view it
// ─────────────────────────────────────────────────────────────────────────────
router.get("/by-order/:orderId", async (req, res) => {
  try {
    const userId = getAnyUserId(req)
    if (!userId) return res.status(401).json({ message: "Authentication required." })
    const id = req.params.orderId
    let delivery = isMongoId(id)
      ? await Delivery.findOne({ order: id }).populate("rider", "name phone vehicle rating")
      : await Delivery.findOne({ localOrderId: id }).populate("rider", "name phone vehicle rating")
    if (!delivery) return res.json({ delivery: null })
    if (!hasDeliveryAccess(delivery, userId)) return res.status(403).json({ message: "You are not authorized to view this delivery." })
    return res.json({ delivery: safeDeliveryObject(delivery) })
  } catch (err) {
    console.error("Delivery by order error:", err)
    return res.status(500).json({ message: "Unable to load delivery." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// CREATE DELIVERY JOB — seller must own order and payment must be in escrow
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const sellerId = getAnyUserId(req)
    if (!sellerId) return res.status(401).json({ message: "Not authorized." })
    const { orderId, pickupLat, pickupLng, pickupAddress, dropLat, dropLng, dropAddress, sellerContact, buyerContact, itemTitle, itemImage, notes } = req.body
    const pLat = Number(pickupLat)
    const pLng = Number(pickupLng)
    const dLat = Number(dropLat)
    const dLng = Number(dropLng)
    const validCoords = [pLat, pLng, dLat, dLng].every(Number.isFinite) &&
      pLat >= -90 && pLat <= 90 && dLat >= -90 && dLat <= 90 &&
      pLng >= -180 && pLng <= 180 && dLng >= -180 && dLng <= 180
    if (!validCoords) return res.status(400).json({ message: "Invalid coordinates." })
    if (!orderId || (!isMongoId(orderId) && String(orderId).length > 200)) return res.status(400).json({ message: "A valid order ID is required." })

    const order = isMongoId(orderId) ? await Order.findById(orderId) : await Order.findOne({ localOrderId: String(orderId) })
    if (!order) return res.status(404).json({ message: "Order not found." })
    if (!order.seller || String(order.seller) !== String(sellerId)) return res.status(403).json({ message: "You are not authorized to create delivery for this order." })
    if (!isPaymentClearedForDelivery(order)) return res.status(400).json({ message: "Payment must be verified and held in Silk Road escrow before delivery can begin." })
    if (order.cancelled || ["cancelled", "disputed"].includes(order.fulfillmentStatus)) return res.status(400).json({ message: "This order cannot enter delivery." })
    if (isOrderAlreadyCompleted(order)) return res.status(400).json({ message: "This order has already been completed." })

    const existing = await Delivery.findOne({ order: order._id, status: { $in: ["pending", "accepted", "picked_up", "delivered"] } })
    if (existing) return res.status(409).json({ message: "An active delivery already exists for this order.", delivery: safeDeliveryObject(existing) })

    const distanceKm = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)
    const delivery = await Delivery.create({
      order: order._id,
      localOrderId: order.localOrderId || null,
      seller: sellerId,
      buyer: order.buyer || null,
      rider: null,
      pickupLocation: { lat: pLat, lng: pLng, address: typeof pickupAddress === "string" ? pickupAddress.slice(0, 500) : `${pLat},${pLng}` },
      dropLocation: { lat: dLat, lng: dLng, address: typeof dropAddress === "string" ? dropAddress.slice(0, 500) : `${dLat},${dLng}` },
      sellerContact: typeof sellerContact === "string" ? sellerContact.slice(0, 40) : "",
      buyerContact: typeof buyerContact === "string" ? buyerContact.slice(0, 40) : (order.payerPhone || ""),
      distanceKm,
      deliveryFee,
      itemTitle: typeof itemTitle === "string" ? itemTitle.slice(0, 200) : "Package",
      itemImage: typeof itemImage === "string" ? itemImage.slice(0, 2000) : "",
      notes: typeof notes === "string" ? notes.slice(0, 1000) : "",
      status: "pending",
    })

    // Do not overwrite a terminal or changed order state after creating the job.
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: "escrow_held", fulfillmentStatus: { $nin: ["completed", "cancelled", "disputed"] }, cancelled: { $ne: true } },
      { $set: { fulfillmentStatus: "awaiting_delivery" } },
      { new: true }
    )
    if (!updatedOrder) {
      await Delivery.deleteOne({ _id: delivery._id, status: "pending" })
      return res.status(409).json({ message: "Order state changed. Refresh the order and try again." })
    }

    const io = req.app.get("io")
    if (io) io.emit("new_delivery_job", safeJobPayload(delivery))
    return res.status(201).json({ delivery: safeDeliveryObject(delivery), distanceKm, deliveryFee })
  } catch (err) {
    console.error("Create delivery error:", err)
    return res.status(500).json({ message: "Unable to create delivery." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RIDER ACCEPT — atomically claims job and enforces one active job per rider
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/accept", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!isMongoId(req.params.id)) return res.status(400).json({ message: "Invalid delivery ID." })

    if (rider.activeDelivery) {
      const active = await Delivery.findById(rider.activeDelivery).select("status")
      if (active && !["completed", "cancelled"].includes(active.status)) return res.status(409).json({ message: "You already have an active delivery." })
      await Rider.updateOne({ _id: rider._id, activeDelivery: rider.activeDelivery }, { $set: { activeDelivery: null } })
    }

    const candidate = await Delivery.findOne({ _id: req.params.id, status: "pending" })
    if (!candidate) return res.status(409).json({ message: "Job is no longer available." })
    const order = await findOrderForDelivery(candidate)
    if (!order) return res.status(409).json({ message: "Associated order not found." })
    if (!isPaymentClearedForDelivery(order) || order.cancelled || isOrderAlreadyCompleted(order) || ["cancelled", "disputed"].includes(order.fulfillmentStatus)) {
      return res.status(409).json({ message: "This order is no longer available for delivery." })
    }

    const claimed = await Delivery.findOneAndUpdate(
      { _id: candidate._id, status: "pending", rider: null },
      { $set: { rider: rider._id, status: "accepted", acceptedAt: new Date() } },
      { new: true }
    )
    if (!claimed) return res.status(409).json({ message: "Another rider has already accepted this job." })

    const riderClaim = await Rider.updateOne(
      { _id: rider._id, isApproved: true, isActive: true, $or: [{ activeDelivery: null }, { activeDelivery: { $exists: false } }] },
      { $set: { activeDelivery: claimed._id } }
    )
    if (!riderClaim.modifiedCount) {
      await Delivery.updateOne({ _id: claimed._id, rider: rider._id, status: "accepted" }, { $set: { rider: null, status: "pending", acceptedAt: null } })
      return res.status(409).json({ message: "You already have an active delivery. Refresh and try again." })
    }

    pushTo(req, String(claimed.seller), "delivery_accepted", { deliveryId: String(claimed._id), riderName: rider.name, message: `${rider.name} accepted and is heading to pick up.` })
    return res.json({ delivery: safeDeliveryObject(claimed) })
  } catch (err) {
    console.error("Accept delivery error:", err)
    return res.status(500).json({ message: "Unable to accept delivery." })
  }
})

// Declining is intentionally a no-op for compatibility; the job remains available.
router.put("/:id/decline", async (req, res) => {
  const riderId = getAnyUserId(req)
  if (!riderId) return res.status(401).json({ message: "Not authorized." })
  const rider = await getApprovedRider(riderId)
  if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
  return res.json({ message: "Declined. The job remains available." })
})

// ─────────────────────────────────────────────────────────────────────────────
// RIDER CANCEL — only assigned rider; delivery is returned to pending
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/cancel-by-rider", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!isMongoId(req.params.id)) return res.status(400).json({ message: "Invalid delivery ID." })
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status === "completed") return res.status(400).json({ message: "Already completed." })
    if (delivery.status === "delivered") return res.status(400).json({ message: "Package marked delivered. Obtain buyer OTP or contact support." })
    if (!["accepted", "picked_up"].includes(delivery.status)) return res.status(400).json({ message: `Delivery cannot be cancelled from status "${delivery.status}".` })

    const released = await Delivery.findOneAndUpdate(
      { _id: delivery._id, rider: rider._id, status: delivery.status },
      { $set: { rider: null, status: "pending", acceptedAt: null, pickedUpAt: null } },
      { new: true }
    )
    if (!released) return res.status(409).json({ message: "Delivery changed while cancelling. Refresh and try again." })
    await Rider.updateOne({ _id: rider._id, activeDelivery: delivery._id }, { $set: { activeDelivery: null } })
    pushTo(req, String(delivery.seller), "delivery_cancelled_by_rider", { deliveryId: String(delivery._id), message: "Rider cancelled. Job is back on the board." })
    const io = req.app.get("io")
    if (io) io.emit("new_delivery_job", safeJobPayload(released))
    return res.json({ message: "Cancelled.", delivery: safeDeliveryObject(released) })
  } catch (err) {
    console.error("Rider cancellation error:", err)
    return res.status(500).json({ message: "Unable to cancel delivery." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// PICKED UP
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/picked-up", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!isMongoId(req.params.id)) return res.status(400).json({ message: "Invalid delivery ID." })

    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: rider._id, status: "accepted" },
      { $set: { status: "picked_up", pickedUpAt: new Date() } },
      { new: true }
    )
    if (!delivery) return res.status(409).json({ message: "Delivery is not assigned to you or is no longer in accepted status." })
    const order = await findOrderForDelivery(delivery)
    if (!order || !isPaymentClearedForDelivery(order)) {
      await Delivery.updateOne({ _id: delivery._id, rider: rider._id, status: "picked_up" }, { $set: { status: "accepted", pickedUpAt: null } })
      return res.status(409).json({ message: "Associated order is not financially cleared for delivery." })
    }
    const orderUpdate = await Order.updateOne(
      { _id: order._id, paymentStatus: "escrow_held", fulfillmentStatus: { $nin: ["completed", "cancelled", "disputed"] } },
      { $set: { fulfillmentStatus: "delivery_in_progress" } }
    )
    if (!orderUpdate.modifiedCount) {
      await Delivery.updateOne({ _id: delivery._id, rider: rider._id, status: "picked_up" }, { $set: { status: "accepted", pickedUpAt: null } })
      return res.status(409).json({ message: "Order state changed. Delivery pickup was not recorded." })
    }
    pushTo(req, String(delivery.seller), "delivery_picked_up", { deliveryId: String(delivery._id), message: "Package picked up, heading to buyer." })
    return res.json({ delivery: safeDeliveryObject(delivery) })
  } catch (err) {
    console.error("Picked-up error:", err)
    return res.status(500).json({ message: "Unable to update pickup status." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RIDER MARKS ARRIVED / DELIVERED — generates OTP; does not release funds
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/delivered", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!isMongoId(req.params.id)) return res.status(400).json({ message: "Invalid delivery ID." })
    const orderCandidateDelivery = await Delivery.findOne({ _id: req.params.id, rider: rider._id, status: "picked_up" })
    if (!orderCandidateDelivery) return res.status(409).json({ message: "Delivery is not assigned to you or is not picked up." })
    const order = await findOrderForDelivery(orderCandidateDelivery)
    if (!order || !isPaymentClearedForDelivery(order) || order.cancelled || isOrderAlreadyCompleted(order)) {
      return res.status(409).json({ message: "This order is not currently eligible for delivery confirmation." })
    }
    const otp = generateOtp()
    const now = new Date()
    const delivery = await Delivery.findOneAndUpdate(
      { _id: orderCandidateDelivery._id, rider: rider._id, status: "picked_up" },
      { $set: { otp, otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS), otpAttempts: 0, otpLocked: false, status: "delivered", deliveredAt: now } },
      { new: true }
    )
    if (!delivery) return res.status(409).json({ message: "Delivery state changed. Refresh and try again." })
    const orderUpdate = await Order.updateOne(
      { _id: order._id, paymentStatus: "escrow_held", fulfillmentStatus: { $nin: ["completed", "cancelled", "disputed"] }, cancelled: { $ne: true } },
      { $set: { fulfillmentStatus: "delivered_pending_otp" } }
    )
    if (!orderUpdate.modifiedCount) {
      // Roll back the delivery transition if the order can no longer proceed.
      await Delivery.updateOne({ _id: delivery._id, rider: rider._id, status: "delivered", otp }, { $set: { status: "picked_up", deliveredAt: null, otp: null, otpExpiresAt: null, otpAttempts: 0, otpLocked: false } })
      return res.status(409).json({ message: "Order state changed. Delivery confirmation was not recorded." })
    }

    pushTo(req, String(delivery.seller), "delivery_at_door", { deliveryId: String(delivery._id), message: "Package delivered. Waiting for buyer OTP confirmation." })
    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_otp_ready", { deliveryId: String(delivery._id), localOrderId: delivery.localOrderId, itemTitle: delivery.itemTitle, expiresAt: delivery.otpExpiresAt, otp })
    }
    return res.json({ delivery: safeDeliveryObject(delivery), localOrderId: delivery.localOrderId, message: "Delivery marked at door. Buyer OTP is now required." })
  } catch (err) {
    console.error("Delivered error:", err)
    return res.status(500).json({ message: "Unable to mark delivery as delivered." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM OTP — limited attempts; completion moves escrow to release_pending only
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/confirm-otp", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await getApprovedRider(riderId)
    if (!rider) return res.status(403).json({ message: "An approved, active rider account is required." })
    if (!isMongoId(req.params.id)) return res.status(400).json({ message: "Invalid delivery ID." })
    if (typeof req.body?.otp !== "string" && typeof req.body?.otp !== "number") return res.status(400).json({ message: "A six-digit OTP is required." })
    const suppliedOtp = String(req.body.otp).trim()
    if (!/^\d{6}$/.test(suppliedOtp)) return res.status(400).json({ message: "A six-digit OTP is required." })

    // Reserve an attempt atomically so parallel guesses cannot bypass the limit.
    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: rider._id, status: "delivered", otpLocked: { $ne: true }, otpAttempts: { $lt: MAX_OTP_ATTEMPTS }, otp: { $ne: null }, otpExpiresAt: { $gt: new Date() } },
      { $inc: { otpAttempts: 1 } },
      { new: true }
    )
    if (!delivery) {
      const current = await Delivery.findById(req.params.id).select("rider status otpLocked otpAttempts otpExpiresAt otp")
      if (!current) return res.status(404).json({ message: "Delivery not found." })
      if (String(current.rider) !== String(rider._id)) return res.status(403).json({ message: "Not your delivery." })
      if (current.status === "completed") return res.status(409).json({ message: "This delivery has already been completed." })
      if (current.status !== "delivered") return res.status(409).json({ message: "Delivery must first be marked delivered." })
      if (current.otpLocked || Number(current.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) return res.status(429).json({ message: "OTP attempts exceeded. Contact Silk Road support." })
      if (!current.otp || !current.otpExpiresAt || new Date(current.otpExpiresAt) <= new Date()) return res.status(400).json({ message: "OTP is missing or expired." })
      return res.status(409).json({ message: "OTP state changed. Please try again." })
    }

    const storedOtp = String(delivery.otp)
    const valid = Buffer.byteLength(suppliedOtp) === Buffer.byteLength(storedOtp) && crypto.timingSafeEqual(Buffer.from(suppliedOtp), Buffer.from(storedOtp))
    if (!valid) {
      const attempts = Number(delivery.otpAttempts || 0)
      if (attempts >= MAX_OTP_ATTEMPTS) await Delivery.updateOne({ _id: delivery._id, status: "delivered" }, { $set: { otpLocked: true } })
      return res.status(attempts >= MAX_OTP_ATTEMPTS ? 429 : 400).json({ message: attempts >= MAX_OTP_ATTEMPTS ? "OTP attempts exceeded. Contact Silk Road support." : "Incorrect OTP.", attemptsRemaining: Math.max(0, MAX_OTP_ATTEMPTS - attempts) })
    }

    const order = await findOrderForDelivery(delivery)
    if (!order) return res.status(409).json({ message: "Associated order not found." })
    if (order.paymentStatus !== "escrow_held" || order.cancelled || ["cancelled", "disputed"].includes(order.fulfillmentStatus)) {
      return res.status(409).json({ message: "The order is not in a valid escrow state." })
    }
    if (order.fulfillmentStatus === "completed" || order.paymentStatus === "released") return res.status(409).json({ message: "This order has already been completed." })

    // First atomically claim the delivery completion. A second concurrent OTP
    // request cannot also pass this status predicate.
    const completedDelivery = await Delivery.findOneAndUpdate(
      { _id: delivery._id, rider: rider._id, status: "delivered", otpLocked: { $ne: true }, otp: storedOtp, otpExpiresAt: { $gt: new Date() } },
      { $set: { status: "completed", otpVerified: true, completedAt: new Date(), otp: null, otpExpiresAt: null } },
      { new: true }
    )
    if (!completedDelivery) return res.status(409).json({ message: "OTP or delivery state changed. Refresh and try again." })

    const orderUpdate = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: "escrow_held", fulfillmentStatus: "delivered_pending_otp", cancelled: { $ne: true } },
      { $set: { fulfillmentStatus: "completed", completedAt: new Date(), paymentStatus: "release_pending", status: "Completed" } },
      { new: true }
    )
    if (!orderUpdate) {
      // Restore a retryable state if the order transition lost a race. The OTP
      // is not restored; a new OTP must be issued by the normal delivery flow.
      await Delivery.updateOne({ _id: completedDelivery._id, status: "completed", otpVerified: true }, { $set: { status: "delivered", otpVerified: false, completedAt: null, otp: null, otpExpiresAt: null, otpLocked: true } })
      return res.status(409).json({ message: "Order state changed. Contact Silk Road support before retrying." })
    }

    await Rider.updateOne({ _id: rider._id, activeDelivery: completedDelivery._id }, { $set: { activeDelivery: null } })
    const orderAmount = Number(orderUpdate.amount || 0)
    const platformFee = Number(orderUpdate.platformFee ?? Math.round(orderAmount * 0.08))
    const sellerAmount = Number(orderUpdate.sellerAmount ?? (orderAmount - platformFee))

    pushTo(req, String(orderUpdate.seller), "sale_completed", {
      deliveryId: String(completedDelivery._id), localOrderId: orderUpdate.localOrderId,
      itemTitle: completedDelivery.itemTitle, deliveryFee: completedDelivery.deliveryFee,
      orderAmount, platformFee, sellerAmount, paymentStatus: "release_pending",
      message: "Delivery confirmed. Seller funds are pending release.",
    })
    pushTo(req, String(orderUpdate.seller), "delivery_completed", {
      deliveryId: String(completedDelivery._id), deliveryFee: completedDelivery.deliveryFee,
      orderAmount, sellerAmount, paymentStatus: "release_pending", message: "Delivery confirmed via OTP.",
    })
    if (orderUpdate.buyer) pushTo(req, String(orderUpdate.buyer), "delivery_completed", {
      deliveryId: String(completedDelivery._id), localOrderId: orderUpdate.localOrderId,
      itemTitle: completedDelivery.itemTitle, orderAmount, paymentStatus: "release_pending",
      message: "Delivery confirmed successfully.",
    })

    return res.json({ delivery: safeDeliveryObject(completedDelivery), order: orderUpdate, message: "Delivery confirmed. The order is complete and funds are pending release." })
  } catch (err) {
    console.error("confirm-otp error:", err)
    return res.status(500).json({ message: "Unable to confirm delivery OTP." })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET DELIVERY — must remain last; only involved parties may access it
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const userId = getAnyUserId(req)
    if (!userId) return res.status(401).json({ message: "Authentication required." })
    if (!isMongoId(req.params.id)) return res.status(400).json({ message: "Invalid delivery ID." })
    const delivery = await Delivery.findById(req.params.id)
      .populate("rider", "name phone vehicle rating")
      .populate("seller", "name phone")
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (!hasDeliveryAccess(delivery, userId)) return res.status(403).json({ message: "You are not authorized to view this delivery." })
    return res.json(safeDeliveryObject(delivery))
  } catch (err) {
    console.error("Get delivery error:", err)
    return res.status(500).json({ message: "Unable to load delivery." })
  }
})

export default router

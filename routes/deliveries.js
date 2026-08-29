import express  from "express"
import jwt      from "jsonwebtoken"
import crypto   from "crypto"
import Delivery from "../models/Delivery.js"
import Rider    from "../models/Rider.js"
import Order    from "../models/Order.js"
import { haversineKm, calculateDeliveryFee } from "../utils/distance.js"

const router = express.Router()

function getAnyUserId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
    return decoded.id || null
  } catch { return null }
}

function pushTo(req, userId, event, data) {
  try {
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (!io || !sellerSockets || !userId) return
    const sockets = sellerSockets.get(String(userId))
    if (!sockets || sockets.size === 0) return
    sockets.forEach(socketId => io.to(socketId).emit(event, data))
  } catch (err) {
    console.error("pushTo error:", err.message)
  }
}

function isMongoId(str) {
  return str && /^[a-f\d]{24}$/i.test(String(str))
}

// ─── NAMED ROUTES FIRST (before /:id) ────────────────────────────────────────

// POST /api/deliveries/quote
router.post("/quote", async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body
    const pLat = Number(pickupLat), pLng = Number(pickupLng)
    const dLat = Number(dropLat),   dLng = Number(dropLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng))
      return res.status(400).json({ message: "Invalid coordinates." })
    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)
    res.json({ distanceKm, deliveryFee })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// GET /api/deliveries/available
router.get("/available", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    if (rider.activeDelivery) {
      const active = await Delivery.findById(rider.activeDelivery)
      if (!active || active.status === "completed" || active.status === "cancelled") {
        rider.activeDelivery = null
        await rider.save()
      } else {
        return res.json({ jobs: [], activeDelivery: rider.activeDelivery })
      }
    }
    const jobs = await Delivery.find({ status: "pending" }).sort({ createdAt: -1 }).limit(20)
    res.json({ jobs, activeDelivery: null })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// GET /api/deliveries/my-active
router.get("/my-active", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    if (!rider.activeDelivery) return res.json({ delivery: null })
    const delivery = await Delivery.findById(rider.activeDelivery)
    if (!delivery || delivery.status === "completed" || delivery.status === "cancelled") {
      rider.activeDelivery = null
      await rider.save()
      return res.json({ delivery: null })
    }
    res.json({ delivery })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// GET /api/deliveries/otp-for-order/:localOrderId — PUBLIC, buyer polls this
router.get("/otp-for-order/:localOrderId", async (req, res) => {
  try {
    const { localOrderId } = req.params
    if (!localOrderId) return res.json({ otp: null })

    // Primary: match by SR-XXXXX localOrderId
    let delivery = await Delivery.findOne({
      localOrderId,
      status: "delivered",
      otp:    { $exists: true, $ne: null },
    })

    // Fallback 1: MongoDB _id reference
    if (!delivery && isMongoId(localOrderId)) {
      delivery = await Delivery.findOne({
        order:  localOrderId,
        status: "delivered",
        otp:    { $exists: true, $ne: null },
      })
    }

    // Fallback 2: most recent delivered OTP in last 2 hours
    if (!delivery) {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      delivery = await Delivery.findOne({
        status:      "delivered",
        otp:         { $exists: true, $ne: null },
        deliveredAt: { $gte: twoHoursAgo },
      }).sort({ deliveredAt: -1 })
    }

    if (!delivery || !delivery.otp) return res.json({ otp: null })
    if (new Date() > delivery.otpExpiresAt)
      return res.json({ otp: null, expired: true })

    res.json({
      otp:        delivery.otp,
      expiresAt:  delivery.otpExpiresAt,
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
    })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// PUT /api/deliveries/force-clear
router.put("/force-clear", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    const prev = rider.activeDelivery
    rider.activeDelivery = null
    await rider.save()
    res.json({ message: "Cleared.", cleared: prev ? String(prev) : null })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// GET /api/deliveries/by-order/:orderId
router.get("/by-order/:orderId", async (req, res) => {
  try {
    const id = req.params.orderId
    const delivery = isMongoId(id)
      ? await Delivery.findOne({ order: id }).populate("rider", "name phone vehicle")
      : await Delivery.findOne({ localOrderId: id }).populate("rider", "name phone vehicle")
    res.json({ delivery: delivery || null })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// POST /api/deliveries — seller creates delivery job
router.post("/", async (req, res) => {
  try {
    const {
      orderId,
      pickupLat, pickupLng, pickupAddress,
      dropLat, dropLng, dropAddress,
      sellerContact, buyerContact, itemTitle, itemImage, notes,
    } = req.body

    const sellerId = getAnyUserId(req)
    if (!sellerId) return res.status(401).json({ message: "Not authorized." })

    const pLat = Number(pickupLat), pLng = Number(pickupLng)
    const dLat = Number(dropLat),   dLng = Number(dropLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng))
      return res.status(400).json({ message: "Invalid coordinates." })

    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)

    const mongoOrderId = isMongoId(orderId) ? orderId : null
    const localOrderId = req.body.localOrderId
      || (!isMongoId(orderId) && orderId ? String(orderId) : null)

    console.log(`📦 Creating delivery | orderId: ${orderId} | localOrderId: ${localOrderId}`)

    const delivery = await Delivery.create({
      order:          mongoOrderId,
      localOrderId,
      seller:         sellerId,
      buyer:          null,
      rider:          null,
      pickupLocation: { lat: pLat, lng: pLng, address: pickupAddress || `${pLat},${pLng}` },
      dropLocation:   { lat: dLat, lng: dLng, address: dropAddress   || `${dLat},${dLng}` },
      sellerContact:  sellerContact || "",
      buyerContact:   buyerContact  || "",
      distanceKm,
      deliveryFee,
      itemTitle:      itemTitle || "Package",
      itemImage:      itemImage || "",
      notes:          notes     || "",
      status:         "pending",
    })

    const io = req.app.get("io")
    if (io) {
      io.emit("new_delivery_job", {
        _id:            delivery._id.toString(),
        itemTitle:      itemTitle  || "Package",
        itemImage:      itemImage  || null,
        pickupAddress:  pickupAddress || `${pLat},${pLng}`,
        dropAddress:    dropAddress   || `${dLat},${dLng}`,
        pickupLocation: { lat: pLat, lng: pLng },
        dropLocation:   { lat: dLat, lng: dLng },
        distanceKm,
        deliveryFee,
        sellerContact:  sellerContact || "",
        buyerContact:   buyerContact  || "",
        createdAt:      Date.now(),
      })
    }

    console.log(`✅ Delivery ${delivery._id} | localOrderId: ${localOrderId}`)
    res.status(201).json({ delivery, distanceKm, deliveryFee })
  } catch (err) {
    console.error("Create delivery error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// ─── /:id ROUTES BELOW ────────────────────────────────────────────────────────

// PUT /api/deliveries/:id/accept
router.put("/:id/accept", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    if (rider.activeDelivery) {
      const active = await Delivery.findById(rider.activeDelivery)
      if (!active || active.status === "completed" || active.status === "cancelled") {
        rider.activeDelivery = null
        await rider.save()
      } else {
        return res.status(400).json({ message: "You already have an active delivery." })
      }
    }
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (delivery.status !== "pending") return res.status(400).json({ message: "Job already taken." })
    delivery.rider      = riderId
    delivery.status     = "accepted"
    delivery.acceptedAt = new Date()
    await delivery.save()
    rider.activeDelivery = delivery._id
    await rider.save()
    pushTo(req, String(delivery.seller), "delivery_accepted", {
      deliveryId: delivery._id.toString(),
      riderName:  rider.name,
      message:    `${rider.name} accepted and is heading to pick up.`,
    })
    res.json({ delivery })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// PUT /api/deliveries/:id/decline
router.put("/:id/decline", async (req, res) => {
  try {
    res.json({ message: "Declined." })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// PUT /api/deliveries/:id/cancel-by-rider
router.put("/:id/cancel-by-rider", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status === "completed") return res.status(400).json({ message: "Already completed." })
    if (delivery.status === "delivered") return res.status(400).json({ message: "Package delivered. Get OTP from buyer." })
    delivery.rider      = null
    delivery.status     = "pending"
    delivery.acceptedAt = null
    delivery.pickedUpAt = null
    await delivery.save()
    await Rider.findByIdAndUpdate(riderId, { activeDelivery: null })
    pushTo(req, String(delivery.seller), "delivery_cancelled_by_rider", {
      deliveryId: delivery._id.toString(),
      message:    "Rider cancelled. Job is back on the board.",
    })
    const io = req.app.get("io")
    if (io) {
      io.emit("new_delivery_job", {
        _id:            delivery._id.toString(),
        itemTitle:      delivery.itemTitle,
        itemImage:      delivery.itemImage,
        pickupAddress:  delivery.pickupLocation?.address,
        dropAddress:    delivery.dropLocation?.address,
        pickupLocation: delivery.pickupLocation,
        dropLocation:   delivery.dropLocation,
        distanceKm:     delivery.distanceKm,
        deliveryFee:    delivery.deliveryFee,
        sellerContact:  delivery.sellerContact,
        buyerContact:   delivery.buyerContact,
        createdAt:      Date.now(),
      })
    }
    res.json({ message: "Cancelled.", delivery })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// PUT /api/deliveries/:id/picked-up
router.put("/:id/picked-up", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status !== "accepted") return res.status(400).json({ message: `Status is ${delivery.status}.` })
    delivery.status     = "picked_up"
    delivery.pickedUpAt = new Date()
    await delivery.save()
    pushTo(req, String(delivery.seller), "delivery_picked_up", {
      deliveryId: delivery._id.toString(),
      message:    "Package picked up, heading to buyer.",
    })
    res.json({ delivery })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// PUT /api/deliveries/:id/delivered
// Rider taps "I've Delivered" → backend generates OTP → stores on delivery
// OTP broadcast on a localOrderId-specific channel so ONLY that buyer gets it
// Seller is notified WITHOUT the OTP — seller has no business seeing the OTP
router.put("/:id/delivered", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status !== "picked_up") return res.status(400).json({ message: `Status is ${delivery.status}, must be picked_up.` })

    // Generate OTP — stored on delivery, never sent to seller
    const otp             = crypto.randomInt(100000, 999999).toString()
    delivery.otp          = otp
    delivery.otpExpiresAt = new Date(Date.now() + 30 * 60 * 1000)
    delivery.status       = "delivered"
    delivery.deliveredAt  = new Date()
    await delivery.save()

    console.log(`📦 OTP generated | delivery: ${delivery._id} | localOrderId: ${delivery.localOrderId} | otp: ${otp}`)

    const io = req.app.get("io")

    // ── Broadcast OTP on the order-specific channel ───────────────────────────
    // Any client (guest or logged-in) subscribed to this localOrderId gets it
    // Checkout.jsx and OrderTracker listen for "otp:SR-XXXXX" room event
    if (io && delivery.localOrderId) {
      io.emit(`otp:${delivery.localOrderId}`, {
        otp,
        deliveryId:   delivery._id.toString(),
        localOrderId: delivery.localOrderId,
        expiresAt:    delivery.otpExpiresAt,
        itemTitle:    delivery.itemTitle,
      })
    }

    // ── Notify seller WITHOUT OTP — they only need to know it's at the door ──
    pushTo(req, String(delivery.seller), "delivery_at_door", {
      deliveryId: delivery._id.toString(),
      message:    "Package delivered. Waiting for buyer OTP confirmation.",
      // NO otp field here — seller never sees the OTP
    })

    res.json({ delivery, localOrderId: delivery.localOrderId })
  } catch (err) {
    console.error("Delivered error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// PUT /api/deliveries/:id/confirm-otp
router.put("/:id/confirm-otp", async (req, res) => {
  try {
    const riderId = getAnyUserId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const { otp } = req.body
    if (!otp) return res.status(400).json({ message: "OTP required." })
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status !== "delivered") return res.status(400).json({ message: "Mark as delivered first." })
    if (String(delivery.otp) !== String(otp).trim()) return res.status(400).json({ message: "Incorrect OTP." })
    if (new Date() > delivery.otpExpiresAt) return res.status(400).json({ message: "OTP expired." })

    delivery.status      = "completed"
    delivery.otpVerified = true
    delivery.completedAt = new Date()
    await delivery.save()

    const rider = await Rider.findById(riderId)
    if (rider) {
      rider.totalDeliveries += 1
      rider.totalEarned     += delivery.deliveryFee
      rider.activeDelivery   = null
      await rider.save()
    }

    if (delivery.order) {
      try { await Order.findByIdAndUpdate(delivery.order, { status: "Completed" }) } catch {}
    }

    pushTo(req, String(delivery.seller), "delivery_completed", {
      deliveryId:  delivery._id.toString(),
      deliveryFee: delivery.deliveryFee,
      message:     "Delivery confirmed via OTP. Payment released.",
    })

    console.log(`✅ Delivery ${delivery._id} completed | ₵${delivery.deliveryFee}`)
    res.json({ delivery, message: "Delivery complete." })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// GET /api/deliveries/:id — MUST BE LAST
router.get("/:id", async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id)
      .populate("rider",  "name phone vehicle rating")
      .populate("seller", "name phone")
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    res.json(delivery)
  } catch (err) { res.status(500).json({ message: err.message }) }
})

export default router

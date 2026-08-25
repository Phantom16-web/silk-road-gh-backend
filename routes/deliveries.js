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

const getUserId  = getAnyUserId
const getRiderId = getAnyUserId

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

// ─── NAMED ROUTES FIRST — before /:id ────────────────────────────────────────

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
    const riderId = getRiderId(req)
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
    const riderId = getRiderId(req)
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

// GET /api/deliveries/otp-for-order/:localOrderId  ← PUBLIC, buyer polls this
router.get("/otp-for-order/:localOrderId", async (req, res) => {
  try {
    const { localOrderId } = req.params
    if (!localOrderId) return res.status(400).json({ otp: null })

    // Find delivery where rider has marked as delivered
    const delivery = await Delivery.findOne({
      localOrderId,
      status: "delivered",
      otp:    { $exists: true, $ne: null },
    })

    if (!delivery)        return res.json({ otp: null })
    if (!delivery.otp)    return res.json({ otp: null })
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
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    const prev = rider.activeDelivery
    rider.activeDelivery = null
    await rider.save()
    console.log(`🧹 Force-cleared for rider ${riderId} (was: ${prev})`)
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

// POST /api/deliveries  ← seller creates delivery job
router.post("/", async (req, res) => {
  try {
    const {
      orderId, pickupLat, pickupLng, pickupAddress,
      dropLat, dropLng, dropAddress,
      sellerContact, buyerContact, itemTitle, itemImage, notes,
    } = req.body

    const sellerId = getUserId(req)
    if (!sellerId) return res.status(401).json({ message: "Not authorized." })

    const pLat = Number(pickupLat), pLng = Number(pickupLng)
    const dLat = Number(dropLat),   dLng = Number(dropLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng))
      return res.status(400).json({ message: "Invalid coordinates." })

    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)

    const mongoOrderId = isMongoId(orderId) ? orderId : null
    const localOrderId = !isMongoId(orderId) && orderId ? String(orderId) : null

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

    console.log(`✅ Delivery ${delivery._id} | localOrder: ${localOrderId}`)
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
    const riderId = getRiderId(req)
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
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    res.json({ message: "Declined." })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// PUT /api/deliveries/:id/cancel-by-rider
router.put("/:id/cancel-by-rider", async (req, res) => {
  try {
    const riderId = getRiderId(req)
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
    const riderId = getRiderId(req)
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
// ── Rider taps "I've Delivered" → backend generates OTP → stores on delivery
// ── Buyer side polls GET /otp-for-order/:localOrderId every 5s to get it
router.put("/:id/delivered", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status !== "picked_up") return res.status(400).json({ message: `Status is ${delivery.status}, must be picked_up.` })

    // ── Generate OTP and store it ──────────────────────────────────────────
    const otp             = crypto.randomInt(100000, 999999).toString()
    delivery.otp          = otp
    delivery.otpExpiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 min
    delivery.status       = "delivered"
    delivery.deliveredAt  = new Date()
    await delivery.save()

    console.log(`📦 Delivery ${delivery._id} | OTP: ${otp} | localOrder: ${delivery.localOrderId}`)

    // Notify seller
    pushTo(req, String(delivery.seller), "delivery_at_door", {
      deliveryId: delivery._id.toString(),
      message:    "Package at buyer's door. Waiting for OTP confirmation.",
    })

    // Return OTP in response so rider sees confirmation it was generated
    res.json({ delivery, otp, localOrderId: delivery.localOrderId })
  } catch (err) {
    console.error("Delivered error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// PUT /api/deliveries/:id/confirm-otp
// ── Rider submits OTP they received verbally from buyer → verified → completed
router.put("/:id/confirm-otp", async (req, res) => {
  try {
    const riderId = getRiderId(req)
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
      message:     "Delivery confirmed. Payment released.",
    })

    console.log(`✅ Delivery ${delivery._id} completed | ₵${delivery.deliveryFee}`)
    res.json({ delivery, message: "Delivery complete." })
  } catch (err) { res.status(500).json({ message: err.message }) }
})

// GET /api/deliveries/:id  ← MUST BE LAST
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


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

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString()
}

function isMongoId(str) {
  return str && /^[a-f\d]{24}$/i.test(String(str))
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL NAMED ROUTES FIRST — before any /:id routes
// Express matches routes in order — "force-clear", "available", etc.
// must come before /:id or they get treated as IDs
// ─────────────────────────────────────────────────────────────────────────────

// @route POST /api/deliveries/quote — public
router.post("/quote", async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body
    const pLat = Number(pickupLat), pLng = Number(pickupLng)
    const dLat = Number(dropLat),   dLng = Number(dropLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng) ||
        pickupLat === undefined || dropLat === undefined) {
      return res.status(400).json({ message: "All four coordinates required." })
    }
    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)
    console.log(`📐 Quote: ${distanceKm}km → ₵${deliveryFee}`)
    res.json({ distanceKm, deliveryFee })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/available
router.get("/available", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    // Auto-clear stale activeDelivery
    if (rider.activeDelivery) {
      const active = await Delivery.findById(rider.activeDelivery)
      if (!active || active.status === "completed" || active.status === "cancelled") {
        rider.activeDelivery = null
        await rider.save()
        console.log(`🧹 Auto-cleared stale activeDelivery for rider ${riderId}`)
      } else {
        return res.json({ jobs: [], activeDelivery: rider.activeDelivery })
      }
    }

    const jobs = await Delivery.find({ status: "pending" })
      .sort({ createdAt: -1 })
      .limit(20)

    res.json({ jobs, activeDelivery: null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/my-active
router.get("/my-active", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    if (!rider.activeDelivery) return res.json({ delivery: null })

    const delivery = await Delivery.findById(rider.activeDelivery)

    // Auto-clear stale reference
    if (!delivery || delivery.status === "completed" || delivery.status === "cancelled") {
      rider.activeDelivery = null
      await rider.save()
      return res.json({ delivery: null })
    }

    res.json({ delivery })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/otp-for-order/:localOrderId — public
router.get("/otp-for-order/:localOrderId", async (req, res) => {
  try {
    const { localOrderId } = req.params
    const delivery = await Delivery.findOne({ localOrderId, status: "delivered" })
    if (!delivery) return res.json({ otp: null })
    if (new Date() > delivery.otpExpiresAt) return res.json({ otp: null, message: "OTP expired." })
    res.json({
      otp:        delivery.otp,
      expiresAt:  delivery.otpExpiresAt,
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/by-order/:orderId
router.get("/by-order/:orderId", async (req, res) => {
  try {
    const id = req.params.orderId
    const delivery = isMongoId(id)
      ? await Delivery.findOne({ order: id }).populate("rider", "name phone vehicle")
      : await Delivery.findOne({ localOrderId: id }).populate("rider", "name phone vehicle")
    res.json({ delivery: delivery || null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/force-clear
// ── MUST be before /:id routes or "force-clear" gets treated as a MongoDB ID ──
router.put("/force-clear", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    const prev = rider.activeDelivery
    rider.activeDelivery = null
    await rider.save()

    console.log(`🧹 Force-cleared active delivery for rider ${riderId} (was: ${prev})`)
    res.json({ message: "Active delivery cleared.", cleared: prev ? String(prev) : null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/deliveries — seller requests rider
router.post("/", async (req, res) => {
  try {
    const {
      orderId, pickupLat, pickupLng, pickupAddress,
      dropLat, dropLng, dropAddress,
      sellerContact, buyerContact, itemTitle, itemImage, notes,
    } = req.body

    const sellerId = getUserId(req)
    if (!sellerId) return res.status(401).json({ message: "Not authorized. Please log in as a seller." })

    const pLat = Number(pickupLat), pLng = Number(pickupLng)
    const dLat = Number(dropLat),   dLng = Number(dropLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
      return res.status(400).json({ message: "Invalid coordinates." })
    }

    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)

    const mongoOrderId = isMongoId(orderId) ? orderId : null
    const localOrderId = !isMongoId(orderId) && orderId ? String(orderId) : null

    if (mongoOrderId) {
      const existing = await Delivery.findOne({
        order:  mongoOrderId,
        status: { $nin: ["declined", "cancelled"] },
      })
      if (existing) return res.status(400).json({ message: "A delivery already exists for this order." })
    }

    const delivery = await Delivery.create({
      order:          mongoOrderId,
      localOrderId,
      seller:         sellerId,
      buyer:          null,
      rider:          null,
      pickupLocation: { lat: pLat, lng: pLng, address: pickupAddress || `${pLat}, ${pLng}` },
      dropLocation:   { lat: dLat, lng: dLng, address: dropAddress   || `${dLat}, ${dLng}` },
      sellerContact:  sellerContact || "",
      buyerContact:   buyerContact  || "",
      distanceKm,
      deliveryFee,
      itemTitle:      itemTitle || "Package",
      itemImage:      itemImage || "",
      notes:          notes     || "",
      deliveryType:   "rider",
      status:         "pending",
    })

    console.log(`✅ Delivery ${delivery._id} | seller: ${sellerId} | ₵${deliveryFee} | ${distanceKm}km`)

    // Broadcast new job to ALL connected sockets (riders listening)
    const io = req.app.get("io")
    if (io) {
      const jobData = {
        _id:            delivery._id.toString(),
        deliveryId:     delivery._id.toString(),
        itemTitle:      itemTitle  || "Package",
        itemImage:      itemImage  || null,
        pickupAddress:  pickupAddress || `${pLat}, ${pLng}`,
        dropAddress:    dropAddress   || `${dLat}, ${dLng}`,
        pickupLocation: { lat: pLat, lng: pLng },
        dropLocation:   { lat: dLat, lng: dLng },
        distanceKm,
        deliveryFee,
        sellerContact:  sellerContact || "",
        buyerContact:   buyerContact  || "",
        createdAt:      Date.now(),
      }
      io.emit("new_delivery_job", jobData)
      console.log(`📡 New job broadcast: ₵${deliveryFee} | ${distanceKm}km`)
    }

    res.status(201).json({ delivery, distanceKm, deliveryFee })
  } catch (err) {
    console.error("Create delivery error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// /:id ROUTES BELOW — order matters, named routes above must come first
// ─────────────────────────────────────────────────────────────────────────────

// @route PUT /api/deliveries/:id/accept
router.put("/:id/accept", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    // Auto-clear stale before checking
    if (rider.activeDelivery) {
      const active = await Delivery.findById(rider.activeDelivery)
      if (!active || active.status === "completed" || active.status === "cancelled") {
        rider.activeDelivery = null
        await rider.save()
      } else {
        return res.status(400).json({ message: "You already have an active delivery. Cancel or complete it first." })
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
      deliveryId:   delivery._id.toString(),
      riderName:    rider.name,
      riderPhone:   rider.phone,
      riderVehicle: rider.vehicle,
      itemTitle:    delivery.itemTitle,
      message:      `${rider.name} accepted and is heading to pick up.`,
    })

    res.json({ delivery, rider: { name: rider.name, phone: rider.phone, vehicle: rider.vehicle } })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/decline
router.put("/:id/decline", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })
    res.json({ message: "Job declined." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/cancel-by-rider
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
      itemTitle:  delivery.itemTitle,
      message:    "Rider cancelled. Job is back on the board.",
    })

    const io = req.app.get("io")
    if (io) {
      io.emit("new_delivery_job", {
        _id:            delivery._id.toString(),
        deliveryId:     delivery._id.toString(),
        itemTitle:      delivery.itemTitle,
        itemImage:      delivery.itemImage,
        pickupAddress:  delivery.pickupLocation?.address || `${delivery.pickupLocation?.lat}, ${delivery.pickupLocation?.lng}`,
        dropAddress:    delivery.dropLocation?.address   || `${delivery.dropLocation?.lat}, ${delivery.dropLocation?.lng}`,
        pickupLocation: delivery.pickupLocation,
        dropLocation:   delivery.dropLocation,
        distanceKm:     delivery.distanceKm,
        deliveryFee:    delivery.deliveryFee,
        sellerContact:  delivery.sellerContact,
        buyerContact:   delivery.buyerContact,
        createdAt:      Date.now(),
      })
    }

    res.json({ message: "Cancelled. Job back on board.", delivery })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/picked-up
router.put("/:id/picked-up", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status !== "accepted") {
      return res.status(400).json({ message: `Status is "${delivery.status}", must be "accepted" to pick up.` })
    }

    delivery.status     = "picked_up"
    delivery.pickedUpAt = new Date()
    await delivery.save()

    pushTo(req, String(delivery.seller), "delivery_picked_up", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "Package picked up, heading to buyer.",
    })

    res.json({ delivery })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/delivered
router.put("/:id/delivered", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) return res.status(403).json({ message: "Not your delivery." })
    if (delivery.status !== "picked_up") {
      return res.status(400).json({ message: `Status is "${delivery.status}", must be "picked_up" to deliver.` })
    }

    const otp             = generateOTP()
    delivery.otp          = otp
    delivery.otpExpiresAt = new Date(Date.now() + 30 * 60 * 1000)
    delivery.status       = "delivered"
    delivery.deliveredAt  = new Date()
    await delivery.save()

    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_otp", {
        deliveryId:   delivery._id.toString(),
        localOrderId: delivery.localOrderId,
        otp,
        itemTitle:    delivery.itemTitle,
        message:      "Your package is here! Open your order tracker for the OTP.",
        expiresAt:    delivery.otpExpiresAt,
      })
    }

    pushTo(req, String(delivery.seller), "delivery_at_door", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "Package delivered. Waiting for OTP confirmation.",
    })

    console.log(`📦 Delivery ${delivery._id} delivered | OTP: ${otp} | localOrder: ${delivery.localOrderId}`)
    res.json({ delivery, otp, localOrderId: delivery.localOrderId })
  } catch (err) {
    console.error("Delivered error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/confirm-otp
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
    if (delivery.otp !== otp.trim()) return res.status(400).json({ message: "Incorrect OTP. Ask the buyer to check again." })
    if (new Date() > delivery.otpExpiresAt) return res.status(400).json({ message: "OTP expired. Contact support." })

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
      itemTitle:   delivery.itemTitle,
      deliveryFee: delivery.deliveryFee,
      message:     "Delivery confirmed via OTP. Payment released.",
    })

    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_completed", {
        deliveryId: delivery._id.toString(),
        itemTitle:  delivery.itemTitle,
        message:    "Your order is complete. Enjoy!",
      })
    }

    console.log(`✅ Delivery ${delivery._id} completed | ₵${delivery.deliveryFee}`)
    res.json({ delivery, message: "Delivery completed. Payment released." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/:id — MUST be last GET with /:id
router.get("/:id", async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id)
      .populate("rider",  "name phone vehicle rating")
      .populate("seller", "name phone")
      .populate("order",  "amount status")
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    res.json(delivery)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

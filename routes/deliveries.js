
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
    console.log(`📡 Pushed ${event} to ${userId}`)
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

// @route POST /api/deliveries/quote — public
router.post("/quote", async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body
    if (pickupLat === undefined || pickupLng === undefined ||
        dropLat   === undefined || dropLng   === undefined) {
      return res.status(400).json({ message: "All four coordinates required." })
    }
    const pLat = Number(pickupLat), pLng = Number(pickupLng)
    const dLat = Number(dropLat),   dLng = Number(dropLng)
    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
      return res.status(400).json({ message: "Invalid coordinates." })
    }
    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)
    console.log(`📐 Quote: ${distanceKm}km → ₵${deliveryFee}`)
    res.json({ distanceKm, deliveryFee })
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
    if (!sellerId) {
      return res.status(401).json({ message: "Not authorized. Please log in as a seller." })
    }

    if (pickupLat === undefined || pickupLng === undefined ||
        dropLat   === undefined || dropLng   === undefined) {
      return res.status(400).json({ message: "Pickup and drop-off coordinates required." })
    }

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
      if (existing) {
        return res.status(400).json({ message: "A delivery already exists for this order." })
      }
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

    console.log(`✅ Delivery ${delivery._id} | seller: ${sellerId} | ₵${deliveryFee} | ${distanceKm}km | localOrder: ${localOrderId}`)

    const io = req.app.get("io")
    if (io) {
      io.emit("new_delivery_job", {
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
      })
      console.log(`📡 Job broadcast to all riders`)
    }

    res.status(201).json({ delivery, distanceKm, deliveryFee })
  } catch (err) {
    console.error("Create delivery error:", err.message)
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

    if (rider.activeDelivery) {
      // Verify the active delivery actually exists and is not completed
      const activeDelivery = await Delivery.findById(rider.activeDelivery)
      if (!activeDelivery || activeDelivery.status === "completed" || activeDelivery.status === "cancelled") {
        // Stale reference — auto-clear it
        rider.activeDelivery = null
        await rider.save()
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

    // If delivery is done or doesn't exist, clear the stale reference
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

// @route PUT /api/deliveries/force-clear
// ── NEW: Rider can force-clear a stale active delivery ──
// Use when the delivery is completed/stuck but rider account still shows it active
router.put("/force-clear", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    const prevDeliveryId = rider.activeDelivery
    rider.activeDelivery = null
    await rider.save()

    console.log(`🧹 Force-cleared active delivery for rider ${riderId} (was: ${prevDeliveryId})`)
    res.json({ message: "Active delivery cleared. You can now accept new jobs.", cleared: String(prevDeliveryId) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/otp-for-order/:localOrderId — public
router.get("/otp-for-order/:localOrderId", async (req, res) => {
  try {
    const { localOrderId } = req.params
    if (!localOrderId) return res.status(400).json({ message: "Order ID required." })

    const delivery = await Delivery.findOne({ localOrderId, status: "delivered" })
    if (!delivery) {
      return res.json({ otp: null, message: "No delivery pending OTP for this order." })
    }
    if (new Date() > delivery.otpExpiresAt) {
      return res.json({ otp: null, message: "OTP expired." })
    }
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

// @route PUT /api/deliveries/:id/accept
router.put("/:id/accept", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    // Auto-clear stale activeDelivery before checking
    if (rider.activeDelivery) {
      const existing = await Delivery.findById(rider.activeDelivery)
      if (!existing || existing.status === "completed" || existing.status === "cancelled") {
        rider.activeDelivery = null
        await rider.save()
      } else {
        return res.status(400).json({ message: "You already have an active delivery. Complete or cancel it first." })
      }
    }

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (delivery.status !== "pending") {
      return res.status(400).json({ message: "This job has already been taken." })
    }

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
      message:      `${rider.name} accepted your delivery and is heading to pick up the package.`,
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
    if (String(delivery.rider) !== String(riderId)) {
      return res.status(403).json({ message: "Not your delivery." })
    }
    if (delivery.status === "completed") {
      return res.status(400).json({ message: "Delivery already completed." })
    }
    if (delivery.status === "delivered") {
      return res.status(400).json({ message: "Package already delivered. Get OTP from buyer to complete." })
    }

    delivery.rider      = null
    delivery.status     = "pending"
    delivery.acceptedAt = null
    delivery.pickedUpAt = null
    await delivery.save()

    await Rider.findByIdAndUpdate(riderId, { activeDelivery: null })

    pushTo(req, String(delivery.seller), "delivery_cancelled_by_rider", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "The rider cancelled. The job is back on the board for another rider.",
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

    console.log(`🚫 Rider ${riderId} cancelled delivery ${delivery._id}`)
    res.json({ message: "Delivery cancelled. Back on job board.", delivery })
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
    if (String(delivery.rider) !== String(riderId)) {
      return res.status(403).json({ message: "Not your delivery." })
    }
    if (delivery.status !== "accepted") {
      return res.status(400).json({ message: `Cannot mark picked up — current status: ${delivery.status}` })
    }

    delivery.status     = "picked_up"
    delivery.pickedUpAt = new Date()
    await delivery.save()

    pushTo(req, String(delivery.seller), "delivery_picked_up", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "Your package has been picked up and is on the way to the buyer.",
    })

    res.json({ delivery })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/delivered
// Generates OTP — buyer sees it in OrderTracker, reads to rider
router.put("/:id/delivered", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) {
      return res.status(403).json({ message: "Not your delivery." })
    }
    if (delivery.status !== "picked_up") {
      return res.status(400).json({ message: `Cannot mark delivered — current status: ${delivery.status}` })
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
        message:      "Your package has arrived! Open your order tracker to see your OTP.",
        expiresAt:    delivery.otpExpiresAt,
      })
    }

    pushTo(req, String(delivery.seller), "delivery_at_door", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "Package delivered. Waiting for buyer OTP confirmation.",
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
    if (!otp) return res.status(400).json({ message: "OTP is required." })

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) {
      return res.status(403).json({ message: "Not your delivery." })
    }
    if (delivery.status !== "delivered") {
      return res.status(400).json({ message: "Mark as delivered first." })
    }
    if (delivery.otp !== otp.trim()) {
      return res.status(400).json({ message: "Incorrect OTP. Ask the buyer to check their order tracker." })
    }
    if (new Date() > delivery.otpExpiresAt) {
      return res.status(400).json({ message: "OTP has expired. Contact support." })
    }

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

// @route GET /api/deliveries/:id
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

export default router

import express  from "express"
import jwt      from "jsonwebtoken"
import crypto   from "crypto"
import Delivery from "../models/Delivery.js"
import Rider    from "../models/Rider.js"
import Order    from "../models/Order.js"
import { haversineKm, calculateDeliveryFee } from "../utils/distance.js"

const router = express.Router()

// ── Auth helpers ───────────────────────────────────────────────────────────────
function getUserId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
    return decoded.id
  } catch { return null }
}

function getRiderId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
    return decoded.id
  } catch { return null }
}

// ── Socket push helper ─────────────────────────────────────────────────────────
function pushTo(req, userId, event, data) {
  try {
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (!io || !sellerSockets) return
    const sockets = sellerSockets.get(String(userId))
    if (!sockets || sockets.size === 0) return
    sockets.forEach(socketId => io.to(socketId).emit(event, data))
    console.log(`📡 Pushed ${event} to ${userId}`)
  } catch (err) {
    console.error("pushTo error:", err.message)
  }
}

// ── OTP generator ──────────────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString()
}

// ── Check if string is valid MongoDB ObjectId ──────────────────────────────────
function isMongoId(str) {
  return str && /^[a-f\d]{24}$/i.test(String(str))
}

// @route POST /api/deliveries/quote
// Public — calculate fee before creating delivery
router.post("/quote", async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body

    if (!pickupLat || !pickupLng || !dropLat || !dropLng) {
      return res.status(400).json({ message: "All four coordinates are required." })
    }

    const pLat = Number(pickupLat)
    const pLng = Number(pickupLng)
    const dLat = Number(dropLat)
    const dLng = Number(dropLng)

    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
      return res.status(400).json({ message: "Invalid coordinates — must be numbers." })
    }

    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)

    console.log(`📐 Quote: ${distanceKm}km → ₵${deliveryFee}`)
    res.json({ distanceKm, deliveryFee })
  } catch (err) {
    console.error("Quote error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/deliveries
// Seller requests a rider delivery
router.post("/", async (req, res) => {
  try {
    const {
      orderId,
      pickupLat,     pickupLng,     pickupAddress,
      dropLat,       dropLng,       dropAddress,
      sellerContact, buyerContact,
      itemTitle,     itemImage,     notes,
    } = req.body

    // Seller must be logged in
    const sellerId = getUserId(req)
    if (!sellerId) return res.status(401).json({ message: "Not authorized. Please log in." })

    // Coordinates are required
    if (!pickupLat || !pickupLng || !dropLat || !dropLng) {
      return res.status(400).json({ message: "Pickup and drop-off coordinates are required." })
    }

    const pLat = Number(pickupLat)
    const pLng = Number(pickupLng)
    const dLat = Number(dropLat)
    const dLng = Number(dropLng)

    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
      return res.status(400).json({ message: "Invalid coordinates." })
    }

    // Calculate distance and fee
    const distanceKm  = haversineKm(pLat, pLng, dLat, dLng)
    const deliveryFee = calculateDeliveryFee(distanceKm)

    // Only treat orderId as MongoDB reference if it's actually a Mongo ObjectId
    // Local SR- IDs (e.g. SR-9EZ59N) are stored separately as localOrderId
    const mongoOrderId = isMongoId(orderId) ? orderId : null
    const localOrderId = !isMongoId(orderId) ? (orderId || null) : null

    // Prevent duplicate delivery for same MongoDB order
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

    console.log(`✅ Delivery created: ${delivery._id} | seller: ${sellerId} | ₵${deliveryFee} | ${distanceKm}km`)

    // Broadcast new job to ALL connected riders
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (io) {
      io.emit("new_delivery_job", {
        deliveryId:    delivery._id.toString(),
        itemTitle:     itemTitle  || "Package",
        itemImage:     itemImage  || null,
        pickupAddress: pickupAddress || `${pLat}, ${pLng}`,
        dropAddress:   dropAddress   || `${dLat}, ${dLng}`,
        distanceKm,
        deliveryFee,
        sellerContact: sellerContact || "",
        buyerContact:  buyerContact  || "",
        createdAt:     Date.now(),
      })
      console.log(`📡 Job broadcast to all riders | ${distanceKm}km | ₵${deliveryFee}`)
    }

    res.status(201).json({ delivery, distanceKm, deliveryFee })
  } catch (err) {
    console.error("Create delivery error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/available
// Riders fetch available pending jobs
router.get("/available", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    if (rider.activeDelivery) {
      return res.json({ jobs: [], activeDelivery: rider.activeDelivery })
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
// Rider's current active delivery
router.get("/my-active", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider?.activeDelivery) return res.json({ delivery: null })

    const delivery = await Delivery.findById(rider.activeDelivery)
    res.json({ delivery })
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

    if (rider.activeDelivery) {
      return res.status(400).json({ message: "You already have an active delivery. Complete it first." })
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

    // Notify seller that rider accepted
    pushTo(req, String(delivery.seller), "delivery_accepted", {
      deliveryId:   delivery._id.toString(),
      riderName:    rider.name,
      riderPhone:   rider.phone,
      riderVehicle: rider.vehicle,
      itemTitle:    delivery.itemTitle,
      message:      `${rider.name} accepted your delivery and is on the way to pick up.`,
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

    // Job stays pending for other riders to accept
    res.json({ message: "Job declined. It remains available for other riders." })
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
      return res.status(400).json({ message: "Delivery must be accepted before marking picked up." })
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
// Rider marks as delivered — generates OTP that BUYER sees on their screen
// Buyer reads OTP to rider verbally — rider enters it to confirm
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
      return res.status(400).json({ message: "Mark as picked up first." })
    }

    // Generate OTP — buyer sees this, reads it to rider
    const otp             = generateOTP()
    delivery.otp          = otp
    delivery.otpExpiresAt = new Date(Date.now() + 30 * 60 * 1000)
    delivery.status       = "delivered"
    delivery.deliveredAt  = new Date()
    await delivery.save()

    // Push OTP to buyer so it shows on their order screen
    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_otp", {
        deliveryId: delivery._id.toString(),
        otp,
        itemTitle:  delivery.itemTitle,
        message:    "Your package has arrived! Give this OTP to the rider to confirm delivery.",
        expiresAt:  delivery.otpExpiresAt,
      })
    }

    // Also notify seller
    pushTo(req, String(delivery.seller), "delivery_at_door", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "Package delivered. Waiting for buyer OTP confirmation.",
    })

    console.log(`📦 Delivery ${delivery._id} marked delivered | OTP generated`)
    res.json({ delivery, message: "OTP generated. Ask buyer to read you their code." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/confirm-otp
// Rider enters OTP that buyer read to them — completes delivery and releases payment
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
      return res.status(400).json({ message: "Incorrect OTP. Ask the buyer to check again." })
    }
    if (new Date() > delivery.otpExpiresAt) {
      return res.status(400).json({ message: "OTP has expired. Contact support." })
    }

    delivery.status      = "completed"
    delivery.otpVerified = true
    delivery.completedAt = new Date()
    await delivery.save()

    // Update rider stats
    const rider = await Rider.findById(riderId)
    if (rider) {
      rider.totalDeliveries += 1
      rider.totalEarned     += delivery.deliveryFee
      rider.activeDelivery   = null
      await rider.save()
    }

    // Update backend order status if we have a real order ID
    if (delivery.order) {
      await Order.findByIdAndUpdate(delivery.order, { status: "Completed" })
    }

    // Notify seller — payment released
    pushTo(req, String(delivery.seller), "delivery_completed", {
      deliveryId:  delivery._id.toString(),
      itemTitle:   delivery.itemTitle,
      deliveryFee: delivery.deliveryFee,
      message:     "Delivery confirmed via OTP. Payment released.",
    })

    // Notify buyer
    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_completed", {
        deliveryId: delivery._id.toString(),
        itemTitle:  delivery.itemTitle,
        message:    "Your order is complete. Enjoy!",
      })
    }

    console.log(`✅ Delivery ${delivery._id} completed | ₵${delivery.deliveryFee} released`)
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

    // Search by MongoDB order ID or local SR- order ID
    const delivery = isMongoId(id)
      ? await Delivery.findOne({ order: id }).populate("rider", "name phone vehicle")
      : await Delivery.findOne({ localOrderId: id }).populate("rider", "name phone vehicle")

    res.json({ delivery: delivery || null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

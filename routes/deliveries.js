import express  from "express"
import jwt      from "jsonwebtoken"
import crypto   from "crypto"
import Delivery from "../models/Delivery.js"
import Rider    from "../models/Rider.js"
import Order    from "../models/Order.js"
import { haversineKm, calculateDeliveryFee } from "../utils/distance.js"

const router = express.Router()

// ── Auth helpers ───────────────────────────────────────────────────────────────
// Extract user ID from ANY valid JWT — works for both seller and rider tokens
// since both are signed with the same JWT_SECRET
function getAnyUserId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
    return decoded.id || null
  } catch (err) {
    console.log("Auth decode error:", err.message)
    return null
  }
}

// Alias — same function, semantic naming
const getUserId  = getAnyUserId
const getRiderId = getAnyUserId

// ── Socket push ────────────────────────────────────────────────────────────────
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

// @route POST /api/deliveries/quote — public, no auth
router.post("/quote", async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body

    if (pickupLat === undefined || pickupLng === undefined ||
        dropLat   === undefined || dropLng   === undefined) {
      return res.status(400).json({ message: "All four coordinates required." })
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

// @route POST /api/deliveries — seller requests a rider
router.post("/", async (req, res) => {
  try {
    const {
      orderId,
      pickupLat,     pickupLng,     pickupAddress,
      dropLat,       dropLng,       dropAddress,
      sellerContact, buyerContact,
      itemTitle,     itemImage,     notes,
    } = req.body

    // Debug: log what token we received
    const authHeader = req.headers.authorization
    console.log("Create delivery — auth header present:", !!authHeader)

    const sellerId = getUserId(req)
    console.log("Create delivery — decoded sellerId:", sellerId)

    if (!sellerId) {
      return res.status(401).json({
        message: "Not authorized. Make sure you are logged in as a seller."
      })
    }

    if (pickupLat === undefined || pickupLng === undefined ||
        dropLat   === undefined || dropLng   === undefined) {
      return res.status(400).json({ message: "Pickup and drop-off coordinates required." })
    }

    const pLat = Number(pickupLat)
    const pLng = Number(pickupLng)
    const dLat = Number(dropLat)
    const dLng = Number(dropLng)

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

    console.log(`✅ Delivery ${delivery._id} created | seller: ${sellerId} | ₵${deliveryFee} | ${distanceKm}km`)

    // Broadcast to all connected riders
    const io = req.app.get("io")
    if (io) {
      io.emit("new_delivery_job", {
        _id:           delivery._id.toString(),
        deliveryId:    delivery._id.toString(),
        itemTitle:     itemTitle  || "Package",
        itemImage:     itemImage  || null,
        pickupAddress: pickupAddress || `${pLat}, ${pLng}`,
        dropAddress:   dropAddress   || `${dLat}, ${dLng}`,
        pickupLocation:{ lat: pLat, lng: pLng },
        dropLocation:  { lat: dLat, lng: dLng },
        distanceKm,
        deliveryFee,
        sellerContact: sellerContact || "",
        buyerContact:  buyerContact  || "",
        createdAt:     Date.now(),
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
router.get("/my-active", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider?.activeDelivery) return res.json({ delivery: null })

    const delivery = await Delivery.findById(rider.activeDelivery)
    res.json({ delivery: delivery || null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/otp-for-order/:localOrderId — public
// Buyer polls this to get their OTP when rider marks as delivered
router.get("/otp-for-order/:localOrderId", async (req, res) => {
  try {
    const { localOrderId } = req.params
    if (!localOrderId) return res.status(400).json({ message: "Order ID required." })

    const delivery = await Delivery.findOne({
      localOrderId,
      status: "delivered",
    })

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
    if (rider.activeDelivery) {
      return res.status(400).json({ message: "You already have an active delivery. Complete or cancel it first." })
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
    res.json({ message: "Job declined. It remains available for other riders." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/cancel-by-rider
// ── NEW: Rider can manually cancel an active delivery ──
// Puts the job back to pending so other riders can pick it up
router.put("/:id/cancel-by-rider", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (String(delivery.rider) !== String(riderId)) {
      return res.status(403).json({ message: "Not your delivery." })
    }

    // Can only cancel if not yet delivered (once at door, must complete)
    if (delivery.status === "completed") {
      return res.status(400).json({ message: "Delivery already completed." })
    }
    if (delivery.status === "delivered") {
      return res.status(400).json({ message: "Package already delivered. Ask the buyer for their OTP to complete." })
    }

    // Put back to pending so another rider can pick it up
    const previousStatus = delivery.status
    delivery.rider      = null
    delivery.status     = "pending"
    delivery.acceptedAt = null
    delivery.pickedUpAt = null
    await delivery.save()

    // Free up the rider
    await Rider.findByIdAndUpdate(riderId, { activeDelivery: null })

    // Notify seller
    pushTo(req, String(delivery.seller), "delivery_cancelled_by_rider", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "The rider cancelled this delivery. It's back on the job board for another rider to pick up.",
    })

    // Re-broadcast to riders since it's pending again
    const io = req.app.get("io")
    if (io) {
      io.emit("new_delivery_job", {
        _id:           delivery._id.toString(),
        deliveryId:    delivery._id.toString(),
        itemTitle:     delivery.itemTitle,
        itemImage:     delivery.itemImage,
        pickupAddress: delivery.pickupLocation?.address || `${delivery.pickupLocation?.lat}, ${delivery.pickupLocation?.lng}`,
        dropAddress:   delivery.dropLocation?.address   || `${delivery.dropLocation?.lat}, ${delivery.dropLocation?.lng}`,
        pickupLocation: delivery.pickupLocation,
        dropLocation:   delivery.dropLocation,
        distanceKm:    delivery.distanceKm,
        deliveryFee:   delivery.deliveryFee,
        sellerContact: delivery.sellerContact,
        buyerContact:  delivery.buyerContact,
        createdAt:     Date.now(),
      })
    }

    console.log(`🚫 Rider ${riderId} cancelled delivery ${delivery._id} (was ${previousStatus}) — back to pending`)
    res.json({ message: "Delivery cancelled. It's back on the job board.", delivery })
  } catch (err) {
    console.error("Cancel delivery error:", err.message)
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
      return res.status(400).json({ message: "Delivery must be in accepted state." })
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

    const otp             = generateOTP()
    delivery.otp          = otp
    delivery.otpExpiresAt = new Date(Date.now() + 30 * 60 * 1000)
    delivery.status       = "delivered"
    delivery.deliveredAt  = new Date()
    await delivery.save()

    // Push OTP to buyer if they have an account socket
    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_otp", {
        deliveryId:   delivery._id.toString(),
        localOrderId: delivery.localOrderId,
        otp,
        itemTitle:    delivery.itemTitle,
        message:      "Your package has arrived! Give this OTP to the rider.",
        expiresAt:    delivery.otpExpiresAt,
      })
    }

    pushTo(req, String(delivery.seller), "delivery_at_door", {
      deliveryId: delivery._id.toString(),
      itemTitle:  delivery.itemTitle,
      message:    "Package delivered to buyer. Waiting for OTP confirmation.",
    })

    console.log(`📦 Delivery ${delivery._id} delivered | OTP: ${otp} | localOrderId: ${delivery.localOrderId}`)
    res.json({
      delivery,
      otp,
      localOrderId: delivery.localOrderId,
      message:      "OTP generated. Ask buyer to open their order tracker and read you the code.",
    })
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
      return res.status(400).json({ message: "Incorrect OTP. Ask the buyer to check again." })
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
    const delivery = isMongoId(id)
      ? await Delivery.findOne({ order: id }).populate("rider", "name phone vehicle")
      : await Delivery.findOne({ localOrderId: id }).populate("rider", "name phone vehicle")
    res.json({ delivery: delivery || null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

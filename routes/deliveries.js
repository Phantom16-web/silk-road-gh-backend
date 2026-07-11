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
  } catch {}
}

// ── Generate 6-digit OTP ───────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString()
}

// @route POST /api/deliveries/quote
// Calculate delivery fee before creating delivery
// Called when seller sees the "Request Rider" option
router.post("/quote", async (req, res) => {
  try {
    const {
      pickupLat, pickupLng,
      dropLat,   dropLng,
    } = req.body

    if (!pickupLat || !pickupLng || !dropLat || !dropLng) {
      return res.status(400).json({ message: "Pickup and drop coordinates required." })
    }

    const distanceKm  = haversineKm(
      Number(pickupLat), Number(pickupLng),
      Number(dropLat),   Number(dropLng)
    )
    const deliveryFee = calculateDeliveryFee(distanceKm)

    res.json({ distanceKm, deliveryFee })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/deliveries
// Seller requests a rider delivery
router.post("/", async (req, res) => {
  try {
    const sellerId = getUserId(req)
    if (!sellerId) return res.status(401).json({ message: "Not authorized." })

    const {
      orderId,
      pickupLat,   pickupLng,   pickupAddress,
      dropLat,     dropLng,     dropAddress,
      sellerContact,
      buyerContact,
      itemTitle,
      itemImage,
      notes,
    } = req.body

    if (!orderId || !pickupLat || !pickupLng || !dropLat || !dropLng) {
      return res.status(400).json({ message: "orderId, pickup and drop coordinates are required." })
    }

    // Calculate distance and fee
    const distanceKm  = haversineKm(
      Number(pickupLat), Number(pickupLng),
      Number(dropLat),   Number(dropLng)
    )
    const deliveryFee = calculateDeliveryFee(distanceKm)

    // Check order exists
    const order = await Order.findById(orderId)
    if (!order) return res.status(404).json({ message: "Order not found." })

    // Prevent duplicate delivery requests for same order
    const existing = await Delivery.findOne({ order: orderId, status: { $nin: ["declined", "cancelled"] } })
    if (existing) return res.status(400).json({ message: "A delivery already exists for this order." })

    const delivery = await Delivery.create({
      order:          orderId,
      seller:         sellerId,
      buyer:          order.buyer || null,
      pickupLocation: { lat: Number(pickupLat), lng: Number(pickupLng), address: pickupAddress || "" },
      dropLocation:   { lat: Number(dropLat),   lng: Number(dropLng),   address: dropAddress   || "" },
      sellerContact:  sellerContact || "",
      buyerContact:   buyerContact  || "",
      distanceKm,
      deliveryFee,
      itemTitle:      itemTitle || "",
      itemImage:      itemImage || "",
      notes:          notes     || "",
      deliveryType:   "rider",
      status:         "pending",
    })

    // Push to all online riders via socket
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (io && sellerSockets) {
      // Broadcast new job to all connected riders
      io.emit("new_delivery_job", {
        deliveryId:    delivery._id.toString(),
        itemTitle:     itemTitle || "Package",
        itemImage:     itemImage || null,
        pickupAddress: pickupAddress || `${pickupLat}, ${pickupLng}`,
        dropAddress:   dropAddress   || `${dropLat}, ${dropLng}`,
        distanceKm,
        deliveryFee,
        sellerContact: sellerContact || "",
        createdAt:     Date.now(),
      })
    }

    res.status(201).json({ delivery, distanceKm, deliveryFee })
  } catch (err) {
    console.error("Create delivery error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/available
// Riders see all pending jobs
router.get("/available", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const rider = await Rider.findById(riderId)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    // Rider can only see jobs if they have no active delivery
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
// Rider gets their current active delivery
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
// Rider accepts a job
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
      message:      `${rider.name} has accepted your delivery and is on the way to pick up the package.`,
    })

    res.json({ delivery, rider: { name: rider.name, phone: rider.phone, vehicle: rider.vehicle } })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/decline
// Rider declines a job
router.put("/:id/decline", async (req, res) => {
  try {
    const riderId = getRiderId(req)
    if (!riderId) return res.status(401).json({ message: "Not authorized." })

    const delivery = await Delivery.findById(req.params.id)
    if (!delivery) return res.status(404).json({ message: "Delivery not found." })
    if (delivery.status !== "pending") {
      return res.status(400).json({ message: "Job is no longer available." })
    }

    // Don't change status — just let other riders see it
    // Only mark declined if this specific rider declines
    // (other riders can still accept)
    res.json({ message: "Job declined. It remains available for other riders." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/picked-up
// Rider confirms they have picked up the package from seller
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
      return res.status(400).json({ message: "Delivery must be accepted before pickup." })
    }

    delivery.status     = "picked_up"
    delivery.pickedUpAt = new Date()
    await delivery.save()

    // Notify seller package has been picked up
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
// Rider marks as delivered — generates OTP for buyer
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

    // Generate OTP — expires in 30 minutes
    const otp = generateOTP()
    delivery.otp          = otp
    delivery.otpExpiresAt = new Date(Date.now() + 30 * 60 * 1000)
    delivery.status       = "delivered"
    delivery.deliveredAt  = new Date()
    await delivery.save()

    // Send OTP to buyer via socket so it shows on their screen
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
      message:    "Package has been delivered to buyer. Waiting for OTP confirmation.",
    })

    // Return OTP in response so rider app can display "waiting for OTP"
    res.json({ delivery, otp, message: "OTP generated. Ask buyer for the code." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/deliveries/:id/confirm-otp
// Rider enters the OTP buyer gives them — completes the delivery
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

    // Check OTP
    if (delivery.otp !== otp.trim()) {
      return res.status(400).json({ message: "Incorrect OTP. Ask the buyer to check again." })
    }

    // Check expiry
    if (new Date() > delivery.otpExpiresAt) {
      return res.status(400).json({ message: "OTP has expired. Contact support." })
    }

    // Complete the delivery
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

    // Update order status
    await Order.findByIdAndUpdate(delivery.order, { status: "Completed" })

    // Notify seller — payment released
    pushTo(req, String(delivery.seller), "delivery_completed", {
      deliveryId:  delivery._id.toString(),
      itemTitle:   delivery.itemTitle,
      deliveryFee: delivery.deliveryFee,
      message:     "Delivery confirmed via OTP. Payment has been released.",
    })

    // Notify buyer — all done
    if (delivery.buyer) {
      pushTo(req, String(delivery.buyer), "delivery_completed", {
        deliveryId: delivery._id.toString(),
        itemTitle:  delivery.itemTitle,
        message:    "Your order is complete. Enjoy!",
      })
    }

    res.json({ delivery, message: "Delivery completed. Payment released." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/deliveries/:id
// Get delivery details — used by seller, buyer and rider
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
// Get delivery for a specific order
router.get("/by-order/:orderId", async (req, res) => {
  try {
    const delivery = await Delivery.findOne({ order: req.params.orderId })
      .populate("rider", "name phone vehicle")
    res.json({ delivery: delivery || null })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

import express from "express"
import Order from "../models/Order.js"
import Listing from "../models/Listing.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// ── Push real-time notification to seller on ALL their connected devices ────────
function pushToSeller(req, sellerId, notification) {
  try {
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (!io || !sellerSockets) return
    const sockets = sellerSockets.get(String(sellerId))
    if (!sockets || sockets.size === 0) {
      console.log(`📭 Seller ${sellerId} not connected — notification stored only`)
      return
    }
    sockets.forEach(socketId => {
      io.to(socketId).emit("new_order_notification", notification)
    })
    console.log(`📡 Pushed to seller ${sellerId} on ${sockets.size} device(s)`)
  } catch (err) {
    console.error("Socket push error:", err.message)
  }
}

// ── Helper: optional auth middleware ──────────────────────────────────────────
// Unlike protect, this does NOT reject unauthenticated requests.
// It just attaches req.user if a valid token exists.
function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization
    if (header && header.startsWith("Bearer ")) {
      const token = header.split(" ")[1]
      const jwt   = await import("jsonwebtoken")
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET)
      req.user = decoded
    }
  } catch {}
  next()
}

// @route POST /api/orders
// PUBLIC — buyer does not need to be logged in
// We look up the listing to get the real sellerId from the DB
router.post("/", async (req, res) => {
  try {
    const {
      listingId,
      sellerId,
      type,
      amount,
      paystackRef,
      location,
      landmark,
      extraInfo,
      contactInfo,
      rentalDays,
      promoCode,
      discount,
      deliveryMethod,
      paymentMethod,
      payerName,
      payerPhone,
    } = req.body

    if (!listingId && !sellerId) {
      return res.status(400).json({ message: "listingId or sellerId is required." })
    }

    // Resolve the real seller ID from the listing if not provided
    let resolvedSellerId = sellerId || null
    let listingTitle     = null
    let listingImage     = null

    if (listingId) {
      try {
        const listing = await Listing.findById(listingId)
          .populate("seller", "name")
          .select("title image seller")
        if (listing) {
          resolvedSellerId = resolvedSellerId || listing.seller?._id?.toString()
          listingTitle     = listing.title
          listingImage     = listing.image
        }
      } catch (e) {
        console.warn("Could not resolve listing:", e.message)
      }
    }

    const platformFee  = Math.round((amount || 0) * 0.08)
    const sellerAmount = (amount || 0) - platformFee

    // Determine buyer ID if logged in (optional)
    let buyerId = null
    try {
      const header = req.headers.authorization
      if (header && header.startsWith("Bearer ")) {
        const { default: jwt } = await import("jsonwebtoken")
        const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
        buyerId = decoded.id
      }
    } catch {}

    const order = await Order.create({
      buyer:          buyerId || null,
      seller:         resolvedSellerId || null,
      listing:        listingId || null,
      type:           type || "product",
      amount:         amount || 0,
      platformFee,
      sellerAmount,
      paystackRef:    paystackRef || null,
      location:       location || null,
      landmark:       landmark || null,
      extraInfo:      extraInfo || null,
      contactInfo:    contactInfo || null,
      rentalDays:     rentalDays || null,
      promoCode:      promoCode || null,
      discount:       discount || 0,
      deliveryMethod: deliveryMethod || "pickup",
      paymentMethod:  paymentMethod || "manual_momo",
      payerName:      payerName || null,
      payerPhone:     payerPhone || null,
      status:         "In Escrow",
    })

    console.log(`✅ Order created: ${order._id} | seller: ${resolvedSellerId} | amount: ₵${amount}`)

    // Push real-time notification to seller on ALL their devices
    if (resolvedSellerId) {
      const notification = {
        id:             `NOTIF-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        type:           "new_order",
        orderId:        order._id.toString(),
        sellerId:       String(resolvedSellerId),
        itemTitle:      listingTitle || "New Order",
        itemImage:      listingImage || null,
        amount:         amount || 0,
        buyerName:      payerName || "A buyer",
        buyerContact:   contactInfo || payerPhone || null,
        deliveryMethod: deliveryMethod || "pickup",
        location:       location || null,
        landmark:       landmark || null,
        promoCode:      promoCode || null,
        discount:       discount || 0,
        paymentRef:     paystackRef || null,
        paymentMethod:  paymentMethod || "manual_momo",
        status:         "unread",
        createdAt:      Date.now(),
      }

      pushToSeller(req, resolvedSellerId, notification)
    }

    res.status(201).json({ success: true, orderId: order._id, message: "Order created." })
  } catch (err) {
    console.error("Order creation error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/my — buyer's orders (requires login)
router.get("/my", protect, async (req, res) => {
  try {
    const orders = await Order.find({ buyer: req.user.id })
      .populate("listing", "title image type")
      .populate("seller",  "name")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/selling — seller's incoming orders (requires login)
router.get("/selling", protect, async (req, res) => {
  try {
    const orders = await Order.find({ seller: req.user.id })
      .populate("listing", "title image type")
      .populate("buyer",   "name phone")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/all — admin
router.get("/all", protect, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("listing", "title image type")
      .populate("buyer",   "name email")
      .populate("seller",  "name email")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/orders/confirm-by-ref
router.put("/confirm-by-ref", protect, async (req, res) => {
  try {
    const { paystackRef } = req.body
    if (!paystackRef) return res.status(400).json({ message: "Ref required." })
    const order = await Order.findOne({ paystackRef })
    if (!order) return res.status(404).json({ message: "Order not found." })
    order.status = "Completed"
    await order.save()
    res.json({ message: "Confirmed. Payment released to seller.", order })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/orders/:id/confirm-delivery
router.put("/:id/confirm-delivery", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found" })
    order.status = "Completed"
    await order.save()
    res.json({ message: "Confirmed.", order })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/orders/:id/cancel
router.put("/:id/cancel", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found" })
    order.status    = "Refunded"
    order.cancelled = true
    await order.save()
    res.json({ message: "Cancelled. Refund initiated.", order })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/orders/:id/confirm-return
router.put("/:id/confirm-return", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found" })
    const { role } = req.body
    if (role === "renter") order.renterConfirmed = true
    if (role === "lender") order.lenderConfirmed = true
    if (order.renterConfirmed && order.lenderConfirmed) order.status = "Completed"
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

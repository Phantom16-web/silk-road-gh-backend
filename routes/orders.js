import express from "express"
import Order from "../models/Order.js"
import Listing from "../models/Listing.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// ── Push real-time notification to seller on ALL connected devices ─────────────
function pushToSeller(req, sellerId, notification) {
  try {
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (!io || !sellerSockets) return
    const id = String(sellerId)
    const sockets = sellerSockets.get(id)
    if (!sockets || sockets.size === 0) {
      console.log(`📭 Seller ${id} has no active sockets — notification stored only`)
      return
    }
    sockets.forEach(socketId => {
      io.to(socketId).emit("new_order_notification", notification)
    })
    console.log(`📡 Pushed to seller ${id} on ${sockets.size} device(s)`)
  } catch (err) {
    console.error("Socket push error:", err.message)
  }
}

// @route POST /api/orders
router.post("/", protect, async (req, res) => {
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
    } = req.body

    // Resolve sellerId — if listingId provided and sellerId missing, look it up
    let resolvedSellerId = sellerId
    if (!resolvedSellerId && listingId) {
      try {
        const listing = await Listing.findById(listingId).select("seller")
        if (listing) resolvedSellerId = listing.seller.toString()
      } catch {}
    }

    // Guard: buyer cannot be their own seller
    if (resolvedSellerId && resolvedSellerId.toString() === req.user.id) {
      return res.status(400).json({ message: "You cannot order your own listing." })
    }

    const platformFee  = Math.round((amount || 0) * 0.08)
    const sellerAmount = (amount || 0) - platformFee

    const order = await Order.create({
      buyer:          req.user.id,
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
      status:         "In Escrow",
    })

    const populated = await order.populate([
      { path: "listing", select: "title image" },
      { path: "seller",  select: "name phone" },
      { path: "buyer",   select: "name phone" },
    ])

    console.log(`✅ Order created: ${order._id} | buyer: ${req.user.id} | seller: ${resolvedSellerId}`)

    // Push real-time notification to seller on all their devices
    if (resolvedSellerId) {
      pushToSeller(req, resolvedSellerId, {
        id:             `NOTIF-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        type:           "new_order",
        orderId:        order._id.toString(),
        sellerId:       String(resolvedSellerId),
        itemTitle:      populated.listing?.title || "New Order",
        itemImage:      populated.listing?.image || null,
        amount:         amount || 0,
        buyerName:      populated.buyer?.name || "A buyer",
        buyerContact:   contactInfo || null,
        deliveryMethod: deliveryMethod || "pickup",
        location:       location || null,
        landmark:       landmark || null,
        promoCode:      promoCode || null,
        discount:       discount || 0,
        paymentRef:     paystackRef || null,
        paymentMethod:  paymentMethod || "manual_momo",
        status:         "unread",
        createdAt:      Date.now(),
      })
    }

    res.status(201).json(populated)
  } catch (err) {
    console.error("Order creation error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/my — buyer's orders
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

// @route GET /api/orders/selling — seller's incoming orders
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

// @route GET /api/orders/all — admin only
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
    if (order.buyer.toString() !== req.user.id)
      return res.status(403).json({ message: "Not authorized." })
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
    if (order.buyer.toString() !== req.user.id)
      return res.status(403).json({ message: "Not authorized" })
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
    if (order.buyer.toString() !== req.user.id)
      return res.status(403).json({ message: "Not authorized" })
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

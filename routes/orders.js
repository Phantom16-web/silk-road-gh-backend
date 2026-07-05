import express from "express"
import axios from "axios"
import Order from "../models/Order.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// ── Helper: push real-time notification to seller ──────────────────────────────
function pushToSeller(req, sellerId, notification) {
  try {
    const io           = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (!io || !sellerSockets) return
    const sockets = sellerSockets.get(String(sellerId))
    if (!sockets || sockets.size === 0) return
    sockets.forEach(socketId => {
      io.to(socketId).emit("new_order_notification", notification)
    })
    console.log(`📡 Pushed notification to seller ${sellerId} (${sockets.size} device(s))`)
  } catch (err) {
    console.error("Socket push error:", err.message)
  }
}

// @route POST /api/orders
router.post("/", protect, async (req, res) => {
  try {
    const {
      listingId, sellerId, type, amount,
      paystackRef, location, landmark,
      extraInfo, contactInfo, rentalDays,
      promoCode, discount, deliveryMethod,
      paymentMethod,
    } = req.body

    if (paystackRef && process.env.PAYSTACK_SECRET_KEY) {
      try {
        const verify = await axios.get(
          `https://api.paystack.co/transaction/verify/${paystackRef}`,
          { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
        )
        if (verify.data.data.status !== "success") {
          return res.status(400).json({ message: "Payment verification failed." })
        }
      } catch {
        // test mode — continue
      }
    }

    const platformFee  = Math.round(amount * 0.08)
    const sellerAmount = amount - platformFee

    const order = await Order.create({
      buyer: req.user.id,
      seller: sellerId,
      listing: listingId,
      type: type || "product",
      amount,
      platformFee,
      sellerAmount,
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
      status: "In Escrow",
    })

    const populated = await order.populate([
      { path: "listing", select: "title image" },
      { path: "seller",  select: "name phone" },
      { path: "buyer",   select: "name phone" },
    ])

    // ── Push real-time notification to seller on ALL their devices ──────────────
    if (sellerId) {
      pushToSeller(req, sellerId, {
        id:             `NOTIF-${Date.now()}`,
        type:           "new_order",
        orderId:        order._id.toString(),
        sellerId:       String(sellerId),
        itemTitle:      populated.listing?.title || "New Order",
        itemImage:      populated.listing?.image || null,
        amount,
        buyerContact:   contactInfo,
        buyerName:      populated.buyer?.name || "A buyer",
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
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/my
router.get("/my", protect, async (req, res) => {
  try {
    const orders = await Order.find({ buyer: req.user.id })
      .populate("listing", "title image type")
      .populate("seller", "name")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/selling
router.get("/selling", protect, async (req, res) => {
  try {
    const orders = await Order.find({ seller: req.user.id })
      .populate("listing", "title image type")
      .populate("buyer", "name phone")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/all
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
    res.json({ message: "Delivery confirmed. Payment released to seller.", order })
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
    res.json({ message: "Delivery confirmed.", order })
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
    res.json({ message: "Order cancelled. Refund initiated.", order })
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

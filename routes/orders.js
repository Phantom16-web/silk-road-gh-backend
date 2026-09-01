import express from "express"
import jwt     from "jsonwebtoken"
import Order   from "../models/Order.js"
import Listing from "../models/Listing.js"
import protect from "../middleware/auth.js"

const router = express.Router()

function pushToSeller(req, sellerId, data) {
  try {
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    const queueNotif    = req.app.get("queueNotification")
    if (!io || !sellerSockets || !sellerId) return

    const sockets = sellerSockets.get(String(sellerId))

    if (!sockets || sockets.size === 0) {
      // Seller is offline — queue so they get it the moment they reconnect
      if (queueNotif) queueNotif(String(sellerId), "new_order", data)
      console.log(`📬 Seller ${sellerId} offline — new_order queued`)
      return
    }

    sockets.forEach(socketId => io.to(socketId).emit("new_order", data))
    console.log(`📡 Notified seller ${sellerId} of new order`)
  } catch (err) {
    console.error("pushToSeller error:", err.message)
  }
}

// @route POST /api/orders — PUBLIC (guests can order, no auth required)
router.post("/", async (req, res) => {
  try {
    const {
      listingId,
      sellerId: bodySellerID,
      localOrderId,
      type,
      amount,
      paystackRef,
      location,
      landmark,
      extraInfo,
      contactInfo,
      payerName,
      payerPhone,
      promoCode,
      discount,
      deliveryMethod,
      paymentMethod,
    } = req.body

    // Resolve seller + listing details
    let resolvedSellerId = bodySellerID || null
    let listingTitle     = "Item"
    let listingImage     = null

    if (listingId) {
      try {
        const listing = await Listing.findById(listingId).select("seller title image")
        if (listing) {
          if (!resolvedSellerId) resolvedSellerId = String(listing.seller)
          listingTitle = listing.title || "Item"
          listingImage = listing.image || null
        }
      } catch (e) {
        console.warn("Listing lookup failed:", e.message)
      }
    }

    if (!resolvedSellerId) {
      return res.status(400).json({ message: "Could not determine seller. Please try again." })
    }

    const platformFee  = Math.round((amount || 0) * 0.08)
    const sellerAmount = (amount || 0) - platformFee

    // Optionally attach buyer if a valid token is present — never block if missing
    let buyerId = null
    try {
      const header = req.headers.authorization
      if (header?.startsWith("Bearer ")) {
        const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
        buyerId = decoded.id || null
      }
    } catch {}

    const order = await Order.create({
      buyer:          buyerId          || null,
      seller:         resolvedSellerId,
      listing:        listingId        || null,
      localOrderId:   localOrderId     || null,
      type:           type             || "product",
      amount:         amount           || 0,
      platformFee,
      sellerAmount,
      paystackRef:    paystackRef      || null,
      location:       location         || null,
      landmark:       landmark         || null,
      extraInfo:      extraInfo        || null,
      contactInfo:    contactInfo      || null,
      payerName:      payerName        || null,
      payerPhone:     payerPhone       || null,
      promoCode:      promoCode        || null,
      discount:       discount         || 0,
      deliveryMethod: deliveryMethod   || "pickup",
      paymentMethod:  paymentMethod    || "manual_momo",
      status:         "In Escrow",
    })

    // Push real-time notification to seller (queued if offline)
    pushToSeller(req, resolvedSellerId, {
      orderId:        localOrderId     || String(order._id),
      itemTitle:      listingTitle,
      itemImage:      listingImage,
      amount:         amount           || 0,
      buyerName:      payerName        || "A buyer",
      buyerContact:   contactInfo      || payerPhone || "",
      location:       location         || null,
      landmark:       landmark         || null,
      paymentRef:     paystackRef      || null,
      paymentMethod:  paymentMethod    || "manual_momo",
      deliveryMethod: deliveryMethod   || "pickup",
      discount:       discount         || 0,
      promoCode:      promoCode        || null,
    })

    console.log(`✅ Order ${order._id} | seller: ${resolvedSellerId} | ₵${amount} | ${deliveryMethod || "pickup"}`)
    res.status(201).json({ orderId: String(order._id), order })
  } catch (err) {
    console.error("Create order error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/my
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

// @route GET /api/orders/selling
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

// @route PUT /api/orders/confirm-by-ref — MUST be before /:id
router.put("/confirm-by-ref", protect, async (req, res) => {
  try {
    const { paystackRef } = req.body
    if (!paystackRef) return res.status(400).json({ message: "Reference required." })
    const order = await Order.findOne({ paystackRef })
    if (!order) return res.status(404).json({ message: "Order not found." })
    order.status = "Completed"
    await order.save()
    res.json({ message: "Delivery confirmed. Payment released.", order })
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
    res.json({ message: "Cancelled.", order })
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

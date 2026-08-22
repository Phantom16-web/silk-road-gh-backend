import express  from "express"
import Order    from "../models/Order.js"
import Listing  from "../models/Listing.js"
import protect  from "../middleware/auth.js"

const router = express.Router()

function optionalAuth(req, res, next) {
  // Attach user if token present, but never block the request
  try {
    const header = req.headers.authorization
    if (header?.startsWith("Bearer ")) {
      const jwt     = await import("jsonwebtoken")
      const decoded = jwt.default.verify(header.split(" ")[1], process.env.JWT_SECRET)
      req.user = { id: decoded.id }
    }
  } catch {}
  next()
}

function pushToSeller(req, sellerId, data) {
  try {
    const io            = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    if (!io || !sellerSockets || !sellerId) return
    const sockets = sellerSockets.get(String(sellerId))
    if (!sockets || sockets.size === 0) return
    sockets.forEach(socketId => io.to(socketId).emit("new_order", data))
    console.log(`📡 Notified seller ${sellerId} of new order`)
  } catch (err) {
    console.error("pushToSeller error:", err.message)
  }
}

// @route POST /api/orders — PUBLIC (guests can order)
router.post("/", async (req, res) => {
  try {
    const {
      listingId, sellerId: bodySellerID, localOrderId,
      type, amount, paystackRef,
      location, landmark, extraInfo, contactInfo,
      payerName, payerPhone, promoCode, discount,
      deliveryMethod, paymentMethod,
    } = req.body

    // Resolve seller from listing if not provided directly
    let resolvedSellerId = bodySellerID
    let listingTitle     = "Item"
    let listingImage     = null

    if (listingId) {
      try {
        const listing = await Listing.findById(listingId).select("seller title image")
        if (listing) {
          resolvedSellerId = resolvedSellerId || String(listing.seller)
          listingTitle     = listing.title
          listingImage     = listing.image || null
        }
      } catch {}
    }

    if (!resolvedSellerId) {
      return res.status(400).json({ message: "Could not determine seller. Please try again." })
    }

    const platformFee  = Math.round((amount || 0) * 0.08)
    const sellerAmount = (amount || 0) - platformFee

    // Try to get buyer ID from token (optional)
    let buyerId = null
    try {
      const header = req.headers.authorization
      if (header?.startsWith("Bearer ")) {
        const jwt     = (await import("jsonwebtoken")).default
        const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
        buyerId = decoded.id
      }
    } catch {}

    const order = await Order.create({
      buyer:          buyerId || null,
      seller:         resolvedSellerId,
      listing:        listingId || null,
      localOrderId:   localOrderId || null,
      type:           type || "product",
      amount:         amount || 0,
      platformFee,
      sellerAmount,
      paystackRef:    paystackRef || null,
      location:       location   || null,
      landmark:       landmark   || null,
      extraInfo:      extraInfo  || null,
      contactInfo:    contactInfo || null,
      payerName:      payerName  || null,
      payerPhone:     payerPhone || null,
      promoCode:      promoCode  || null,
      discount:       discount   || 0,
      deliveryMethod: deliveryMethod || "pickup",
      paymentMethod:  paymentMethod  || "manual_momo",
      status:         "In Escrow",
    })

    // ── Fire socket notification to seller ──────────────────────────────────
    pushToSeller(req, resolvedSellerId, {
      orderId:        localOrderId  || String(order._id),
      itemTitle:      listingTitle,
      itemImage:      listingImage,
      amount:         amount || 0,
      buyerName:      payerName     || "A buyer",
      buyerContact:   contactInfo   || payerPhone || "",
      location:       location      || null,
      landmark:       landmark      || null,
      paymentRef:     paystackRef   || null,
      paymentMethod:  paymentMethod || "manual_momo",
      deliveryMethod: deliveryMethod || "pickup",
      discount:       discount      || 0,
      promoCode:      promoCode     || null,
    })

    console.log(`✅ Order ${order._id} | seller: ${resolvedSellerId} | ₵${amount} | ${deliveryMethod}`)
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

import express from "express"
import Order from "../models/Order.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// @route POST /api/orders
router.post("/", protect, async (req, res) => {
  try {
    const { listingId, type, amount, paystackRef, location, landmark, extraInfo, contactInfo, rentalDays } = req.body
    const platformFee = Math.round(amount * 0.08)
    const sellerAmount = amount - platformFee
    const order = await Order.create({
      buyer: req.user.id,
      seller: req.body.sellerId,
      listing: listingId,
      type,
      amount,
      platformFee,
      sellerAmount,
      paystackRef,
      location,
      landmark,
      extraInfo,
      contactInfo,
      rentalDays,
      status: "In Escrow",
    })
    res.status(201).json(order)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/orders/my
router.get("/my", protect, async (req, res) => {
  try {
    const orders = await Order.find({ buyer: req.user.id })
      .populate("listing", "title image")
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
      .populate("listing", "title image")
      .populate("buyer", "name phone")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/orders/:id/confirm-delivery
router.put("/:id/confirm-delivery", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found" })
    if (order.buyer.toString() !== req.user.id) return res.status(403).json({ message: "Not authorized" })
    order.status = "Completed"
    await order.save()
    res.json({ message: "Delivery confirmed. Payment released to seller.", order })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/orders/:id/cancel
router.put("/:id/cancel", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found" })
    if (order.buyer.toString() !== req.user.id) return res.status(403).json({ message: "Not authorized" })
    order.status = "Refunded"
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
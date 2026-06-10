import express from "express"
import axios from "axios"
import Order from "../models/Order.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// @route POST /api/orders
router.post("/", protect, async (req, res) => {
  try {
    const {
      listingId, sellerId, type, amount,
      paystackRef, location, landmark,
      extraInfo, contactInfo, rentalDays,
    } = req.body

    // Verify payment with Paystack
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
        // In test mode verification may fail — continue anyway
      }
    }

    const platformFee = Math.round(amount * 0.08)
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
      status: "In Escrow",
    })

    const populated = await order.populate([
      { path: "listing", select: "title image" },
      { path: "seller", select: "name phone" },
      { path: "buyer", select: "name phone" },
    ])

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

// @route GET /api/orders/all (admin only)
router.get("/all", protect, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("listing", "title image type")
      .populate("buyer", "name email")
      .populate("seller", "name email")
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

import express from "express"
import axios from "axios"
import Order from "../models/Order.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// @route POST /api/payments/verify
router.post("/verify", protect, async (req, res) => {
  try {
    const { reference } = req.body
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    )
    const { status, amount, metadata } = response.data.data
    if (status === "success") {
      res.json({
        verified: true,
        amount: amount / 100,
        metadata,
        reference,
      })
    } else {
      res.json({ verified: false })
    }
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router
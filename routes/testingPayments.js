import express from "express"
import mongoose from "mongoose"
import Order from "../models/Order.js"
import Payment from "../models/Payment.js"
import { getEnvironmentMode } from "../models/Environment.js"
import {
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  logAction,
} from "../middleware/adminAuth.js"

const router = express.Router()

// Owner-only simulated funding for a TEST order. Never invokes a provider.
// Mount this router at /api/testing-payments after settlement safeguards are in place.
router.post(
  "/orders/:orderId/simulate",
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  async (req, res) => {
    try {
      if (process.env.ENABLE_ENVIRONMENT_SWITCH !== "true") {
        return res.status(503).json({
          message: "Testing operations have not been activated.",
          code: "TESTING_NOT_READY",
        })
      }

      if ((await getEnvironmentMode()) !== "testing") {
        return res.status(403).json({
          message: "Simulation is only available in Testing Mode.",
        })
      }

      const { orderId } = req.params
      if (!mongoose.isValidObjectId(orderId)) {
        return res.status(400).json({ message: "Invalid order ID." })
      }

      const order = await Order.findById(orderId)
      if (!order) {
        return res.status(404).json({ message: "Order not found." })
      }
      if (order.environment !== "testing") {
        return res.status(403).json({
          message: "Only orders created in Testing Mode can be simulated.",
        })
      }
      if (order.cancelled || order.fulfillmentStatus === "cancelled") {
        return res.status(409).json({ message: "This order was cancelled." })
      }
      if (order.paymentStatus !== "pending") {
        return res.status(409).json({
          message: "Only pending test orders can receive simulated payment.",
        })
      }

      // Refuse to simulate an order that already has a payment record.
      // A payment record could represent a real external transaction.
      const existingPayment = await Payment.exists({ order: order._id })
      if (existingPayment) {
        return res.status(409).json({
          message: "This order has a payment record and cannot be simulated.",
        })
      }

      const now = new Date()
      const updated = await Order.findOneAndUpdate(
        {
          _id: order._id,
          environment: "testing",
          paymentStatus: "pending",
          cancelled: { $ne: true },
          fulfillmentStatus: "pending_payment",
          isSimulatedPayment: { $ne: true },
        },
        {
          $set: {
            isSimulatedPayment: true,
            simulatedPaymentAt: now,
            simulatedPaymentBy: req.adminUser._id,
            paymentStatus: "escrow_held",
            fulfillmentStatus: "awaiting_delivery",
            status: "In Test Escrow",
            paymentVerifiedAt: null,
          },
        },
        { new: true, runValidators: true }
      )

      if (!updated) {
        return res.status(409).json({
          message: "The order changed. Refresh and try again.",
        })
      }

      await logAction(req, "test_payment_simulated", "order", String(updated._id), {
        environment: "testing",
        amount: updated.amount,
        simulated: true,
      })

      return res.json({
        message: "Test payment simulated. No real money was received.",
        simulated: true,
        order: updated,
      })
    } catch (error) {
      console.error("Simulated payment error:", error)
      return res.status(500).json({ message: "Unable to simulate payment." })
    }
  }
)

export default router

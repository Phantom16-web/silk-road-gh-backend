import express from "express"
import crypto from "crypto"

import Order from "../models/Order.js"
import Payment from "../models/Payment.js"

import protect from "../middleware/auth.js"

import {
  requireAdminAuth,
  requireAnyPermission,
  logAction,
} from "../middleware/adminAuth.js"

const router = express.Router()

/*
 * ---------------------------------------------------------
 * CREATE MANUAL PAYMENT
 * ---------------------------------------------------------
 *
 * Buyer starts a manual payment for an existing order.
 *
 * IMPORTANT:
 * The amount comes from the Order.
 * Never trust an amount supplied by the client.
 */

router.post("/manual/:orderId", protect, async (req, res) => {
  try {
    const { orderId } = req.params
    const {
      buyerReference = null,
      evidenceUrl = null,
      notes = null,
    } = req.body

    const order = await Order.findById(orderId)

    if (!order) {
      return res.status(404).json({
        message: "Order not found.",
      })
    }

    /*
     * Buyer must own the order.
     *
     * Guest orders are intentionally not allowed through
     * this authenticated endpoint. We can build a secure
     * guest-payment session separately.
     */
    if (!order.buyer || String(order.buyer) !== String(req.user.id)) {
      return res.status(403).json({
        message: "You are not authorized to pay for this order.",
      })
    }

    if (order.cancelled) {
      return res.status(400).json({
        message: "This order has been cancelled.",
      })
    }

    if (order.status === "Completed") {
      return res.status(400).json({
        message: "This order has already been completed.",
      })
    }

    const existingPayment = await Payment.findOne({
      order: order._id,
      status: {
        $in: ["submitted", "under_review", "verified"],
      },
    })

    if (existingPayment) {
      return res.status(409).json({
        message: "A payment already exists for this order.",
        payment: existingPayment,
      })
    }

    const payment = await Payment.create({
      order: order._id,
      buyer: req.user.id,
      method: "manual_momo",
      provider: "manual",
      status: "submitted",
      amount: order.amount,
      currency: "GHS",
      providerReference: `MANUAL-${order._id}-${crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase()}`,
      buyerReference,
      evidenceUrl,
      notes,
    })

    /*
     * IMPORTANT:
     *
     * The order is NOT put into escrow here.
     *
     * It remains awaiting payment verification.
     */

    order.paymentMethod = "manual_momo"
    order.status = "Pending Confirmation"

    await order.save()

    res.status(201).json({
      message:
        "Manual payment submitted. Your payment will be reviewed by Silk Road.",
      payment: {
        id: payment._id,
        orderId: order._id,
        reference: payment.providerReference,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
      },
      order,
    })
  } catch (err) {
    console.error("Manual payment submission error:", err)

    res.status(500).json({
      message: "Unable to submit manual payment.",
    })
  }
})

/*
 * ---------------------------------------------------------
 * GET PAYMENT FOR BUYER
 * ---------------------------------------------------------
 */

router.get("/:paymentId", protect, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId)

    if (!payment) {
      return res.status(404).json({
        message: "Payment not found.",
      })
    }

    if (!payment.buyer || String(payment.buyer) !== String(req.user.id)) {
      return res.status(403).json({
        message: "Not authorized to view this payment.",
      })
    }

    res.json({
      id: payment._id,
      order: payment.order,
      method: payment.method,
      provider: payment.provider,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      providerReference: payment.providerReference,
      buyerReference: payment.buyerReference,
      createdAt: payment.createdAt,
      verifiedAt: payment.verifiedAt,
    })
  } catch (err) {
    console.error("Get payment error:", err)

    res.status(500).json({
      message: "Unable to retrieve payment.",
    })
  }
})

/*
 * ---------------------------------------------------------
 * ADMIN VERIFY MANUAL PAYMENT
 * ---------------------------------------------------------
 *
 * This is the important transition:
 *
 * submitted
 *      ↓
 * under_review
 *      ↓
 * verified
 *      ↓
 * Order enters Silk Road escrow
 *
 * The buyer cannot perform this operation.
 * The seller cannot perform this operation.
 */

router.put(
  "/manual/:paymentId/verify",
  requireAdminAuth,
  requireAnyPermission("manage_payments", "view_payments"),
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({
          message: "Payment not found.",
        })
      }

      if (payment.provider !== "manual") {
        return res.status(400).json({
          message: "This is not a manual payment.",
        })
      }

      if (payment.status === "verified") {
        return res.status(409).json({
          message: "Payment has already been verified.",
        })
      }

      if (payment.status === "refunded") {
        return res.status(400).json({
          message: "A refunded payment cannot be verified.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(409).json({
          message:
            "Payment cannot be verified because its Order no longer exists.",
        })
      }

      /*
       * Prevent accidental verification of an order that has
       * already been cancelled or completed.
       */

      if (order.cancelled) {
        return res.status(400).json({
          message: "This order has already been cancelled.",
        })
      }

      if (order.status === "Completed") {
        return res.status(400).json({
          message: "This order has already been completed.",
        })
      }

      payment.status = "verified"
      payment.verifiedBy = req.adminUser._id
      payment.verifiedAt = new Date()

      await payment.save()

      /*
       * This is Silk Road's own escrow state.
       *
       * Paystack is NOT involved here.
       */

      order.status = "In Escrow"
      order.paymentMethod = "manual_momo"

      await order.save()

      await logAction(
        req,
        "manual_payment_verified",
        "payment",
        payment._id.toString(),
        {
          orderId: order._id.toString(),
          localOrderId: order.localOrderId,
          amount: payment.amount,
          provider: "manual",
        }
      )

      res.json({
        message: "Manual payment verified and order placed into escrow.",
        payment,
        order,
      })
    } catch (err) {
      console.error("Manual payment verification error:", err)

      res.status(500).json({
        message: "Unable to verify manual payment.",
      })
    }
  }
)

export default router

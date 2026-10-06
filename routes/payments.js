import express from "express"
import crypto from "crypto"

import Order from "../models/Order.js"
import Payment from "../models/Payment.js"
import User from "../models/User.js"

import protect from "../middleware/auth.js"

import {
  requireAdminAuth,
  requireAnyPermission,
  logAction,
} from "../middleware/adminAuth.js"

import {
  getPaymentProvider,
  PaymentProviderError,
} from "../services/paymentProviders.js"

const router = express.Router()

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function amountsMatch(a, b) {
  return (
    Math.round(Number(a) * 100) ===
    Math.round(Number(b) * 100)
  )
}

function paymentAlreadyExists(orderId) {
  return Payment.findOne({
    order: orderId,

    status: {
      $in: [
        "submitted",
        "under_review",
        "verified",
      ],
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL PAYMENT SUBMISSION
// POST /api/payments/manual/:orderId
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/manual/:orderId",
  protect,
  async (req, res) => {
    try {
      const {
        buyerReference = null,
        evidenceUrl = null,
        notes = null,
      } = req.body

      const order =
        await Order.findById(
          req.params.orderId
        )

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      if (
        !order.buyer ||
        String(order.buyer) !==
          String(req.user.id)
      ) {
        return res.status(403).json({
          message:
            "You are not authorized to pay for this order.",
        })
      }

      if (order.cancelled) {
        return res.status(400).json({
          message:
            "This order has been cancelled.",
        })
      }

      if (
        order.paymentStatus ===
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "This order has already been paid.",
        })
      }

      if (
        order.paymentStatus ===
        "released"
      ) {
        return res.status(400).json({
          message:
            "This order has already been settled.",
        })
      }

      const existing =
        await paymentAlreadyExists(
          order._id
        )

      if (existing) {
        return res.status(409).json({
          message:
            "A payment already exists for this order.",
          payment: {
            id: existing._id,
            status: existing.status,
            reference:
              existing.providerReference,
          },
        })
      }

      const provider =
        getPaymentProvider(
          "manual"
        )

      const generated =
        await provider.createPayment({
          order,
          amount: order.amount,
          currency: "GHS",
        })

      const payment =
        await Payment.create({
          order:
            order._id,

          buyer:
            req.user.id,

          method:
            "manual_momo",

          provider:
            "manual",

          status:
            "submitted",

          amount:
            order.amount,

          currency:
            "GHS",

          providerReference:
            generated.reference,

          buyerReference,

          evidenceUrl,

          notes,
        })

      order.paymentMethod =
        "manual_momo"

      order.paymentStatus =
        "pending"

      order.status =
        "Pending Confirmation"

      order.fulfillmentStatus =
        "pending_payment"

      await order.save()

      res.status(201).json({
        message:
          "Manual payment submitted. Awaiting Silk Road verification.",

        payment: {
          id:
            payment._id,

          reference:
            payment.providerReference,

          amount:
            payment.amount,

          currency:
            payment.currency,

          status:
            payment.status,
        },

        order,
      })
    } catch (err) {
      console.error(
        "Manual payment error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to submit manual payment.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// PAYSTACK INITIALIZE
// POST /api/payments/paystack/:orderId
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/paystack/:orderId",
  protect,
  async (req, res) => {
    try {
      const order =
        await Order.findById(
          req.params.orderId
        )

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      if (
        !order.buyer ||
        String(order.buyer) !==
          String(req.user.id)
      ) {
        return res.status(403).json({
          message:
            "You are not authorized to pay for this order.",
        })
      }

      if (order.cancelled) {
        return res.status(400).json({
          message:
            "This order has been cancelled.",
        })
      }

      if (
        order.paymentStatus ===
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "This order has already been paid.",
        })
      }

      const existing =
        await paymentAlreadyExists(
          order._id
        )

      if (
        existing &&
        existing.provider ===
          "paystack"
      ) {
        return res.status(409).json({
          message:
            "A Paystack payment already exists for this order.",
          reference:
            existing.providerReference,
          status:
            existing.status,
        })
      }

      const buyer =
        await User.findById(
          req.user.id
        ).select(
          "email name"
        )

      if (!buyer) {
        return res.status(404).json({
          message:
            "Buyer account not found.",
        })
      }

      const provider =
        getPaymentProvider(
          "paystack"
        )

      const result =
        await provider.createPayment({
          order,

          amount:
            order.amount,

          currency:
            "GHS",

          email:
            buyer.email,
        })

      const payment =
        await Payment.create({
          order:
            order._id,

          buyer:
            req.user.id,

          method:
            "paystack",

          provider:
            "paystack",

          status:
            "pending",

          amount:
            order.amount,

          currency:
            "GHS",

          providerReference:
            result.reference,
        })

      order.paymentMethod =
        "paystack"

      order.paystackRef =
        result.reference

      order.paymentStatus =
        "pending"

      order.status =
        "Pending Confirmation"

      order.fulfillmentStatus =
        "pending_payment"

      await order.save()

      res.status(201).json({
        message:
          "Paystack payment initialized.",

        payment: {
          id:
            payment._id,

          reference:
            result.reference,

          amount:
            payment.amount,

          currency:
            payment.currency,

          status:
            payment.status,
        },

        authorizationUrl:
          result.authorizationUrl,

        accessCode:
          result.accessCode,
      })
    } catch (err) {
      console.error(
        "Paystack initialization error:",
        err
      )

      if (
        err instanceof
        PaymentProviderError
      ) {
        return res.status(503).json({
          message:
            err.message,

          code:
            err.code,
        })
      }

      res.status(500).json({
        message:
          "Unable to initialize Paystack payment.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY PAYSTACK
// POST /api/payments/paystack/:paymentId/verify
//
// NEVER trust the frontend's "success" response.
// We ask Paystack's server directly.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/paystack/:paymentId/verify",
  protect,
  async (req, res) => {
    try {
      const payment =
        await Payment.findById(
          req.params.paymentId
        )

      if (!payment) {
        return res.status(404).json({
          message:
            "Payment not found.",
        })
      }

      if (
        !payment.buyer ||
        String(payment.buyer) !==
          String(req.user.id)
      ) {
        return res.status(403).json({
          message:
            "Not authorized.",
        })
      }

      if (
        payment.provider !==
        "paystack"
      ) {
        return res.status(400).json({
          message:
            "This is not a Paystack payment.",
        })
      }

      if (
        payment.status ===
        "verified"
      ) {
        return res.json({
          message:
            "Payment already verified.",

          payment,

          verified:
            true,
        })
      }

      const order =
        await Order.findById(
          payment.order
        )

      if (!order) {
        return res.status(409).json({
          message:
            "Associated order no longer exists.",
        })
      }

      const provider =
        getPaymentProvider(
          "paystack"
        )

      const result =
        await provider.verifyPayment(
          payment.providerReference
        )

      // ────────────────────────────────────────────────────────────────────
      // CRITICAL:
      //
      // Successful Paystack status is not enough.
      // Amount must match the Order.
      // ────────────────────────────────────────────────────────────────────

      if (!result.verified) {
        payment.status =
          result.status === "failed"
            ? "failed"
            : "pending"

        if (
          result.status ===
          "failed"
        ) {
          payment.failedAt =
            new Date()
        }

        await payment.save()

        return res.status(400).json({
          message:
            "Paystack payment has not been successfully completed.",

          status:
            result.status,
        })
      }

      if (
        !amountsMatch(
          result.amount,
          payment.amount
        )
      ) {
        payment.status =
          "failed"

        payment.failedAt =
          new Date()

        payment.notes =
          "Paystack amount mismatch detected."

        await payment.save()

        order.paymentStatus =
          "failed"

        await order.save()

        return res.status(400).json({
          message:
            "Payment amount does not match the order amount.",
        })
      }

      payment.status =
        "verified"

      payment.verifiedAt =
        new Date()

      await payment.save()

      order.paymentMethod =
        "paystack"

      order.paystackRef =
        result.reference

      order.paymentStatus =
        "escrow_held"

      order.paymentVerifiedAt =
        new Date()

      order.fulfillmentStatus =
        "awaiting_delivery"

      order.status =
        "In Escrow"

      await order.save()

      res.json({
        message:
          "Paystack payment verified and held in Silk Road escrow.",

        verified:
          true,

        payment,

        order,
      })
    } catch (err) {
      console.error(
        "Paystack verification error:",
        err
      )

      if (
        err instanceof
        PaymentProviderError
      ) {
        return res.status(503).json({
          message:
            err.message,

          code:
            err.code,
        })
      }

      res.status(500).json({
        message:
          "Unable to verify Paystack payment.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// GET PAYMENT
// GET /api/payments/:paymentId
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/:paymentId",
  protect,
  async (req, res) => {
    try {
      const payment =
        await Payment.findById(
          req.params.paymentId
        )

      if (!payment) {
        return res.status(404).json({
          message:
            "Payment not found.",
        })
      }

      if (
        !payment.buyer ||
        String(payment.buyer) !==
          String(req.user.id)
      ) {
        return res.status(403).json({
          message:
            "Not authorized.",
        })
      }

      res.json({
        id:
          payment._id,

        order:
          payment.order,

        method:
          payment.method,

        provider:
          payment.provider,

        status:
          payment.status,

        amount:
          payment.amount,

        currency:
          payment.currency,

        providerReference:
          payment.providerReference,

        buyerReference:
          payment.buyerReference,

        createdAt:
          payment.createdAt,

        verifiedAt:
          payment.verifiedAt,
      })
    } catch (err) {
      console.error(
        "Get payment error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to retrieve payment.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN VERIFY MANUAL PAYMENT
// PUT /api/payments/manual/:paymentId/verify
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/manual/:paymentId/verify",
  requireAdminAuth,
  requireAnyPermission(
    "manage_payments",
    "view_payments"
  ),
  async (req, res) => {
    try {
      const payment =
        await Payment.findById(
          req.params.paymentId
        )

      if (!payment) {
        return res.status(404).json({
          message:
            "Payment not found.",
        })
      }

      if (
        payment.provider !==
        "manual"
      ) {
        return res.status(400).json({
          message:
            "This is not a manual payment.",
        })
      }

      if (
        payment.status ===
        "verified"
      ) {
        return res.status(409).json({
          message:
            "Payment is already verified.",
        })
      }

      if (
        payment.status ===
        "refunded"
      ) {
        return res.status(400).json({
          message:
            "A refunded payment cannot be verified.",
        })
      }

      const order =
        await Order.findById(
          payment.order
        )

      if (!order) {
        return res.status(409).json({
          message:
            "Associated order no longer exists.",
        })
      }

      if (
        order.cancelled ||
        order.fulfillmentStatus ===
          "cancelled"
      ) {
        return res.status(400).json({
          message:
            "This order has been cancelled.",
        })
      }

      if (
        order.paymentStatus ===
        "escrow_held"
      ) {
        return res.status(409).json({
          message:
            "This order is already in escrow.",
        })
      }

      payment.status =
        "verified"

      payment.verifiedBy =
        req.adminUser._id

      payment.verifiedAt =
        new Date()

      await payment.save()

      order.paymentMethod =
        "manual_momo"

      order.paymentStatus =
        "escrow_held"

      order.paymentVerifiedAt =
        new Date()

      order.fulfillmentStatus =
        "awaiting_delivery"

      order.status =
        "In Escrow"

      await order.save()

      await logAction(
        req,
        "manual_payment_verified",
        "payment",
        payment._id.toString(),
        {
          orderId:
            order._id.toString(),

          localOrderId:
            order.localOrderId,

          amount:
            payment.amount,

          provider:
            "manual",
        }
      )

      res.json({
        message:
          "Manual payment verified and order placed into Silk Road escrow.",

        payment,

        order,
      })
    } catch (err) {
      console.error(
        "Manual verification error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to verify manual payment.",
      })
    }
  }
)

export default router

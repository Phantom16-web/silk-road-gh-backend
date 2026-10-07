import express from "express"

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

function isValidPaymentOrder(order) {
  if (!order) return false

  if (order.cancelled) return false

  if (
    order.fulfillmentStatus ===
    "cancelled"
  ) {
    return false
  }

  if (
    [
      "released",
      "refunded",
    ].includes(order.paymentStatus)
  ) {
    return false
  }

  return true
}

async function findActivePayment(orderId) {
  return Payment.findOne({
    order: orderId,

    status: {
      $in: [
        "pending",
        "submitted",
        "under_review",
        "verified",
      ],
    },
  }).sort({
    createdAt: -1,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL PAYMENT
//
// POST /api/payments/manual/:orderId
//
// This route NEVER contacts Paystack.
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

      if (
        !isValidPaymentOrder(
          order
        )
      ) {
        return res.status(400).json({
          message:
            "This order cannot accept another payment.",
        })
      }

      if (
        order.paymentStatus ===
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "This order is already in escrow.",
        })
      }

      const existing =
        await findActivePayment(
          order._id
        )

      if (existing) {
        return res.status(409).json({
          message:
            "A payment attempt already exists for this order.",

          payment: {
            id: existing._id,
            status:
              existing.status,

            reference:
              existing.providerReference,
          },
        })
      }

      // Manual provider does NOT depend on Paystack.
      const provider =
        getPaymentProvider(
          "manual"
        )

      const generated =
        await provider.createPayment({
          order,
          amount:
            order.amount,
          currency:
            "GHS",
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

      order.fulfillmentStatus =
        "pending_payment"

      order.status =
        "Pending Confirmation"

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
// PAYSTACK INITIALIZATION
//
// POST /api/payments/paystack/:orderId
//
// Paystack is OPTIONAL.
//
// Failure here does NOT affect manual payments.
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

      if (
        !isValidPaymentOrder(
          order
        )
      ) {
        return res.status(400).json({
          message:
            "This order cannot accept another payment.",
        })
      }

      if (
        order.paymentStatus ===
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "This order is already in escrow.",
        })
      }

      const existing =
        await findActivePayment(
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

          payment: {
            id:
              existing._id,

            reference:
              existing.providerReference,

            status:
              existing.status,
          },
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

      /*
       * ONLY THIS SECTION knows about Paystack.
       *
       * If Paystack throws an error, we return a provider error.
       * The order remains payable through manual payment.
       */

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

      order.fulfillmentStatus =
        "pending_payment"

      order.status =
        "Pending Confirmation"

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

          fallback:
            "manual_momo",
        })
      }

      res.status(500).json({
        message:
          "Unable to initialize Paystack payment.",

        fallback:
          "manual_momo",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY PAYSTACK PAYMENT
//
// POST /api/payments/paystack/:paymentId/verify
//
// NEVER trust frontend success.
// Backend verifies directly against provider.
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
        payment.status ===
        "verified"
      ) {
        return res.json({
          message:
            "Payment already verified.",

          verified:
            true,

          payment,

          order,
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

      // ─────────────────────────────────────────────────────────────────────
      // PROVIDER DID NOT CONFIRM PAYMENT
      // ─────────────────────────────────────────────────────────────────────

      if (!result.verified) {
        payment.status =
          result.status ===
          "failed"
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

        if (
          result.status ===
          "failed"
        ) {
          order.paymentStatus =
            "failed"

          await order.save()
        }

        return res.status(400).json({
          message:
            "Paystack payment has not been successfully completed.",

          status:
            result.status,
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // AMOUNT CHECK
      // ─────────────────────────────────────────────────────────────────────

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

      // ─────────────────────────────────────────────────────────────────────
      // CURRENCY CHECK
      // ─────────────────────────────────────────────────────────────────────

      if (
        result.currency &&
        String(
          result.currency
        ).toUpperCase() !==
          "GHS"
      ) {
        payment.status =
          "failed"

        payment.failedAt =
          new Date()

        payment.notes =
          "Unexpected payment currency."

        await payment.save()

        order.paymentStatus =
          "failed"

        await order.save()

        return res.status(400).json({
          message:
            "Payment currency does not match the Silk Road transaction.",
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // SUCCESS
      // ─────────────────────────────────────────────────────────────────────

      payment.status =
        "verified"

      payment.verifiedAt =
        new Date()

      payment.providerData =
        result.raw || null

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
//
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

        evidenceUrl:
          payment.evidenceUrl,

        notes:
          payment.notes,

        createdAt:
          payment.createdAt,

        verifiedAt:
          payment.verifiedAt,

        refundedAt:
          payment.refundedAt,
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
//
// PUT /api/payments/manual/:paymentId/verify
//
// This is what makes manual payments real.
//
// Admin verifies that the money was actually received.
// Only THEN does the order enter escrow.
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

      // Optional admin note
      if (req.body.notes) {
        payment.notes =
          req.body.notes
      }

      payment.status =
        "verified"

      payment.verifiedBy =
        req.adminUser._id

      payment.verifiedAt =
        new Date()

      await payment.save()

      // ─────────────────────────────────────────────────────────────────────
      // THIS IS THE ESCROW TRANSITION
      // ─────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN REJECT MANUAL PAYMENT
//
// PUT /api/payments/manual/:paymentId/reject
//
// Rejection does NOT mean refund.
// No money has been accepted into escrow.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/manual/:paymentId/reject",
  requireAdminAuth,
  requireAnyPermission(
    "manage_payments"
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
        return res.status(400).json({
          message:
            "A verified payment cannot be rejected. Use the refund/dispute process.",
        })
      }

      payment.status =
        "failed"

      payment.failedAt =
        new Date()

      payment.notes =
        req.body.reason ||
        payment.notes ||
        "Manual payment rejected."

      await payment.save()

      const order =
        await Order.findById(
          payment.order
        )

      if (order) {
        order.paymentStatus =
          "failed"

        order.fulfillmentStatus =
          "pending_payment"

        order.status =
          "Payment Failed"

        await order.save()
      }

      await logAction(
        req,
        "manual_payment_rejected",
        "payment",
        payment._id.toString(),
        {
          orderId:
            payment.order.toString(),

          reason:
            req.body.reason ||
            "",
        }
      )

      res.json({
        message:
          "Manual payment rejected.",

        payment,

        order,
      })
    } catch (err) {
      console.error(
        "Manual rejection error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to reject manual payment.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN REQUEST REFUND
//
// PUT /api/payments/:paymentId/refund-request
//
// This does NOT claim the buyer has received money.
//
// It creates:
// payment.status = refunded? NO.
//
// Order becomes:
// paymentStatus = refund_pending
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:paymentId/refund-request",
  requireAdminAuth,
  requireAnyPermission(
    "manage_payments",
    "manage_refunds",
    "issue_refund_decisions"
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

      const order =
        await Order.findById(
          payment.order
        )

      if (!order) {
        return res.status(404).json({
          message:
            "Associated order not found.",
        })
      }

      if (
        order.paymentStatus ===
        "refunded"
      ) {
        return res.status(400).json({
          message:
            "Order is already refunded.",
        })
      }

      if (
        order.paymentStatus ===
        "refund_pending"
      ) {
        return res.status(409).json({
          message:
            "Refund is already pending.",
        })
      }

      if (
        ![
          "escrow_held",
          "release_pending",
        ].includes(
          order.paymentStatus
        )
      ) {
        return res.status(400).json({
          message:
            `Order is not refundable from its current financial state: ${order.paymentStatus}.`,
        })
      }

      payment.refundRequestedAt =
        new Date()

      payment.refundRequestedBy =
        req.adminUser._id

      payment.refundReason =
        req.body.reason ||
        "Silk Road refund request."

      await payment.save()

      order.paymentStatus =
        "refund_pending"

      await order.save()

      await logAction(
        req,
        "refund_requested",
        "payment",
        payment._id.toString(),
        {
          orderId:
            order._id.toString(),

          localOrderId:
            order.localOrderId,

          amount:
            payment.amount,

          reason:
            payment.refundReason,
        }
      )

      res.json({
        message:
          "Refund marked as pending processing.",

        payment,

        order,
      })
    } catch (err) {
      console.error(
        "Refund request error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to request refund.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN COMPLETE REFUND
//
// PUT /api/payments/:paymentId/refund-complete
//
// This endpoint should ONLY be used after the actual money movement has
// happened.
//
// It is deliberately separate from refund-request.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:paymentId/refund-complete",
  requireAdminAuth,
  requireAnyPermission(
    "manage_refunds"
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

      const order =
        await Order.findById(
          payment.order
        )

      if (!order) {
        return res.status(404).json({
          message:
            "Associated order not found.",
        })
      }

      if (
        order.paymentStatus !==
        "refund_pending"
      ) {
        return res.status(400).json({
          message:
            "Order is not awaiting refund completion.",
        })
      }

      payment.status =
        "refunded"

      payment.refundedAt =
        new Date()

      payment.refundedBy =
        req.adminUser._id

      payment.refundReference =
        req.body.refundReference ||
        null

      await payment.save()

      order.paymentStatus =
        "refunded"

      order.refundedAt =
        new Date()

      order.fulfillmentStatus =
        "cancelled"

      order.cancelled =
        true

      if (
        !order.cancelledAt
      ) {
        order.cancelledAt =
          new Date()
      }

      order.status =
        "Refunded"

      await order.save()

      await logAction(
        req,
        "refund_completed",
        "payment",
        payment._id.toString(),
        {
          orderId:
            order._id.toString(),

          localOrderId:
            order.localOrderId,

          amount:
            payment.amount,

          refundReference:
            payment.refundReference,
        }
      )

      res.json({
        message:
          "Refund completed and transaction marked refunded.",

        payment,

        order,
      })
    } catch (err) {
      console.error(
        "Refund completion error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to complete refund.",
      })
    }
  }
)

export default router

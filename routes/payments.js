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

const CURRENCY = "GHS"

const ACTIVE_PAYMENT_STATUSES = [
  "pending",
  "submitted",
  "under_review",
  "verified",
]

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function amountsMatch(a, b) {
  const amountA = Number(a)
  const amountB = Number(b)

  return (
    Number.isFinite(amountA) &&
    Number.isFinite(amountB) &&
    Math.round(amountA * 100) === Math.round(amountB * 100)
  )
}

function isValidPaymentOrder(order) {
  if (!order || order.cancelled) return false

  if (order.fulfillmentStatus === "cancelled") {
    return false
  }

  return ![
    "released",
    "refunded",
    "refund_pending",
  ].includes(order.paymentStatus)
}

async function findActivePayment(orderId) {
  return Payment.findOne({
    order: orderId,
    status: {
      $in: ACTIVE_PAYMENT_STATUSES,
    },
  }).sort({ createdAt: -1 })
}

function paymentSummary(payment) {
  return {
    id: payment._id,
    reference: payment.providerReference,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
    method: payment.method,
  }
}

function isOwner(payment, userId) {
  return Boolean(
    payment?.buyer &&
    String(payment.buyer) === String(userId)
  )
}

// -----------------------------------------------------------------------------
// MANUAL PAYMENT
// POST /api/payments/manual/:orderId
//
// Manual Mobile Money must remain independent of Paystack availability.
// -----------------------------------------------------------------------------

router.post("/manual/:orderId", protect, async (req, res) => {
  try {
    const {
      buyerReference = null,
      evidenceUrl = null,
      notes = null,
    } = req.body || {}

    const order = await Order.findById(req.params.orderId)

    if (!order) {
      return res.status(404).json({
        message: "Order not found.",
      })
    }

    if (
      !order.buyer ||
      String(order.buyer) !== String(req.user.id)
    ) {
      return res.status(403).json({
        message: "You are not authorized to pay for this order.",
      })
    }

    if (!isValidPaymentOrder(order)) {
      return res.status(400).json({
        message: "This order cannot accept another payment.",
      })
    }

    if (order.paymentStatus === "escrow_held") {
      return res.status(409).json({
        message: "This order is already in escrow.",
      })
    }

    const existing = await findActivePayment(order._id)

    if (existing) {
      return res.status(409).json({
        message: "A payment attempt already exists for this order.",
        payment: paymentSummary(existing),
      })
    }

    const provider = getPaymentProvider("manual")

    const generated = await provider.createPayment({
      order,
      amount: order.amount,
      currency: CURRENCY,
    })

    const payment = await Payment.create({
      order: order._id,
      buyer: req.user.id,
      method: "manual_momo",
      provider: "manual",
      status: "submitted",
      amount: order.amount,
      currency: CURRENCY,
      providerReference: generated.reference,
      buyerReference,
      evidenceUrl,
      notes,
    })

    order.paymentMethod = "manual_momo"
    order.paymentStatus = "pending"
    order.fulfillmentStatus = "pending_payment"
    order.status = "Pending Confirmation"

    await order.save()

    return res.status(201).json({
      message:
        "Manual payment submitted. Awaiting Silk Road verification.",
      payment: paymentSummary(payment),
      order,
    })
  } catch (err) {
    console.error("Manual payment error:", err)

    return res.status(500).json({
      message: "Unable to submit manual payment.",
    })
  }
})

// -----------------------------------------------------------------------------
// PAYSTACK INITIALIZATION
// POST /api/payments/paystack/:orderId
//
// Paystack is optional. Failure here must not disable manual Mobile Money.
// -----------------------------------------------------------------------------

router.post("/paystack/:orderId", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)

    if (!order) {
      return res.status(404).json({
        message: "Order not found.",
      })
    }

    if (
      !order.buyer ||
      String(order.buyer) !== String(req.user.id)
    ) {
      return res.status(403).json({
        message: "You are not authorized to pay for this order.",
      })
    }

    if (!isValidPaymentOrder(order)) {
      return res.status(400).json({
        message: "This order cannot accept another payment.",
      })
    }

    if (order.paymentStatus === "escrow_held") {
      return res.status(409).json({
        message: "This order is already in escrow.",
      })
    }

    // Prevent simultaneous manual and Paystack attempts from competing.
    const existing = await findActivePayment(order._id)

    if (existing) {
      return res.status(409).json({
        message: "A payment attempt already exists for this order.",
        payment: paymentSummary(existing),
      })
    }

    const buyer = await User.findById(req.user.id)
      .select("email name")

    if (!buyer) {
      return res.status(404).json({
        message: "Buyer account not found.",
      })
    }

    const provider = getPaymentProvider("paystack")

    const result = await provider.createPayment({
      order,
      amount: order.amount,
      currency: CURRENCY,
      email: buyer.email,
    })

    const payment = await Payment.create({
      order: order._id,
      buyer: req.user.id,
      method: "paystack",
      provider: "paystack",
      status: "pending",
      amount: order.amount,
      currency: CURRENCY,
      providerReference: result.reference,
    })

    order.paymentMethod = "paystack"
    order.paystackRef = result.reference
    order.paymentStatus = "pending"
    order.fulfillmentStatus = "pending_payment"
    order.status = "Pending Confirmation"

    await order.save()

    return res.status(201).json({
      message: "Paystack payment initialized.",
      payment: paymentSummary(payment),
      authorizationUrl: result.authorizationUrl,
      accessCode: result.accessCode,
    })
  } catch (err) {
    console.error("Paystack initialization error:", err)

    if (err instanceof PaymentProviderError) {
      return res.status(503).json({
        message: err.message,
        code: err.code,
        fallback: "manual_momo",
      })
    }

    return res.status(500).json({
      message: "Unable to initialize Paystack payment.",
      fallback: "manual_momo",
    })
  }
})

// -----------------------------------------------------------------------------
// VERIFY PAYSTACK PAYMENT
// POST /api/payments/paystack/:paymentId/verify
//
// Never trust frontend success alone. Verify directly with the provider.
// -----------------------------------------------------------------------------

router.post(
  "/paystack/:paymentId/verify",
  protect,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({
          message: "Payment not found.",
        })
      }

      if (!isOwner(payment, req.user.id)) {
        return res.status(403).json({
          message: "Not authorized.",
        })
      }

      if (payment.provider !== "paystack") {
        return res.status(400).json({
          message: "This is not a Paystack payment.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(409).json({
          message: "Associated order no longer exists.",
        })
      }

      if (payment.status === "verified") {
        return res.json({
          message: "Payment already verified.",
          verified: true,
          payment,
          order,
        })
      }

      if (!isValidPaymentOrder(order)) {
        return res.status(409).json({
          message:
            "This order can no longer accept payment verification.",
        })
      }

      if (
        ["failed", "refunded"].includes(payment.status)
      ) {
        return res.status(409).json({
          message: "This payment attempt is no longer verifiable.",
          status: payment.status,
        })
      }

      const provider = getPaymentProvider("paystack")

      const result = await provider.verifyPayment(
        payment.providerReference
      )

      if (!result.verified) {
        payment.status =
          result.status === "failed" ? "failed" : "pending"

        if (result.status === "failed") {
          payment.failedAt = new Date()
        }

        await payment.save()

        if (
          result.status === "failed" &&
          order.paymentStatus === "pending" &&
          order.paystackRef === payment.providerReference
        ) {
          order.paymentStatus = "failed"
          await order.save()
        }

        return res.status(400).json({
          message:
            "Paystack payment has not been successfully completed.",
          status: result.status,
        })
      }

      // Confirm that the provider returned the same reference.
      const verifiedReference = String(result.reference || "")

      if (
        !verifiedReference ||
        verifiedReference !== String(payment.providerReference)
      ) {
        return res.status(400).json({
          message:
            "Paystack returned a mismatched payment reference.",
        })
      }

      // Validate the amount against the recorded payment.
      if (!amountsMatch(result.amount, payment.amount)) {
        payment.status = "failed"
        payment.failedAt = new Date()
        payment.notes =
          "Paystack amount mismatch detected."

        await payment.save()

        if (order.paymentStatus === "pending") {
          order.paymentStatus = "failed"
          await order.save()
        }

        return res.status(400).json({
          message:
            "Payment amount does not match the order amount.",
        })
      }

      // Missing currency is not accepted as proof of a GHS payment.
      if (
        String(result.currency || "").toUpperCase() !== CURRENCY
      ) {
        payment.status = "failed"
        payment.failedAt = new Date()
        payment.notes =
          "Missing or unexpected payment currency."

        await payment.save()

        if (order.paymentStatus === "pending") {
          order.paymentStatus = "failed"
          await order.save()
        }

        return res.status(400).json({
          message:
            "Payment currency does not match the Silk Road transaction.",
        })
      }

      // Prevent a late verification response from overwriting a
      // different payment attempt or a changed order state.
      if (
        order.paymentStatus !== "pending" ||
        order.paymentMethod !== "paystack" ||
        String(order.paystackRef || "") !==
          String(payment.providerReference)
      ) {
        return res.status(409).json({
          message:
            "The order's payment state has changed. Review it before proceeding.",
        })
      }

      payment.status = "verified"
      payment.verifiedAt = new Date()
      payment.providerData = result.raw || null

      await payment.save()

      order.paymentMethod = "paystack"
      order.paystackRef = result.reference
      order.paymentStatus = "escrow_held"
      order.paymentVerifiedAt = new Date()
      order.fulfillmentStatus = "awaiting_delivery"
      order.status = "In Escrow"

      await order.save()

      return res.json({
        message: "Paystack payment verified.",
        verified: true,
        payment,
        order,
      })
    } catch (err) {
      console.error("Paystack verification error:", err)

      if (err instanceof PaymentProviderError) {
        return res.status(503).json({
          message: err.message,
          code: err.code,
        })
      }

      return res.status(500).json({
        message: "Unable to verify Paystack payment.",
      })
    }
  }
)

// -----------------------------------------------------------------------------
// GET PAYMENT
// GET /api/payments/:paymentId
// -----------------------------------------------------------------------------

router.get("/:paymentId", protect, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId)

    if (!payment) {
      return res.status(404).json({
        message: "Payment not found.",
      })
    }

    if (!isOwner(payment, req.user.id)) {
      return res.status(403).json({
        message: "Not authorized.",
      })
    }

    return res.json({
      id: payment._id,
      order: payment.order,
      method: payment.method,
      provider: payment.provider,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      providerReference: payment.providerReference,
      buyerReference: payment.buyerReference,
      evidenceUrl: payment.evidenceUrl,
      notes: payment.notes,
      createdAt: payment.createdAt,
      verifiedAt: payment.verifiedAt,
      refundedAt: payment.refundedAt,
    })
  } catch (err) {
    console.error("Get payment error:", err)

    return res.status(500).json({
      message: "Unable to retrieve payment.",
    })
  }
})

// -----------------------------------------------------------------------------
// ADMIN VERIFY MANUAL PAYMENT
// PUT /api/payments/manual/:paymentId/verify
//
// Viewing payments alone must not grant permission to verify payment.
// -----------------------------------------------------------------------------

router.put(
  "/manual/:paymentId/verify",
  requireAdminAuth,
  requireAnyPermission("manage_payments"),
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
          message: "Payment is already verified.",
        })
      }

      if (
        ["failed", "refunded"].includes(payment.status)
      ) {
        return res.status(400).json({
          message:
            "A failed or refunded payment cannot be verified.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(409).json({
          message: "Associated order no longer exists.",
        })
      }

      if (!isValidPaymentOrder(order)) {
        return res.status(400).json({
          message:
            "This order has been cancelled or is no longer payable.",
        })
      }

      if (order.paymentStatus === "escrow_held") {
        return res.status(409).json({
          message: "This order is already in escrow.",
        })
      }

      const activePayment = await findActivePayment(order._id)

      if (
        activePayment &&
        String(activePayment._id) !== String(payment._id)
      ) {
        return res.status(409).json({
          message:
            "Another active payment attempt exists for this order.",
        })
      }

      if (order.paymentMethod !== "manual_momo") {
        return res.status(409).json({
          message:
            "The order is not currently assigned to manual MoMo.",
        })
      }

      if (req.body?.notes) {
        payment.notes = req.body.notes
      }

      payment.status = "verified"
      payment.verifiedBy = req.adminUser._id
      payment.verifiedAt = new Date()

      await payment.save()

      order.paymentMethod = "manual_momo"
      order.paymentStatus = "escrow_held"
      order.paymentVerifiedAt = new Date()
      order.fulfillmentStatus = "awaiting_delivery"
      order.status = "In Escrow"

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

      return res.json({
        message: "Manual payment verified.",
        payment,
        order,
      })
    } catch (err) {
      console.error("Manual verification error:", err)

      return res.status(500).json({
        message: "Unable to verify manual payment.",
      })
    }
  }
)

// -----------------------------------------------------------------------------
// ADMIN REJECT MANUAL PAYMENT
// PUT /api/payments/manual/:paymentId/reject
//
// Rejecting a payment does not mean a refund has been made.
// -----------------------------------------------------------------------------

router.put(
  "/manual/:paymentId/reject",
  requireAdminAuth,
  requireAnyPermission("manage_payments"),
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
        return res.status(400).json({
          message:
            "A verified payment cannot be rejected. Use the refund/dispute process.",
        })
      }

      if (
        ["failed", "refunded"].includes(payment.status)
      ) {
        return res.status(409).json({
          message:
            "This payment has already been rejected or refunded.",
        })
      }

      const order = await Order.findById(payment.order)

      if (
        order &&
        [
          "escrow_held",
          "release_pending",
          "released",
        ].includes(order.paymentStatus)
      ) {
        return res.status(409).json({
          message:
            "This order has already advanced beyond payment review.",
        })
      }

      payment.status = "failed"
      payment.failedAt = new Date()
      payment.notes =
        req.body?.reason ||
        payment.notes ||
        "Manual payment rejected."

      await payment.save()

      if (order && order.paymentStatus === "pending") {
        order.paymentStatus = "failed"
        order.fulfillmentStatus = "pending_payment"
        order.status = "Payment Failed"

        await order.save()
      }

      await logAction(
        req,
        "manual_payment_rejected",
        "payment",
        payment._id.toString(),
        {
          orderId: payment.order.toString(),
          reason: req.body?.reason || "",
        }
      )

      return res.json({
        message: "Manual payment rejected.",
        payment,
        order,
      })
    } catch (err) {
      console.error("Manual rejection error:", err)

      return res.status(500).json({
        message: "Unable to reject manual payment.",
      })
    }
  }
)

// -----------------------------------------------------------------------------
// ADMIN REQUEST REFUND
// PUT /api/payments/:paymentId/refund-request
//
// This marks a refund as pending. It does not claim the money was returned.
// -----------------------------------------------------------------------------

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
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({
          message: "Payment not found.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(404).json({
          message: "Associated order not found.",
        })
      }

      if (order.paymentStatus === "refunded") {
        return res.status(400).json({
          message: "Order is already refunded.",
        })
      }

      if (order.paymentStatus === "refund_pending") {
        return res.status(409).json({
          message: "Refund is already pending.",
        })
      }

      if (
        !["escrow_held", "release_pending"].includes(
          order.paymentStatus
        )
      ) {
        return res.status(400).json({
          message:
            `Order is not refundable from its current financial state: ${order.paymentStatus}.`,
        })
      }

      payment.refundRequestedAt = new Date()
      payment.refundRequestedBy = req.adminUser._id
      payment.refundReason =
        req.body?.reason || "Silk Road refund request."

      await payment.save()

      order.paymentStatus = "refund_pending"

      await order.save()

      await logAction(
        req,
        "refund_requested",
        "payment",
        payment._id.toString(),
        {
          orderId: order._id.toString(),
          localOrderId: order.localOrderId,
          amount: payment.amount,
          reason: payment.refundReason,
        }
      )

      return res.json({
        message: "Refund marked as pending processing.",
        payment,
        order,
      })
    } catch (err) {
      console.error("Refund request error:", err)

      return res.status(500).json({
        message: "Unable to request refund.",
      })
    }
  }
)

// -----------------------------------------------------------------------------
// ADMIN COMPLETE REFUND
// PUT /api/payments/:paymentId/refund-complete
//
// Use only after the actual money movement has happened.
// -----------------------------------------------------------------------------

router.put(
  "/:paymentId/refund-complete",
  requireAdminAuth,
  requireAnyPermission("manage_refunds"),
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({
          message: "Payment not found.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(404).json({
          message: "Associated order not found.",
        })
      }

      if (order.paymentStatus !== "refund_pending") {
        return res.status(400).json({
          message: "Order is not awaiting refund completion.",
        })
      }

      if (payment.status === "refunded") {
        return res.status(409).json({
          message: "Payment is already marked as refunded.",
        })
      }

      const refundReference = String(
        req.body?.refundReference || ""
      ).trim()

      if (!refundReference) {
        return res.status(400).json({
          message:
            "Provide the actual refund reference before completing the refund.",
        })
      }

      payment.status = "refunded"
      payment.refundedAt = new Date()
      payment.refundedBy = req.adminUser._id
      payment.refundReference = refundReference

      await payment.save()

      order.paymentStatus = "refunded"
      order.refundedAt = new Date()
      order.fulfillmentStatus = "cancelled"
      order.cancelled = true

      if (!order.cancelledAt) {
        order.cancelledAt = new Date()
      }

      order.status = "Refunded"

      await order.save()

      await logAction(
        req,
        "refund_completed",
        "payment",
        payment._id.toString(),
        {
          orderId: order._id.toString(),
          localOrderId: order.localOrderId,
          amount: payment.amount,
          refundReference: payment.refundReference,
        }
      )

      return res.json({
        message: "Refund marked completed.",
        payment,
        order,
      })
    } catch (err) {
      console.error("Refund completion error:", err)

      return res.status(500).json({
        message: "Unable to complete refund.",
      })
    }
  }
)

export default router

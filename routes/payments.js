import { assertRentalReservationForOrder } from "../services/rentalReservation.js";

import express from "express"

import Order from "../models/Order.js"
import { requireLiveMode } from "../middleware/environment.js"
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
]

const TERMINAL_PAYMENT_STATUSES = [
  "verified",
  "failed",
  "refunded",
]

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

  if (order.fulfillmentStatus === "cancelled") return false

  return ![
    "released",
    "refunded",
    "refund_pending",
    "release_pending",
    "disputed",
  ].includes(order.paymentStatus)
}

async function findActivePayment(orderId) {
  return Payment.findOne({
    order: orderId,
    status: { $in: ACTIVE_PAYMENT_STATUSES },
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

function safePaymentResponse(payment) {
  return {
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
  }
}

function safeOrderResponse(order) {
  return {
    id: order._id,
    localOrderId: order.localOrderId,
    amount: order.amount,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    environment: order.environment || "live",
    fulfillmentStatus: order.fulfillmentStatus,
    status: order.status,
  }
}

async function claimPaymentVerification(payment) {
  return Payment.findOneAndUpdate(
    {
      _id: payment._id,
      status: { $in: ACTIVE_PAYMENT_STATUSES },
    },
    {
      $set: {
        status: "under_review",
        verificationStartedAt: new Date(),
      },
    },
    { new: true }
  )
}

async function restorePaymentAfterVerificationFailure(paymentId) {
  await Payment.updateOne(
    {
      _id: paymentId,
      status: "under_review",
    },
    {
      $set: { status: "pending" },
      $unset: { verificationStartedAt: 1 },
    }
  )
}

// -----------------------------------------------------------------------------
// MANUAL PAYMENT
// POST /api/payments/manual/:orderId
// Manual Mobile Money remains independent of Paystack availability.
// -----------------------------------------------------------------------------

router.post("/manual/:orderId", protect, requireLiveMode, async (req, res) => {
  try {
    const {
      buyerReference = null,
      evidenceUrl = null,
      notes = null,
    } = req.body || {}

    const order = await Order.findById(req.params.orderId)

    if (!order) {
      return res.status(404).json({ message: "Order not found." })
    }
    await assertRentalReservationForOrder(order)


    if (order.environment === "testing" || order.isSimulatedPayment) {


      return res.status(403).json({


        message: "Test orders cannot use real payment or refund operations.",


        code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


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

    const claimedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        environment: { $ne: "testing" },
        isSimulatedPayment: { $ne: true },
        buyer: req.user.id,
        paymentStatus: { $in: ["pending", "failed"] },
        cancelled: { $ne: true },
      },
      {
        $set: {
          paymentMethod: "manual_momo",
          paymentStatus: "pending",
          fulfillmentStatus: "pending_payment",
          status: "Pending Confirmation",
        },
      },
      { new: true }
    )

    if (!claimedOrder) {
      return res.status(409).json({
        message: "The order changed. Refresh and try again.",
      })
    }

    const provider = getPaymentProvider("manual")

    const generated = await provider.createPayment({
      order: claimedOrder,
      amount: claimedOrder.amount,
      currency: CURRENCY,
    })

    const payment = await Payment.create({
      order: claimedOrder._id,
      buyer: req.user.id,
      method: "manual_momo",
      provider: "manual",
      status: "submitted",
      amount: claimedOrder.amount,
      currency: CURRENCY,
      providerReference: generated.reference,
      buyerReference,
      evidenceUrl,
      notes,
    })

    return res.status(201).json({
      message:
        "Manual payment submitted. Awaiting Silk Road verification.",
      payment: paymentSummary(payment),
      order: safeOrderResponse(claimedOrder),
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
// Paystack is optional. Manual Mobile Money must remain available.
// -----------------------------------------------------------------------------

router.post("/paystack/:orderId", protect, requireLiveMode, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)

    if (!order) {
      return res.status(404).json({ message: "Order not found." })
    }
    await assertRentalReservationForOrder(order)


    if (order.environment === "testing" || order.isSimulatedPayment) {


      return res.status(403).json({


        message: "Test orders cannot use real payment or refund operations.",


        code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


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

    const existing = await findActivePayment(order._id)

    if (existing) {
      return res.status(409).json({
        message: "A payment attempt already exists for this order.",
        payment: paymentSummary(existing),
      })
    }

    const claimedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        environment: { $ne: "testing" },
        isSimulatedPayment: { $ne: true },
        buyer: req.user.id,
        paymentStatus: { $in: ["pending", "failed"] },
        cancelled: { $ne: true },
      },
      {
        $set: {
          paymentMethod: "paystack",
          paymentStatus: "pending",
          fulfillmentStatus: "pending_payment",
          status: "Pending Confirmation",
        },
      },
      { new: true }
    )

    if (!claimedOrder) {
      return res.status(409).json({
        message: "The order changed. Refresh and try again.",
      })
    }

    const buyer = await User.findById(req.user.id).select("email name")

    if (!buyer) {
      return res.status(404).json({
        message: "Buyer account not found.",
      })
    }

    const provider = getPaymentProvider("paystack")

    const result = await provider.createPayment({
      order: claimedOrder,
      amount: claimedOrder.amount,
      currency: CURRENCY,
      email: buyer.email,
    })

    const payment = await Payment.create({
      order: claimedOrder._id,
      buyer: req.user.id,
      method: "paystack",
      provider: "paystack",
      status: "pending",
      amount: claimedOrder.amount,
      currency: CURRENCY,
      providerReference: result.reference,
    })

    const updatedOrder = await Order.findOneAndUpdate(
      {
        _id: claimedOrder._id,
        environment: { $ne: "testing" },
        isSimulatedPayment: { $ne: true },
        buyer: req.user.id,
        paymentStatus: "pending",
        paymentMethod: "paystack",
        paystackRef: { $in: [null, ""] },
      },
      { $set: { paystackRef: result.reference } },
      { new: true }
    )

    if (!updatedOrder) {
      return res.status(409).json({
        message:
          "Payment was initialized but the order changed. Contact support before retrying.",
        payment: paymentSummary(payment),
      })
    }

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
// Verify directly with Paystack; never trust frontend success alone.
// -----------------------------------------------------------------------------

router.post(
  "/paystack/:paymentId/verify",
  protect,
  requireLiveMode,
  async (req, res) => {
    let claimedPaymentId = null

    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({ message: "Payment not found." })
      }

      if (!isOwner(payment, req.user.id)) {
        return res.status(403).json({ message: "Not authorized." })
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


      if (order.environment === "testing" || order.isSimulatedPayment) {


        return res.status(403).json({


          message: "Test orders cannot use real payment or refund operations.",


          code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


        })


      }


      if (
        payment.status === "verified" &&
        order.paymentStatus === "escrow_held" &&
        String(order.paystackRef || "") ===
          String(payment.providerReference)
      ) {
        return res.json({
          message: "Payment already verified.",
          verified: true,
          payment: safePaymentResponse(payment),
          order: safeOrderResponse(order),
        })
      }

      if (!isValidPaymentOrder(order)) {
        return res.status(409).json({
          message: "This order can no longer accept payment verification.",
        })
      }

      if (
        !ACTIVE_PAYMENT_STATUSES.includes(payment.status) ||
        order.paymentStatus !== "pending" ||
        order.paymentMethod !== "paystack" ||
        String(order.paystackRef || "") !==
          String(payment.providerReference)
      ) {
        return res.status(409).json({
          message: "The payment or order state has changed.",
        })
      }

      const claimedPayment = await claimPaymentVerification(payment)

      if (!claimedPayment) {
        const current = await Payment.findById(payment._id)

        if (
          current?.status === "verified" &&
          order.paymentStatus === "escrow_held"
        ) {
          return res.json({
            message: "Payment already verified.",
            verified: true,
            payment: safePaymentResponse(current),
            order: safeOrderResponse(order),
          })
        }

        return res.status(409).json({
          message: "This payment is already being processed.",
        })
      }

      claimedPaymentId = claimedPayment._id

      const provider = getPaymentProvider("paystack")
      const result = await provider.verifyPayment(
        claimedPayment.providerReference
      )

      if (!result.verified) {
        const failed = result.status === "failed"

        await Payment.updateOne(
          { _id: claimedPayment._id, status: "under_review" },
          {
            $set: {
              status: failed ? "failed" : "pending",
              ...(failed ? { failedAt: new Date() } : {}),
            },
            $unset: { verificationStartedAt: 1 },
          }
        )

        if (failed) {
          await Order.updateOne(
            {
              _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
              paymentStatus: "pending",
              paymentMethod: "paystack",
              paystackRef: claimedPayment.providerReference,
            },
            { $set: { paymentStatus: "failed" } }
          )
        }

        claimedPaymentId = null

        return res.status(400).json({
          message: "Paystack payment has not been successfully completed.",
          status: result.status,
        })
      }

      if (
        String(result.reference || "") !==
        String(claimedPayment.providerReference)
      ) {
        await restorePaymentAfterVerificationFailure(claimedPayment._id)
        claimedPaymentId = null

        return res.status(400).json({
          message: "Paystack returned a mismatched payment reference.",
        })
      }

      if (!amountsMatch(result.amount, claimedPayment.amount)) {
        await Payment.updateOne(
          { _id: claimedPayment._id, status: "under_review" },
          {
            $set: {
              status: "failed",
              failedAt: new Date(),
              notes: "Paystack amount mismatch detected.",
            },
            $unset: { verificationStartedAt: 1 },
          }
        )

        await Order.updateOne(
          {
            _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
            paymentStatus: "pending",
            paymentMethod: "paystack",
            paystackRef: claimedPayment.providerReference,
          },
          { $set: { paymentStatus: "failed" } }
        )

        claimedPaymentId = null

        return res.status(400).json({
          message: "Payment amount does not match the recorded payment.",
        })
      }

      if (String(result.currency || "").toUpperCase() !== CURRENCY) {
        await Payment.updateOne(
          { _id: claimedPayment._id, status: "under_review" },
          {
            $set: {
              status: "failed",
              failedAt: new Date(),
              notes: "Missing or unexpected payment currency.",
            },
            $unset: { verificationStartedAt: 1 },
          }
        )

        await Order.updateOne(
          {
            _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
            paymentStatus: "pending",
            paymentMethod: "paystack",
            paystackRef: claimedPayment.providerReference,
          },
          { $set: { paymentStatus: "failed" } }
        )

        claimedPaymentId = null

        return res.status(400).json({
          message: "Payment currency does not match the Silk Road transaction.",
        })
      }

      // Atomically claim the order's transition into escrow.
      const escrowOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
          paymentStatus: "pending",
          paymentMethod: "paystack",
          paystackRef: claimedPayment.providerReference,
          cancelled: { $ne: true },
        },
        {
          $set: {
            paymentStatus: "escrow_held",
            paymentVerifiedAt: new Date(),
            fulfillmentStatus: "awaiting_delivery",
            status: "In Escrow",
          },
        },
        { new: true }
      )

      if (!escrowOrder) {
        await restorePaymentAfterVerificationFailure(claimedPayment._id)
        claimedPaymentId = null

        return res.status(409).json({
          message:
            "The order changed during verification. Contact support before retrying.",
        })
      }

      const verifiedPayment = await Payment.findOneAndUpdate(
        {
          _id: claimedPayment._id,
          status: "under_review",
        },
        {
          $set: {
            status: "verified",
            verifiedAt: new Date(),
            providerData: result.raw || null,
          },
          $unset: { verificationStartedAt: 1 },
        },
        { new: true }
      )

      claimedPaymentId = null

      if (!verifiedPayment) {
        console.error(
          "CRITICAL: order entered escrow but payment record did not transition",
          String(order._id),
          String(claimedPayment._id)
        )

        return res.status(500).json({
          message:
            "Payment was confirmed but requires reconciliation. Contact support and do not pay again.",
          code: "PAYMENT_RECONCILIATION_REQUIRED",
        })
      }

      return res.json({
        message: "Paystack payment verified.",
        verified: true,
        payment: safePaymentResponse(verifiedPayment),
        order: safeOrderResponse(escrowOrder),
      })
    } catch (err) {
      if (claimedPaymentId) {
        await restorePaymentAfterVerificationFailure(claimedPaymentId)
          .catch((restoreError) => {
            console.error(
              "Failed to restore payment verification state:",
              restoreError
            )
          })
      }

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
      return res.status(404).json({ message: "Payment not found." })
    }

    if (!isOwner(payment, req.user.id)) {
      return res.status(403).json({ message: "Not authorized." })
    }

    return res.json(safePaymentResponse(payment))
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
// -----------------------------------------------------------------------------

router.put(
  "/manual/:paymentId/verify",
  requireAdminAuth,
  requireAnyPermission("manage_payments"),
  requireLiveMode,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({ message: "Payment not found." })
      }

      if (payment.provider !== "manual") {
        return res.status(400).json({
          message: "This is not a manual payment.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(409).json({
          message: "Associated order no longer exists.",
        })
      }


      if (order.environment === "testing" || order.isSimulatedPayment) {


        return res.status(403).json({


          message: "Test orders cannot use real payment or refund operations.",


          code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


        })


      }


      if (
        payment.status === "verified" &&
        order.paymentStatus === "escrow_held"
      ) {
        return res.status(409).json({
          message: "Payment is already verified.",
        })
      }

      if (!ACTIVE_PAYMENT_STATUSES.includes(payment.status)) {
        return res.status(409).json({
          message: "This payment is no longer awaiting verification.",
        })
      }

      if (!isValidPaymentOrder(order)) {
        return res.status(400).json({
          message: "This order is cancelled or no longer payable.",
        })
      }

      if (
        order.paymentStatus !== "pending" ||
        order.paymentMethod !== "manual_momo"
      ) {
        return res.status(409).json({
          message: "The order is not awaiting manual MoMo verification.",
        })
      }

      const activePayment = await findActivePayment(order._id)

      if (
        activePayment &&
        String(activePayment._id) !== String(payment._id)
      ) {
        return res.status(409).json({
          message: "Another active payment attempt exists for this order.",
        })
      }

      // Claim the order first so only one admin can move it into escrow.
      const escrowOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
          paymentStatus: "pending",
          paymentMethod: "manual_momo",
          cancelled: { $ne: true },
        },
        {
          $set: {
            paymentStatus: "escrow_held",
            paymentVerifiedAt: new Date(),
            fulfillmentStatus: "awaiting_delivery",
            status: "In Escrow",
          },
        },
        { new: true }
      )

      if (!escrowOrder) {
        return res.status(409).json({
          message: "The order has already changed. Refresh and review it.",
        })
      }

      const verifiedPayment = await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          provider: "manual",
          status: { $in: ACTIVE_PAYMENT_STATUSES },
        },
        {
          $set: {
            status: "verified",
            verifiedBy: req.adminUser._id,
            verifiedAt: new Date(),
            ...(req.body?.notes ? { notes: req.body.notes } : {}),
          },
        },
        { new: true }
      )

      if (!verifiedPayment) {
        console.error(
          "CRITICAL: manual payment order entered escrow but payment record did not transition",
          String(order._id),
          String(payment._id)
        )

        return res.status(500).json({
          message:
            "Order state changed but payment needs reconciliation. Contact support.",
          code: "PAYMENT_RECONCILIATION_REQUIRED",
        })
      }

      await logAction(
        req,
        "manual_payment_verified",
        "payment",
        verifiedPayment._id.toString(),
        {
          orderId: escrowOrder._id.toString(),
          localOrderId: escrowOrder.localOrderId,
          amount: verifiedPayment.amount,
          provider: "manual",
        }
      )

      return res.json({
        message: "Manual payment verified.",
        payment: safePaymentResponse(verifiedPayment),
        order: safeOrderResponse(escrowOrder),
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
// -----------------------------------------------------------------------------

router.put(
  "/manual/:paymentId/reject",
  requireAdminAuth,
  requireAnyPermission("manage_payments"),
  requireLiveMode,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({ message: "Payment not found." })
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

      if (["failed", "refunded"].includes(payment.status)) {
        return res.status(409).json({
          message: "This payment has already been rejected or refunded.",
        })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(409).json({
          message: "Associated order no longer exists.",
        })
      }


      if (order.environment === "testing" || order.isSimulatedPayment) {


        return res.status(403).json({


          message: "Test orders cannot use real payment or refund operations.",


          code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


        })


      }


      if (
        !ACTIVE_PAYMENT_STATUSES.includes(payment.status) ||
        order.paymentStatus !== "pending" ||
        order.paymentMethod !== "manual_momo"
      ) {
        return res.status(409).json({
          message: "The payment or order has already advanced.",
        })
      }

      const rejectedPayment = await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          provider: "manual",
          status: { $in: ACTIVE_PAYMENT_STATUSES },
        },
        {
          $set: {
            status: "failed",
            failedAt: new Date(),
            notes:
              req.body?.reason ||
              payment.notes ||
              "Manual payment rejected.",
          },
        },
        { new: true }
      )

      if (!rejectedPayment) {
        return res.status(409).json({
          message: "This payment was already processed.",
        })
      }

      await Order.updateOne(
        {
          _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
          paymentStatus: "pending",
          paymentMethod: "manual_momo",
        },
        {
          $set: {
            paymentStatus: "failed",
            fulfillmentStatus: "pending_payment",
            status: "Payment Failed",
          },
        }
      )

      await logAction(
        req,
        "manual_payment_rejected",
        "payment",
        rejectedPayment._id.toString(),
        {
          orderId: order._id.toString(),
          reason: req.body?.reason || "",
        }
      )

      return res.json({
        message: "Manual payment rejected.",
        payment: safePaymentResponse(rejectedPayment),
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
// Marks a refund as pending; it does not claim money has been returned.
// -----------------------------------------------------------------------------

router.put(
  "/:paymentId/refund-request",
  requireAdminAuth,
  requireAnyPermission(
    "manage_payments",
    "manage_refunds",
    "issue_refund_decisions"
  ),
  requireLiveMode,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({ message: "Payment not found." })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(404).json({
          message: "Associated order not found.",
        })
      }


      if (order.environment === "testing" || order.isSimulatedPayment) {


        return res.status(403).json({


          message: "Test orders cannot use real payment or refund operations.",


          code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


        })


      }


      if (order.paymentStatus === "refunded") {
        return res.status(409).json({
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
          message: `Order is not refundable from its current financial state: ${order.paymentStatus}.`,
        })
      }

      const claimedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
          paymentStatus: order.paymentStatus,
        },
        { $set: { paymentStatus: "refund_pending" } },
        { new: true }
      )

      if (!claimedOrder) {
        return res.status(409).json({
          message: "The order changed. Refresh and review it.",
        })
      }

      const updatedPayment = await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          status: { $ne: "refunded" },
        },
        {
          $set: {
            refundRequestedAt: new Date(),
            refundRequestedBy: req.adminUser._id,
            refundReason:
              req.body?.reason || "Silk Road refund request.",
          },
        },
        { new: true }
      )

      if (!updatedPayment) {
        return res.status(409).json({
          message:
            "Order is marked refund-pending but payment needs reconciliation.",
          code: "REFUND_RECONCILIATION_REQUIRED",
        })
      }

      await logAction(
        req,
        "refund_requested",
        "payment",
        updatedPayment._id.toString(),
        {
          orderId: claimedOrder._id.toString(),
          localOrderId: claimedOrder.localOrderId,
          amount: updatedPayment.amount,
          reason: updatedPayment.refundReason,
        }
      )

      return res.json({
        message: "Refund marked as pending processing.",
        payment: safePaymentResponse(updatedPayment),
        order: safeOrderResponse(claimedOrder),
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
// Use only after the actual money movement has happened.
// -----------------------------------------------------------------------------

router.put(
  "/:paymentId/refund-complete",
  requireAdminAuth,
  requireAnyPermission("manage_refunds"),
  requireLiveMode,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.paymentId)

      if (!payment) {
        return res.status(404).json({ message: "Payment not found." })
      }

      const order = await Order.findById(payment.order)

      if (!order) {
        return res.status(404).json({
          message: "Associated order not found.",
        })
      }


      if (order.environment === "testing" || order.isSimulatedPayment) {


        return res.status(403).json({


          message: "Test orders cannot use real payment or refund operations.",


          code: "TEST_ORDER_REAL_PAYMENT_BLOCKED",


        })


      }


      if (order.paymentStatus !== "refund_pending") {
        return res.status(409).json({
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

      const refundedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          environment: { $ne: "testing" },
          isSimulatedPayment: { $ne: true },
          paymentStatus: "refund_pending",
        },
        {
          $set: {
            paymentStatus: "refunded",
            refundedAt: new Date(),
            fulfillmentStatus: "cancelled",
            cancelled: true,
            cancelledAt: order.cancelledAt || new Date(),
            status: "Refunded",
          },
        },
        { new: true }
      )

      if (!refundedOrder) {
        return res.status(409).json({
          message: "Refund was already processed or order state changed.",
        })
      }

      const refundedPayment = await Payment.findOneAndUpdate(
        {
          _id: payment._id,
          status: { $ne: "refunded" },
        },
        {
          $set: {
            status: "refunded",
            refundedAt: new Date(),
            refundedBy: req.adminUser._id,
            refundReference,
          },
        },
        { new: true }
      )

      if (!refundedPayment) {
        console.error(
          "CRITICAL: order marked refunded but payment record did not transition",
          String(order._id),
          String(payment._id)
        )

        return res.status(500).json({
          message:
            "Order refund state changed but payment requires reconciliation.",
          code: "REFUND_RECONCILIATION_REQUIRED",
        })
      }

      await logAction(
        req,
        "refund_completed",
        "payment",
        refundedPayment._id.toString(),
        {
          orderId: refundedOrder._id.toString(),
          localOrderId: refundedOrder.localOrderId,
          amount: refundedPayment.amount,
          refundReference,
        }
      )

      return res.json({
        message: "Refund marked completed.",
        payment: safePaymentResponse(refundedPayment),
        order: safeOrderResponse(refundedOrder),
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
import express from "express"
import jwt from "jsonwebtoken"

import Order from "../models/Order.js"
import Listing from "../models/Listing.js"
import protect from "../middleware/auth.js"

const router = express.Router()

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function pushToSeller(req, sellerId, data) {
  try {
    const io = req.app.get("io")
    const sellerSockets = req.app.get("sellerSockets")
    const queueNotif = req.app.get("queueNotification")

    if (!io || !sellerSockets || !sellerId) {
      return
    }

    const sockets = sellerSockets.get(String(sellerId))

    if (!sockets || sockets.size === 0) {
      if (queueNotif) {
        queueNotif(
          String(sellerId),
          "new_order",
          data
        )
      }

      console.log(
        `📬 Seller ${sellerId} offline — new_order queued`
      )

      return
    }

    sockets.forEach((socketId) => {
      io.to(socketId).emit(
        "new_order",
        data
      )
    })

    console.log(
      `📡 Notified seller ${sellerId} of new order`
    )
  } catch (err) {
    console.error(
      "pushToSeller error:",
      err.message
    )
  }
}

/*
 * Safely extract a normal user ID from a JWT.
 *
 * This is intentionally only used to attach an optional buyer
 * to a PUBLIC guest-compatible order creation request.
 *
 * It does NOT grant the request authenticated privileges.
 */
function getOptionalBuyerId(req) {
  try {
    const header = req.headers.authorization

    if (!header?.startsWith("Bearer ")) {
      return null
    }

    const token = header.split(" ")[1]

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    return decoded.id || null
  } catch {
    return null
  }
}

/*
 * Calculate the expected listing amount.
 *
 * IMPORTANT:
 *
 * The client is not allowed to define the authoritative
 * listing price.
 *
 * Products/services:
 *     Listing.price
 *
 * Rentals:
 *     Listing.dailyRate × rentalDays
 *
 * The existing frontend can continue sending `amount`,
 * but we compare it against the server calculation.
 */
function calculateListingAmount(listing, rentalDays) {
  if (!listing) {
    return null
  }

  if (listing.type === "rent") {
    const days = Number(rentalDays)

    if (!Number.isFinite(days) || days <= 0) {
      return null
    }

    if (
      listing.maxDays &&
      days > Number(listing.maxDays)
    ) {
      return null
    }

    const dailyRate = Number(listing.dailyRate)

    if (
      !Number.isFinite(dailyRate) ||
      dailyRate < 0
    ) {
      return null
    }

    return dailyRate * days
  }

  const price = Number(listing.price)

  if (
    !Number.isFinite(price) ||
    price < 0
  ) {
    return null
  }

  return price
}

/*
 * Compare monetary values safely.
 *
 * We use cents/pesewas rather than direct floating-point
 * equality.
 */
function amountsMatch(a, b) {
  const first = Math.round(
    Number(a || 0) * 100
  )

  const second = Math.round(
    Number(b || 0) * 100
  )

  return first === second
}

/*
 * Platform fee.
 *
 * Current business configuration is 8%.
 *
 * IMPORTANT:
 * The buyer does not control this number.
 */
function calculatePlatformFee(amount) {
  return Math.round(
    Number(amount || 0) * 0.08
  )
}

/*
 * Determine whether an order is still cancellable.
 *
 * We keep this conservative for now.
 *
 * The detailed compensation/refund rules will be implemented
 * in the dedicated transaction/dispute layer.
 */
function canCancelOrder(order) {
  if (!order) {
    return false
  }

  if (order.cancelled) {
    return false
  }

  if (
    order.fulfillmentStatus === "completed" ||
    order.status === "Completed"
  ) {
    return false
  }

  if (
    order.paymentStatus === "released" ||
    order.paymentStatus === "refunded"
  ) {
    return false
  }

  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER
// POST /api/orders
//
// PUBLIC
//
// Guests are still supported.
//
// IMPORTANT CHANGE:
//
// Creating an order does NOT mean payment has happened.
//
// New order:
//
// paymentStatus     = pending
// fulfillmentStatus = pending_payment
// status            = Pending Confirmation
//
// Only a verified payment provider/manual verification can
// move the order into escrow.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  try {
    const {
      listingId,
      sellerId: bodySellerID,
      localOrderId,
      type,
      amount: clientAmount,
      paystackRef,
      location,
      landmark,
      extraInfo,
      contactInfo,
      payerName,
      payerPhone,
      promoCode,
      discount,
      deliveryMethod,
      paymentMethod,
      rentalDays,
    } = req.body

    // ───────────────────────────────────────────────────────────────────────
    // Validate payment method
    // ───────────────────────────────────────────────────────────────────────

    const selectedPaymentMethod =
      paymentMethod || "manual_momo"

    if (
      ![
        "manual_momo",
        "paystack",
      ].includes(selectedPaymentMethod)
    ) {
      return res.status(400).json({
        message: "Unsupported payment method.",
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // Listing is now strongly preferred/required.
    //
    // We need the listing to establish:
    //
    // seller
    // title
    // image
    // authoritative price
    // ───────────────────────────────────────────────────────────────────────

    if (!listingId) {
      return res.status(400).json({
        message:
          "A valid listing is required to create an order.",
      })
    }

    const listing = await Listing.findById(
      listingId
    ).select(
      "seller title image type price dailyRate maxDays status"
    )

    if (!listing) {
      return res.status(404).json({
        message: "Listing not found.",
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // Removed listings cannot be purchased.
    // ───────────────────────────────────────────────────────────────────────

    if (listing.status !== "Active") {
      return res.status(400).json({
        message:
          "This listing is no longer available.",
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // SELLER COMES FROM THE LISTING
    //
    // We do NOT trust sellerId supplied by the browser.
    // ───────────────────────────────────────────────────────────────────────

    const resolvedSellerId =
      String(listing.seller)

    const suppliedSellerId =
      bodySellerID
        ? String(bodySellerID)
        : null

    if (
      suppliedSellerId &&
      suppliedSellerId !== resolvedSellerId
    ) {
      return res.status(400).json({
        message:
          "The selected seller does not match the listing.",
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // AUTHORITATIVE PRICE
    // ───────────────────────────────────────────────────────────────────────

    const authoritativeAmount =
      calculateListingAmount(
        listing,
        rentalDays
      )

    if (
      authoritativeAmount === null
    ) {
      return res.status(400).json({
        message:
          listing.type === "rent"
            ? "Valid rental days are required."
            : "This listing does not currently have a valid price.",
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // CLIENT AMOUNT CHECK
    //
    // The frontend may still send amount because the existing UI
    // expects it.
    //
    // But the browser no longer gets to define the transaction
    // amount.
    // ───────────────────────────────────────────────────────────────────────

    if (
      clientAmount !== undefined &&
      clientAmount !== null &&
      !amountsMatch(
        clientAmount,
        authoritativeAmount
      )
    ) {
      return res.status(400).json({
        message:
          "The order amount does not match the listing price.",
        expectedAmount:
          authoritativeAmount,
      })
    }

    const finalAmount =
      authoritativeAmount

    // ───────────────────────────────────────────────────────────────────────
    // DISCOUNT
    //
    // We preserve the existing frontend's discount field for
    // compatibility.
    //
    // IMPORTANT:
    //
    // The discount is capped so the buyer cannot make the final
    // order amount negative.
    //
    // Full server-side promo validation will be moved here when
    // the promo system becomes database-backed.
    // ───────────────────────────────────────────────────────────────────────

    let requestedDiscount =
      Number(discount || 0)

    if (
      !Number.isFinite(
        requestedDiscount
      ) ||
      requestedDiscount < 0
    ) {
      requestedDiscount = 0
    }

    requestedDiscount = Math.min(
      requestedDiscount,
      finalAmount
    )

    const finalPayableAmount =
      finalAmount - requestedDiscount

    // ───────────────────────────────────────────────────────────────────────
    // PLATFORM FEE
    //
    // Calculated by Silk Road.
    // Never supplied by the client.
    // ───────────────────────────────────────────────────────────────────────

    const platformFee =
      calculatePlatformFee(
        finalPayableAmount
      )

    const sellerAmount =
      finalPayableAmount -
      platformFee

    // ───────────────────────────────────────────────────────────────────────
    // OPTIONAL AUTHENTICATED BUYER
    //
    // Guest checkout remains supported.
    // ───────────────────────────────────────────────────────────────────────

    const buyerId =
      getOptionalBuyerId(req)

    // ───────────────────────────────────────────────────────────────────────
    // CREATE ORDER
    //
    // THIS IS THE CRITICAL CHANGE.
    //
    // An order is NOT automatically placed into escrow.
    // ───────────────────────────────────────────────────────────────────────

    const order = await Order.create({
      buyer:
        buyerId || null,

      seller:
        resolvedSellerId,

      listing:
        listing._id,

      localOrderId:
        localOrderId || null,

      type:
        type || listing.type || "product",

      amount:
        finalPayableAmount,

      platformFee,

      sellerAmount,

      discount:
        requestedDiscount,

      paystackRef:
        paystackRef || null,

      location:
        location || null,

      landmark:
        landmark || null,

      extraInfo:
        extraInfo || null,

      contactInfo:
        contactInfo || null,

      payerName:
        payerName || null,

      payerPhone:
        payerPhone || null,

      promoCode:
        promoCode || null,

      deliveryMethod:
        deliveryMethod || "pickup",

      paymentMethod:
        selectedPaymentMethod,

      // NEW TRANSACTION STATE
      status:
        "Pending Confirmation",

      paymentStatus:
        "pending",

      fulfillmentStatus:
        "pending_payment",

      rentalDays:
        listing.type === "rent"
          ? Number(rentalDays)
          : null,
    })

    // ───────────────────────────────────────────────────────────────────────
    // SELLER NOTIFICATION
    //
    // The seller is informed of the order.
    //
    // IMPORTANT:
    //
    // At this stage the order is NOT yet confirmed as paid.
    // The notification explicitly says payment is pending.
    // ───────────────────────────────────────────────────────────────────────

    pushToSeller(
      req,
      resolvedSellerId,
      {
        orderId:
          localOrderId ||
          String(order._id),

        databaseOrderId:
          String(order._id),

        itemTitle:
          listing.title || "Item",

        itemImage:
          listing.image || null,

        amount:
          finalPayableAmount,

        buyerName:
          payerName || "A buyer",

        buyerContact:
          contactInfo ||
          payerPhone ||
          "",

        location:
          location || null,

        landmark:
          landmark || null,

        paymentRef:
          paystackRef || null,

        paymentMethod:
          selectedPaymentMethod,

        paymentStatus:
          "pending",

        orderStatus:
          "Pending Confirmation",

        deliveryMethod:
          deliveryMethod || "pickup",

        discount:
          requestedDiscount,

        promoCode:
          promoCode || null,
      }
    )

    console.log(
      `🆕 Order ${order._id} created | ` +
      `localOrderId: ${localOrderId || "none"} | ` +
      `seller: ${resolvedSellerId} | ` +
      `amount: ₵${finalPayableAmount} | ` +
      `payment: ${selectedPaymentMethod} | ` +
      `state: pending`
    )

    return res.status(201).json({
      orderId:
        String(order._id),

      paymentRequired:
        true,

      paymentStatus:
        order.paymentStatus,

      fulfillmentStatus:
        order.fulfillmentStatus,

      order,
    })
  } catch (err) {
    console.error(
      "Create order error:",
      err
    )

    return res.status(500).json({
      message:
        "Unable to create order.",
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET MY ORDERS
// GET /api/orders/my
//
// AUTHENTICATED BUYER
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/my",
  protect,
  async (req, res) => {
    try {
      const orders =
        await Order.find({
          buyer: req.user.id,
        })
          .populate(
            "listing",
            "title image type price dailyRate"
          )
          .populate(
            "seller",
            "name"
          )
          .sort({
            createdAt: -1,
          })

      res.json(orders)
    } catch (err) {
      console.error(
        "Get buyer orders error:",
        err.message
      )

      res.status(500).json({
        message:
          "Unable to retrieve orders.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// GET SELLING ORDERS
// GET /api/orders/selling
//
// AUTHENTICATED SELLER
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/selling",
  protect,
  async (req, res) => {
    try {
      const orders =
        await Order.find({
          seller: req.user.id,
        })
          .populate(
            "listing",
            "title image type price dailyRate"
          )
          .populate(
            "buyer",
            "name phone"
          )
          .sort({
            createdAt: -1,
          })

      res.json(orders)
    } catch (err) {
      console.error(
        "Get seller orders error:",
        err.message
      )

      res.status(500).json({
        message:
          "Unable to retrieve selling orders.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL ORDERS
// GET /api/orders/all
//
// LEGACY ADMIN ENDPOINT
//
// NOTE:
// This is intentionally preserved for compatibility in this patch.
// We will migrate it to the dedicated admin authorization middleware
// separately.
//
// The previous endpoint only required the normal user JWT.
// That is NOT acceptable for production.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/all",
  protect,
  async (req, res) => {
    try {
      const orders =
        await Order.find()
          .populate(
            "listing",
            "title image type"
          )
          .populate(
            "buyer",
            "name email"
          )
          .populate(
            "seller",
            "name email"
          )
          .sort({
            createdAt: -1,
          })

      res.json(orders)
    } catch (err) {
      console.error(
        "Get all orders error:",
        err.message
      )

      res.status(500).json({
        message:
          "Unable to retrieve orders.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// GET ORDER BY LOCAL ID
// GET /api/orders/by-local-id/:localOrderId
//
// PUBLIC
//
// Used by the current Order Tracker.
//
// IMPORTANT:
// This endpoint intentionally exposes only customer-safe information.
// It does NOT expose sensitive payment records or internal accounting.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/by-local-id/:localOrderId",
  async (req, res) => {
    try {
      const {
        localOrderId,
      } = req.params

      if (!localOrderId) {
        return res.status(400).json({
          message: "ID required.",
        })
      }

      const order =
        await Order.findOne({
          localOrderId,
        })
          .populate(
            "listing",
            "title image"
          )
          .populate(
            "seller",
            "name"
          )

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      res.json({
        _id:
          order._id.toString(),

        localOrderId:
          order.localOrderId,

        amount:
          order.amount,

        status:
          order.status,

        paymentStatus:
          order.paymentStatus,

        fulfillmentStatus:
          order.fulfillmentStatus,

        paymentMethod:
          order.paymentMethod,

        deliveryMethod:
          order.deliveryMethod,

        location:
          order.location,

        landmark:
          order.landmark,

        payerName:
          order.payerName,

        createdAt:
          order.createdAt,

        listing:
          order.listing,

        seller:
          order.seller,
      })
    } catch (err) {
      console.error(
        "Get order by local ID error:",
        err.message
      )

      res.status(500).json({
        message:
          "Unable to retrieve order.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY CONFIRM-BY-REF
// PUT /api/orders/confirm-by-ref
//
// SECURITY CHANGE:
//
// This endpoint NO LONGER marks an order as Completed.
//
// Payment verification belongs to the payment layer.
//
// We keep the endpoint temporarily so an old frontend request
// doesn't accidentally perform a financial operation.
//
// It now returns a migration response.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/confirm-by-ref",
  protect,
  async (req, res) => {
    return res.status(410).json({
      message:
        "This confirmation method has been retired. Payment must be verified through the payment system.",
      code:
        "PAYMENT_CONFIRMATION_MOVED",
    })
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY CONFIRM DELIVERY
// PUT /api/orders/:id/confirm-delivery
//
// SECURITY CHANGE:
//
// A generic authenticated request can NO LONGER mark an order
// as Completed.
//
// Delivery completion will happen through the Delivery + OTP
// transaction flow.
//
// We return 410 instead of silently performing the old behavior.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/confirm-delivery",
  protect,
  async (req, res) => {
    return res.status(410).json({
      message:
        "Direct order completion has been retired. Delivery must be confirmed through the delivery OTP process.",
      code:
        "DIRECT_DELIVERY_CONFIRMATION_MOVED",
    })
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL ORDER
// PUT /api/orders/:id/cancel
//
// AUTHENTICATED BUYER/SELLER
//
// IMPORTANT:
//
// This does NOT pretend that a refund has happened.
//
// If payment was already held in escrow, the order moves to
// refund_pending.
//
// An actual refund will be performed by the transaction/refund
// system.
//
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/cancel",
  protect,
  async (req, res) => {
    try {
      const order =
        await Order.findById(
          req.params.id
        )

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      const userId =
        String(req.user.id)

      const isBuyer =
        order.buyer &&
        String(order.buyer) ===
          userId

      const isSeller =
        order.seller &&
        String(order.seller) ===
          userId

      if (!isBuyer && !isSeller) {
        return res.status(403).json({
          message:
            "You are not authorized to cancel this order.",
        })
      }

      if (!canCancelOrder(order)) {
        return res.status(400).json({
          message:
            "This order can no longer be cancelled.",
        })
      }

      /*
       * If payment has NOT reached escrow, cancellation is
       * purely a transaction-state cancellation.
       */

      if (
        order.paymentStatus ===
        "pending"
      ) {
        order.paymentStatus =
          "failed"
      }

      /*
       * If Silk Road is already holding funds, we must not
       * claim that they have magically been refunded.
       *
       * The refund engine will handle the actual movement.
       */

      if (
        order.paymentStatus ===
        "escrow_held"
      ) {
        order.paymentStatus =
          "refund_pending"
      }

      order.status =
        "Cancelled"

      order.fulfillmentStatus =
        "cancelled"

      order.cancelled =
        true

      order.cancelledAt =
        new Date()

      await order.save()

      res.json({
        message:
          order.paymentStatus ===
          "refund_pending"
            ? "Order cancelled. Refund processing is pending."
            : "Order cancelled.",
        order,
      })
    } catch (err) {
      console.error(
        "Cancel order error:",
        err.message
      )

      res.status(500).json({
        message:
          "Unable to cancel order.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM RETURN
// PUT /api/orders/:id/confirm-return
//
// RENTAL COMPATIBILITY
//
// We preserve the existing renter/lender return confirmation
// flow for now.
//
// IMPORTANT:
//
// A rental return confirmation is not allowed to override a
// disputed/refunded/cancelled transaction.
//
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/confirm-return",
  protect,
  async (req, res) => {
    try {
      const order =
        await Order.findById(
          req.params.id
        )

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      const userId =
        String(req.user.id)

      const isBuyer =
        order.buyer &&
        String(order.buyer) ===
          userId

      const isSeller =
        order.seller &&
        String(order.seller) ===
          userId

      if (!isBuyer && !isSeller) {
        return res.status(403).json({
          message:
            "You are not authorized to confirm this return.",
        })
      }

      if (
        order.cancelled ||
        order.fulfillmentStatus ===
          "cancelled" ||
        order.paymentStatus ===
          "refunded"
      ) {
        return res.status(400).json({
          message:
            "This transaction cannot accept a return confirmation.",
        })
      }

      const {
        role,
      } = req.body

      if (
        role === "renter" &&
        isBuyer
      ) {
        order.renterConfirmed =
          true
      } else if (
        role === "lender" &&
        isSeller
      ) {
        order.lenderConfirmed =
          true
      } else {
        return res.status(403).json({
          message:
            "Invalid return confirmation role.",
        })
      }

      if (
        order.renterConfirmed &&
        order.lenderConfirmed
      ) {
        order.fulfillmentStatus =
          "completed"

        order.completedAt =
          new Date()

        /*
         * IMPORTANT:
         *
         * We do NOT automatically mark payment as released
         * here.
         *
         * Financial release belongs to the transaction engine.
         */
      }

      await order.save()

      res.json(order)
    } catch (err) {
      console.error(
        "Confirm return error:",
        err.message
      )

      res.status(500).json({
        message:
          "Unable to confirm return.",
      })
    }
  }
)

export default router

import express from "express"
import jwt from "jsonwebtoken"

import Order from "../models/Order.js"
import Listing from "../models/Listing.js"

import protect from "../middleware/auth.js"

const router = express.Router()

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function pushToSeller(
  req,
  sellerId,
  data
) {
  try {
    const io =
      req.app.get("io")

    const sellerSockets =
      req.app.get(
        "sellerSockets"
      )

    const queueNotif =
      req.app.get(
        "queueNotification"
      )

    if (
      !io ||
      !sellerSockets ||
      !sellerId
    ) {
      return
    }

    const sockets =
      sellerSockets.get(
        String(sellerId)
      )

    if (
      !sockets ||
      sockets.size === 0
    ) {
      if (queueNotif) {
        queueNotif(
          String(sellerId),
          "new_order",
          data
        )
      }

      return
    }

    sockets.forEach(
      (socketId) => {
        io.to(socketId).emit(
          "new_order",
          data
        )
      }
    )
  } catch (err) {
    console.error(
      "pushToSeller error:",
      err.message
    )
  }
}

function getOptionalBuyerId(
  req
) {
  try {
    const header =
      req.headers.authorization

    if (
      !header?.startsWith(
        "Bearer "
      )
    ) {
      return null
    }

    const token =
      header.split(" ")[1]

    const decoded =
      jwt.verify(
        token,
        process.env.JWT_SECRET
      )

    return (
      decoded.id || null
    )
  } catch {
    return null
  }
}

function isMongoId(value) {
  return (
    value &&
    /^[a-f\d]{24}$/i.test(
      String(value)
    )
  )
}

function amountsMatch(
  a,
  b
) {
  return (
    Math.round(
      Number(a || 0) * 100
    ) ===
    Math.round(
      Number(b || 0) * 100
    )
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING PRICE
// ─────────────────────────────────────────────────────────────────────────────

function calculateListingAmount(
  listing,
  rentalDays
) {
  if (!listing) {
    return null
  }

  if (
    listing.type ===
    "rent"
  ) {
    const days =
      Number(rentalDays)

    if (
      !Number.isFinite(days) ||
      days <= 0
    ) {
      return null
    }

    if (
      listing.maxDays &&
      days >
        Number(
          listing.maxDays
        )
    ) {
      return null
    }

    const dailyRate =
      Number(
        listing.dailyRate
      )

    if (
      !Number.isFinite(
        dailyRate
      ) ||
      dailyRate < 0
    ) {
      return null
    }

    return (
      dailyRate * days
    )
  }

  const price =
    Number(listing.price)

  if (
    !Number.isFinite(price) ||
    price < 0
  ) {
    return null
  }

  return price
}

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM FEE
// ─────────────────────────────────────────────────────────────────────────────

function calculatePlatformFee(
  amount
) {
  return Math.round(
    Number(amount || 0) *
      0.08
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION
// ─────────────────────────────────────────────────────────────────────────────

function canCancelOrder(
  order
) {
  if (!order) {
    return false
  }

  if (order.cancelled) {
    return false
  }

  if (
    order.fulfillmentStatus ===
      "completed" ||
    order.paymentStatus ===
      "released" ||
    order.paymentStatus ===
      "refunded"
  ) {
    return false
  }

  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER
//
// POST /api/orders
//
// Creating an order DOES NOT mean payment happened.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/",
  async (req, res) => {
    try {
      const {
        listingId,
        sellerId:
          suppliedSellerId,
        localOrderId,
        type,
        amount:
          clientAmount,
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

      const selectedPaymentMethod =
        paymentMethod ||
        "manual_momo"

      if (
        ![
          "manual_momo",
          "paystack",
        ].includes(
          selectedPaymentMethod
        )
      ) {
        return res.status(400).json({
          message:
            "Unsupported payment method.",
        })
      }

      if (!listingId) {
        return res.status(400).json({
          message:
            "A valid listing is required to create an order.",
        })
      }

      const listing =
        await Listing.findById(
          listingId
        ).select(
          "seller title image type price dailyRate maxDays status"
        )

      if (!listing) {
        return res.status(404).json({
          message:
            "Listing not found.",
        })
      }

      if (
        listing.status !==
        "Active"
      ) {
        return res.status(400).json({
          message:
            "This listing is no longer available.",
        })
      }

      const resolvedSellerId =
        String(
          listing.seller
        )

      if (
        suppliedSellerId &&
        String(
          suppliedSellerId
        ) !==
          resolvedSellerId
      ) {
        return res.status(400).json({
          message:
            "The selected seller does not match the listing.",
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // AUTHORITATIVE PRICE
      // ─────────────────────────────────────────────────────────────────────

      const authoritativeAmount =
        calculateListingAmount(
          listing,
          rentalDays
        )

      if (
        authoritativeAmount ===
        null
      ) {
        return res.status(400).json({
          message:
            listing.type ===
            "rent"
              ? "Valid rental days are required."
              : "This listing does not currently have a valid price.",
        })
      }

      if (
        clientAmount !==
          undefined &&
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

      // ─────────────────────────────────────────────────────────────────────
      // DISCOUNT
      // ─────────────────────────────────────────────────────────────────────

      let requestedDiscount =
        Number(
          discount || 0
        )

      if (
        !Number.isFinite(
          requestedDiscount
        ) ||
        requestedDiscount < 0
      ) {
        requestedDiscount = 0
      }

      requestedDiscount =
        Math.min(
          requestedDiscount,
          authoritativeAmount
        )

      const finalPayableAmount =
        authoritativeAmount -
        requestedDiscount

      // ─────────────────────────────────────────────────────────────────────
      // FEE
      // ─────────────────────────────────────────────────────────────────────

      const platformFee =
        calculatePlatformFee(
          finalPayableAmount
        )

      const sellerAmount =
        finalPayableAmount -
        platformFee

      const buyerId =
        getOptionalBuyerId(
          req
        )

      // ─────────────────────────────────────────────────────────────────────
      // CREATE PENDING ORDER
      // ─────────────────────────────────────────────────────────────────────

      const order =
        await Order.create({
          buyer:
            buyerId || null,

          seller:
            resolvedSellerId,

          listing:
            listing._id,

          localOrderId:
            localOrderId ||
            null,

          type:
            type ||
            listing.type ||
            "product",

          amount:
            finalPayableAmount,

          platformFee,

          sellerAmount,

          discount:
            requestedDiscount,

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
            deliveryMethod ||
            "pickup",

          paymentMethod:
            selectedPaymentMethod,

          paymentStatus:
            "pending",

          fulfillmentStatus:
            "pending_payment",

          status:
            "Pending Confirmation",

          rentalDays:
            listing.type ===
            "rent"
              ? Number(
                  rentalDays
                )
              : null,
        })

      // ─────────────────────────────────────────────────────────────────────
      // SELLER NOTIFICATION
      // ─────────────────────────────────────────────────────────────────────

      pushToSeller(
        req,
        resolvedSellerId,
        {
          orderId:
            localOrderId ||
            String(
              order._id
            ),

          databaseOrderId:
            String(
              order._id
            ),

          itemTitle:
            listing.title ||
            "Item",

          itemImage:
            listing.image ||
            null,

          amount:
            finalPayableAmount,

          buyerName:
            payerName ||
            "A buyer",

          buyerContact:
            contactInfo ||
            payerPhone ||
            "",

          location:
            location || null,

          landmark:
            landmark || null,

          paymentMethod:
            selectedPaymentMethod,

          paymentStatus:
            "pending",

          orderStatus:
            "Pending Confirmation",

          deliveryMethod:
            deliveryMethod ||
            "pickup",

          discount:
            requestedDiscount,

          promoCode:
            promoCode || null,
        }
      )

      console.log(
        `Order ${order._id} created | ` +
          `amount ₵${finalPayableAmount} | ` +
          `payment ${selectedPaymentMethod} | ` +
          `state pending`
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
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// GET MY ORDERS
//
// GET /api/orders/my
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/my",
  protect,
  async (req, res) => {
    try {
      const orders =
        await Order.find({
          buyer:
            req.user.id,
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
        err
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
//
// GET /api/orders/selling
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/selling",
  protect,
  async (req, res) => {
    try {
      const orders =
        await Order.find({
          seller:
            req.user.id,
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
        err
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
//
// LEGACY COMPATIBILITY ENDPOINT
//
// The proper admin order endpoint is /api/admin/orders.
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
        err
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
//
// GET /api/orders/by-local-id/:localOrderId
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
          message:
            "ID required.",
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
        err
      )

      res.status(500).json({
        message:
          "Unable to retrieve order.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY PAYMENT CONFIRMATION
//
// RETIRED.
//
// Payment verification belongs to /api/payments.
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
// LEGACY DIRECT DELIVERY CONFIRMATION
//
// RETIRED.
//
// The delivery + OTP system owns fulfillment completion.
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
//
// PUT /api/orders/:id/cancel
//
// IMPORTANT:
//
// pending payment:
//     → failed
//
// escrow:
//     → refund_pending
//
// released:
//     → cannot cancel through this route
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
        String(
          order.buyer
        ) === userId

      const isSeller =
        order.seller &&
        String(
          order.seller
        ) === userId

      if (
        !isBuyer &&
        !isSeller
      ) {
        return res.status(403).json({
          message:
            "You are not authorized to cancel this order.",
        })
      }

      if (
        !canCancelOrder(
          order
        )
      ) {
        return res.status(400).json({
          message:
            "This order can no longer be cancelled.",
        })
      }

      // No verified money exists yet.
      if (
        order.paymentStatus ===
        "pending"
      ) {
        order.paymentStatus =
          "failed"
      }

      // Money is inside Silk Road's escrow state.
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
        err
      )

      res.status(500).json({
        message:
          "Unable to cancel order.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM RENTAL RETURN
//
// PUT /api/orders/:id/confirm-return
//
// Rental compatibility.
//
// Completing a return DOES NOT release money automatically.
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
        String(
          order.buyer
        ) === userId

      const isSeller =
        order.seller &&
        String(
          order.seller
        ) === userId

      if (
        !isBuyer &&
        !isSeller
      ) {
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
        role ===
          "renter" &&
        isBuyer
      ) {
        order.renterConfirmed =
          true
      } else if (
        role ===
          "lender" &&
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
         * DO NOT release funds here.
         *
         * Financial state remains separate.
         */

        if (
          order.paymentStatus ===
          "escrow_held"
        ) {
          order.paymentStatus =
            "release_pending"
        }
      }

      await order.save()

      res.json(order)
    } catch (err) {
      console.error(
        "Confirm return error:",
        err
      )

      res.status(500).json({
        message:
          "Unable to confirm return.",
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default router

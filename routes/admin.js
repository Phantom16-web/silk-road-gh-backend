import express from "express"

import User from "../models/User.js"
import Listing from "../models/Listing.js"
import Order from "../models/Order.js"
import Rider from "../models/Rider.js"
import Delivery from "../models/Delivery.js"
import Admin from "../models/Admin.js"
import Payment from "../models/Payment.js"

import {
  requireAdminAuth,
  requireOwnerOrSuperAdmin,
  requirePermission,
  requireAnyPermission,
  logAction,
} from "../middleware/adminAuth.js"

const router =
  express.Router()

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN AUTH
// ─────────────────────────────────────────────────────────────────────────────

router.use(
  requireAdminAuth
)

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/dashboard",
  async (req, res) => {
    try {
      const [
        totalUsers,
        totalListings,
        totalOrders,
        totalRiders,
        completedOrders,
        escrowOrders,
        pendingOrders,
        releasePendingOrders,
        refundPendingOrders,
        totalDeliveries,
        activeDeliveries,
      ] =
        await Promise.all([
          User.countDocuments(),

          Listing.countDocuments(),

          Order.countDocuments(),

          Rider.countDocuments(),

          Order.countDocuments({
            paymentStatus:
              "released",
          }),

          Order.countDocuments({
            paymentStatus:
              "escrow_held",
          }),

          Order.countDocuments({
            paymentStatus: {
              $in: [
                "pending",
                "failed",
              ],
            },
          }),

          Order.countDocuments({
            paymentStatus:
              "release_pending",
          }),

          Order.countDocuments({
            paymentStatus:
              "refund_pending",
          }),

          Delivery.countDocuments(),

          Delivery.countDocuments({
            status: {
              $in: [
                "accepted",
                "picked_up",
                "delivered",
              ],
            },
          }),
        ])

      // ─────────────────────────────────────────────────────────────────────
      // FINANCIAL SUMMARY
      // ─────────────────────────────────────────────────────────────────────

      const revenueAgg =
        await Order.aggregate([
          {
            $match: {
              paymentStatus:
                "released",
            },
          },

          {
            $group: {
              _id: null,

              totalRevenue: {
                $sum:
                  "$platformFee",
              },

              totalVolume: {
                $sum:
                  "$amount",
              },
            },
          },
        ])

      const revenue =
        revenueAgg[0]
          ?.totalRevenue || 0

      const totalVolume =
        revenueAgg[0]
          ?.totalVolume || 0

      // ─────────────────────────────────────────────────────────────────────
      // ESCROW
      // ─────────────────────────────────────────────────────────────────────

      const escrowAgg =
        await Order.aggregate([
          {
            $match: {
              paymentStatus:
                "escrow_held",
            },
          },

          {
            $group: {
              _id: null,

              total: {
                $sum:
                  "$amount",
              },
            },
          },
        ])

      const escrowHeld =
        escrowAgg[0]?.total ||
        0

      // ─────────────────────────────────────────────────────────────────────
      // RELEASE PENDING VALUE
      // ─────────────────────────────────────────────────────────────────────

      const releasePendingAgg =
        await Order.aggregate([
          {
            $match: {
              paymentStatus:
                "release_pending",
            },
          },

          {
            $group: {
              _id: null,

              total: {
                $sum:
                  "$amount",
              },

              sellerAmount: {
                $sum:
                  "$sellerAmount",
              },

              platformFee: {
                $sum:
                  "$platformFee",
              },
            },
          },
        ])

      const releasePending =
        releasePendingAgg[0] || {
          total: 0,
          sellerAmount: 0,
          platformFee: 0,
        }

      // ─────────────────────────────────────────────────────────────────────
      // REFUND PENDING VALUE
      // ─────────────────────────────────────────────────────────────────────

      const refundPendingAgg =
        await Order.aggregate([
          {
            $match: {
              paymentStatus:
                "refund_pending",
            },
          },

          {
            $group: {
              _id: null,

              total: {
                $sum:
                  "$amount",
              },
            },
          },
        ])

      const refundPending =
        refundPendingAgg[0]
          ?.total || 0

      res.json({
        users:
          totalUsers,

        listings:
          totalListings,

        orders:
          totalOrders,

        riders:
          totalRiders,

        completedOrders,

        escrowOrders,

        pendingOrders,

        releasePendingOrders,

        refundPendingOrders,

        totalDeliveries,

        activeDeliveries,

        revenue,

        totalVolume,

        escrowHeld,

        releasePending,

        refundPending,
      })
    } catch (err) {
      console.error(
        "Admin dashboard error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/users",
  requirePermission(
    "view_users"
  ),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        search = "",
        status,
      } = req.query

      const query = {}

      if (
        search.trim()
      ) {
        query.$or = [
          {
            name: {
              $regex:
                search,
              $options:
                "i",
            },
          },

          {
            email: {
              $regex:
                search,
              $options:
                "i",
            },
          },
        ]
      }

      if (status) {
        query.status =
          status
      }

      const [
        users,
        total,
      ] =
        await Promise.all([
          User.find(
            query
          )
            .select(
              "-passwordHash"
            )
            .sort({
              createdAt:
                -1,
            })
            .skip(
              (page - 1) *
                limit
            )
            .limit(
              Number(limit)
            ),

          User.countDocuments(
            query
          ),
        ])

      res.json({
        users,

        total,

        page:
          Number(page),

        pages:
          Math.ceil(
            total /
              Number(limit)
          ),
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.put(
  "/users/:id/suspend",
  requirePermission(
    "suspend_accounts"
  ),
  async (req, res) => {
    try {
      const user =
        await User.findById(
          req.params.id
        )

      if (!user) {
        return res.status(404).json({
          message:
            "User not found.",
        })
      }

      user.status =
        "Suspended"

      user.suspendedAt =
        new Date()

      await user.save()

      await logAction(
        req,
        "user_suspended",
        "user",
        user._id.toString(),
        {
          userEmail:
            user.email,

          reason:
            req.body.reason ||
            "",
        }
      )

      res.json({
        message:
          `User ${user.email} suspended.`,

        user,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.put(
  "/users/:id/reinstate",
  requirePermission(
    "suspend_accounts"
  ),
  async (req, res) => {
    try {
      const user =
        await User.findById(
          req.params.id
        )

      if (!user) {
        return res.status(404).json({
          message:
            "User not found.",
        })
      }

      user.status =
        "Active"

      user.suspendedAt =
        null

      await user.save()

      await logAction(
        req,
        "user_reinstated",
        "user",
        user._id.toString(),
        {
          userEmail:
            user.email,
        }
      )

      res.json({
        message:
          `User ${user.email} reinstated.`,

        user,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.delete(
  "/users/:id",
  requireOwnerOrSuperAdmin,
  async (req, res) => {
    try {
      const user =
        await User.findById(
          req.params.id
        )

      if (!user) {
        return res.status(404).json({
          message:
            "User not found.",
        })
      }

      await User.findByIdAndDelete(
        req.params.id
      )

      await logAction(
        req,
        "user_deleted",
        "user",
        req.params.id,
        {
          userEmail:
            user.email,
        }
      )

      res.json({
        message:
          `User ${user.email} permanently deleted.`,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// LISTINGS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/listings",
  requireAnyPermission(
    "view_listings",
    "manage_listings"
  ),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        search = "",
        status,
        type,
      } = req.query

      const query = {}

      if (
        search.trim()
      ) {
        query.$or = [
          {
            title: {
              $regex:
                search,
              $options:
                "i",
            },
          },

          {
            category: {
              $regex:
                search,
              $options:
                "i",
            },
          },
        ]
      }

      if (status) {
        query.status =
          status
      }

      if (type) {
        query.type =
          type
      }

      const [
        listings,
        total,
      ] =
        await Promise.all([
          Listing.find(
            query
          )
            .populate(
              "seller",
              "name email university"
            )
            .sort({
              createdAt:
                -1,
            })
            .skip(
              (page - 1) *
                limit
            )
            .limit(
              Number(limit)
            ),

          Listing.countDocuments(
            query
          ),
        ])

      res.json({
        listings,

        total,

        page:
          Number(page),

        pages:
          Math.ceil(
            total /
              Number(limit)
          ),
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.put(
  "/listings/:id/flag",
  requireAnyPermission(
    "flag_content",
    "manage_listings"
  ),
  async (req, res) => {
    try {
      const listing =
        await Listing.findById(
          req.params.id
        )

      if (!listing) {
        return res.status(404).json({
          message:
            "Listing not found.",
        })
      }

      listing.status =
        "Flagged"

      await listing.save()

      await logAction(
        req,
        "listing_flagged",
        "listing",
        listing._id.toString(),
        {
          title:
            listing.title,

          reason:
            req.body.reason ||
            "",
        }
      )

      res.json({
        message:
          "Listing flagged.",

        listing,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.delete(
  "/listings/:id",
  requireAnyPermission(
    "remove_listings",
    "manage_listings"
  ),
  async (req, res) => {
    try {
      const listing =
        await Listing.findById(
          req.params.id
        )

      if (!listing) {
        return res.status(404).json({
          message:
            "Listing not found.",
        })
      }

      await Listing.findByIdAndDelete(
        req.params.id
      )

      await logAction(
        req,
        "listing_removed",
        "listing",
        req.params.id,
        {
          title:
            listing.title,

          reason:
            req.body.reason ||
            "",
        }
      )

      res.json({
        message:
          "Listing removed.",
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/orders",
  requireAnyPermission(
    "view_orders",
    "view_payments"
  ),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        search = "",
        status,
        paymentStatus,
      } = req.query

      const query = {}

      if (
        search.trim()
      ) {
        query.localOrderId = {
          $regex:
            search,

          $options:
            "i",
        }
      }

      if (status) {
        query.status =
          status
      }

      if (
        paymentStatus
      ) {
        query.paymentStatus =
          paymentStatus
      }

      const [
        orders,
        total,
      ] =
        await Promise.all([
          Order.find(
            query
          )
            .populate(
              "listing",
              "title image"
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
              createdAt:
                -1,
            })
            .skip(
              (page - 1) *
                limit
            )
            .limit(
              Number(limit)
            ),

          Order.countDocuments(
            query
          ),
        ])

      res.json({
        orders,

        total,

        page:
          Number(page),

        pages:
          Math.ceil(
            total /
              Number(limit)
          ),
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE ORDER
//
// FINANCIAL STATE:
//
// release_pending → released
//
// This is the ONLY admin transition that releases escrow.
//
// The route refuses to release:
//
// pending
// failed
// escrow_held
// refund_pending
// refunded
// released
//
// Rider money is settled only here.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/orders/:id/release",
  requireAnyPermission(
    "manage_orders",
    "manage_payments"
  ),
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

      // ─────────────────────────────────────────────────────────────────────
      // FINANCIAL STATE GATE
      // ─────────────────────────────────────────────────────────────────────

      if (
        order.paymentStatus !==
        "release_pending"
      ) {
        return res.status(400).json({
          message:
            `Order cannot be released from payment state "${order.paymentStatus}".`,
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // FULFILLMENT STATE GATE
      // ─────────────────────────────────────────────────────────────────────

      if (
        order.fulfillmentStatus !==
        "completed"
      ) {
        return res.status(400).json({
          message:
            "Order fulfillment has not been completed.",
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // FIND COMPLETED DELIVERY
      // ─────────────────────────────────────────────────────────────────────

      const delivery =
        await Delivery.findOne({
          order:
            order._id,

          status:
            "completed",
        }).sort({
          completedAt:
            -1,

          updatedAt:
            -1,
        })

      // ─────────────────────────────────────────────────────────────────────
      // VALIDATE RIDER FINANCIAL POSITION BEFORE CHANGING ORDER STATE
      // ─────────────────────────────────────────────────────────────────────

      let rider = null
      let deliveryFee = 0
      let riderSettlement = 0
      let previousPendingEarnings = 0

      if (
        delivery &&
        delivery.rider
      ) {
        rider =
          await Rider.findById(
            delivery.rider
          )

        if (!rider) {
          return res.status(409).json({
            message:
              "The rider attached to this delivery could not be found. Release stopped to protect the financial ledger.",
          })
        }

        deliveryFee =
          Number(
            delivery.deliveryFee ||
              0
          )

        previousPendingEarnings =
          Number(
            rider.pendingEarnings ||
              0
          )

        if (
          previousPendingEarnings <
          deliveryFee
        ) {
          return res.status(409).json({
            message:
              "Rider pending earnings are lower than the delivery fee. Release stopped to prevent an incomplete rider settlement.",
          })
        }

        riderSettlement =
          deliveryFee
      }

      // ─────────────────────────────────────────────────────────────────────
      // RIDER SETTLEMENT
      //
      // pendingEarnings → totalEarned
      //
      // IMPORTANT:
      //
      // totalEarned and totalPaid are NOT touched at delivery completion.
      // They are touched only when the financial release actually occurs.
      // ─────────────────────────────────────────────────────────────────────

      if (rider) {
        rider.pendingEarnings =
          previousPendingEarnings -
          riderSettlement

        rider.totalEarned =
          Number(
            rider.totalEarned ||
              0
          ) +
          riderSettlement

        rider.totalPaid =
          Number(
            rider.totalPaid ||
              0
          ) +
          riderSettlement

        await rider.save()
      }

      // ─────────────────────────────────────────────────────────────────────
      // FINAL ORDER FINANCIAL TRANSITION
      //
      // release_pending → released
      // ─────────────────────────────────────────────────────────────────────

      order.paymentStatus =
        "released"

      order.status =
        "Completed"

      order.releasedAt =
        new Date()

      await order.save()

      // ─────────────────────────────────────────────────────────────────────
      // AUDIT
      // ─────────────────────────────────────────────────────────────────────

      await logAction(
        req,
        "order_released",
        "order",
        order._id.toString(),
        {
          localOrderId:
            order.localOrderId,

          amount:
            Number(
              order.amount ||
                0
            ),

          sellerAmount:
            Number(
              order.sellerAmount ||
                0
            ),

          platformFee:
            Number(
              order.platformFee ||
                0
            ),

          paymentMethod:
            order.paymentMethod,

          previousPaymentStatus:
            "release_pending",

          paymentStatus:
            "released",

          deliveryId:
            delivery?._id ||
            null,

          riderId:
            delivery?.rider ||
            null,

          deliveryFee,

          riderSettlement,
        }
      )

      res.json({
        message:
          "Order released and settlement recorded.",

        order,

        settlement: {
          riderId:
            delivery?.rider ||
            null,

          riderAmount:
            riderSettlement,

          sellerAmount:
            Number(
              order.sellerAmount ||
                0
            ),

          platformFee:
            Number(
              order.platformFee ||
                0
            ),
        },
      })
    } catch (err) {
      console.error(
        "Order release error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST REFUND
//
// FINANCIAL STATES:
//
// escrow_held
//      ↓
// refund_pending
//
// release_pending
//      ↓
// refund_pending
//
// A RELEASED order cannot be refunded through this route.
// A refund after settlement requires a separate financial reversal process.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/orders/:id/refund",
  requireAnyPermission(
    "manage_orders",
    "manage_refunds",
    "issue_refund_decisions"
  ),
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

      if (
        [
          "refunded",
          "refund_pending",
        ].includes(
          order.paymentStatus
        )
      ) {
        return res.status(400).json({
          message:
            "A refund is already pending or completed.",
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
            `Order cannot be refunded from payment state "${order.paymentStatus}".`,
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // FIND PAYMENT RECORD
      // ─────────────────────────────────────────────────────────────────────

      const payment =
        await Payment.findOne({
          order:
            order._id,

          status: {
            $in: [
              "verified",
              "submitted",
              "under_review",
            ],
          },
        }).sort({
          createdAt:
            -1,
        })

      if (payment) {
        payment.refundRequestedAt =
          new Date()

        payment.refundRequestedBy =
          req.adminUser._id

        payment.refundReason =
          req.body.reason ||
          "Admin refund decision."

        await payment.save()
      }

      // ─────────────────────────────────────────────────────────────────────
      // FINANCIAL STATE TRANSITION
      // ─────────────────────────────────────────────────────────────────────

      const previousPaymentStatus =
        order.paymentStatus

      order.paymentStatus =
        "refund_pending"

      order.status =
        "Refund Pending"

      await order.save()

      // ─────────────────────────────────────────────────────────────────────
      // AUDIT
      // ─────────────────────────────────────────────────────────────────────

      await logAction(
        req,
        "refund_requested",
        "order",
        order._id.toString(),
        {
          localOrderId:
            order.localOrderId,

          amount:
            Number(
              order.amount ||
                0
            ),

          previousPaymentStatus,

          paymentStatus:
            "refund_pending",

          paymentId:
            payment?._id ||
            null,

          reason:
            req.body.reason ||
            "",
        }
      )

      res.json({
        message:
          "Refund is now pending processing.",

        order,
      })
    } catch (err) {
      console.error(
        "Refund request error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE REFUND
//
// FINANCIAL STATE:
//
// refund_pending → refunded
//
// IMPORTANT:
//
// If the order reached release_pending and the rider was provisionally credited
// into pendingEarnings, that provisional amount must be removed before the
// refund becomes final.
//
// totalEarned and totalPaid are NOT reduced here because they should never have
// been increased before actual release.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/orders/:id/refund-complete",
  requireAnyPermission(
    "manage_refunds"
  ),
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

      if (
        order.paymentStatus !==
        "refund_pending"
      ) {
        return res.status(400).json({
          message:
            "Order is not awaiting refund completion.",
        })
      }

      // ─────────────────────────────────────────────────────────────────────
      // FIND PAYMENT
      // ─────────────────────────────────────────────────────────────────────

      const payment =
        await Payment.findOne({
          order:
            order._id,
        }).sort({
          createdAt:
            -1,
        })

      // ─────────────────────────────────────────────────────────────────────
      // FIND DELIVERY
      //
      // We need this because a completed delivery may have already placed the
      // rider's delivery fee into pendingEarnings.
      // ─────────────────────────────────────────────────────────────────────

      const delivery =
        await Delivery.findOne({
          order:
            order._id,

          status:
            "completed",
        }).sort({
          completedAt:
            -1,

          updatedAt:
            -1,
        })

      let rider = null
      let riderPendingReversal = 0

      // ─────────────────────────────────────────────────────────────────────
      // REMOVE PROVISIONAL RIDER EARNINGS
      //
      // Only pendingEarnings is reversed.
      //
      // We deliberately do NOT touch totalEarned or totalPaid because those
      // values represent money that has actually been released/paid.
      // ─────────────────────────────────────────────────────────────────────

      if (
        delivery &&
        delivery.rider
      ) {
        rider =
          await Rider.findById(
            delivery.rider
          )

        if (!rider) {
          return res.status(409).json({
            message:
              "The rider attached to this delivery could not be found. Refund completion stopped to protect the financial ledger.",
          })
        }

        riderPendingReversal =
          Number(
            delivery.deliveryFee ||
              0
          )

        const pending =
          Number(
            rider.pendingEarnings ||
              0
          )

        if (
          pending <
          riderPendingReversal
        ) {
          return res.status(409).json({
            message:
              "Rider pending earnings are lower than the delivery fee that must be reversed. Refund completion stopped to protect the financial ledger.",
          })
        }

        rider.pendingEarnings =
          pending -
          riderPendingReversal

        await rider.save()
      }

      // ─────────────────────────────────────────────────────────────────────
      // PAYMENT REFUND RECORD
      // ─────────────────────────────────────────────────────────────────────

      if (payment) {
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
      }

      // ─────────────────────────────────────────────────────────────────────
      // FINAL ORDER REFUND STATE
      //
      // refund_pending → refunded
      // ─────────────────────────────────────────────────────────────────────

      order.paymentStatus =
        "refunded"

      order.fulfillmentStatus =
        "cancelled"

      order.cancelled =
        true

      order.cancelledAt =
        order.cancelledAt ||
        new Date()

      order.status =
        "Refunded"

      await order.save()

      // ─────────────────────────────────────────────────────────────────────
      // AUDIT
      // ─────────────────────────────────────────────────────────────────────

      await logAction(
        req,
        "refund_completed",
        "order",
        order._id.toString(),
        {
          localOrderId:
            order.localOrderId,

          amount:
            Number(
              order.amount ||
                0
            ),

          paymentStatus:
            "refunded",

          paymentId:
            payment?._id ||
            null,

          deliveryId:
            delivery?._id ||
            null,

          riderId:
            delivery?.rider ||
            null,

          riderPendingReversal,

          refundReference:
            req.body
              .refundReference ||
            null,
        }
      )

      res.json({
        message:
          "Refund completed.",

        order,

        refund: {
          amount:
            Number(
              order.amount ||
                0
            ),

          riderPendingReversal,

          riderId:
            delivery?.rider ||
            null,

          refundReference:
            req.body
              .refundReference ||
            null,
        },
      })
    } catch (err) {
      console.error(
        "Refund completion error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RIDERS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/riders",
  requirePermission(
    "view_riders"
  ),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        search = "",
      } = req.query

      const query = {}

      if (
        search.trim()
      ) {
        query.$or = [
          {
            name: {
              $regex:
                search,
              $options:
                "i",
            },
          },

          {
            phone: {
              $regex:
                search,
              $options:
                "i",
            },
          },

          {
            university: {
              $regex:
                search,
              $options:
                "i",
            },
          },
        ]
      }

      const [
        riders,
        total,
      ] =
        await Promise.all([
          Rider.find(
            query
          )
            .select(
              "-password"
            )
            .sort({
              createdAt:
                -1,
            })
            .skip(
              (page - 1) *
                limit
            )
            .limit(
              Number(limit)
            ),

          Rider.countDocuments(
            query
          ),
        ])

      res.json({
        riders,

        total,

        page:
          Number(page),

        pages:
          Math.ceil(
            total /
              Number(limit)
          ),
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.put(
  "/riders/:id/deactivate",
  requirePermission(
    "manage_riders"
  ),
  async (req, res) => {
    try {
      const rider =
        await Rider.findById(
          req.params.id
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      rider.isActive =
        false

      await rider.save()

      await logAction(
        req,
        "rider_deactivated",
        "rider",
        rider._id.toString(),
        {
          name:
            rider.name,

          reason:
            req.body.reason ||
            "",
        }
      )

      res.json({
        message:
          `Rider ${rider.name} deactivated.`,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.put(
  "/riders/:id/activate",
  requirePermission(
    "manage_riders"
  ),
  async (req, res) => {
    try {
      const rider =
        await Rider.findById(
          req.params.id
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      rider.isActive =
        true

      await rider.save()

      await logAction(
        req,
        "rider_activated",
        "rider",
        rider._id.toString(),
        {
          name:
            rider.name,
        }
      )

      res.json({
        message:
          `Rider ${rider.name} activated.`,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

router.delete(
  "/riders/:id",
  requireOwnerOrSuperAdmin,
  async (req, res) => {
    try {
      const rider =
        await Rider.findById(
          req.params.id
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      await Rider.findByIdAndDelete(
        req.params.id
      )

      await logAction(
        req,
        "rider_deleted",
        "rider",
        req.params.id,
        {
          name:
            rider.name,
        }
      )

      res.json({
        message:
          `Rider ${rider.name} permanently deleted.`,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERIES
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/deliveries",
  requireAnyPermission(
    "view_deliveries",
    "view_delivery_status"
  ),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        status,
      } = req.query

      const query = {}

      if (status) {
        query.status =
          status
      }

      const [
        deliveries,
        total,
      ] =
        await Promise.all([
          Delivery.find(
            query
          )
            .populate(
              "rider",
              "name phone"
            )
            .populate(
              "seller",
              "name email"
            )
            .sort({
              createdAt:
                -1,
            })
            .skip(
              (page - 1) *
                limit
            )
            .limit(
              Number(limit)
            ),

          Delivery.countDocuments(
            query
          ),
        ])

      res.json({
        deliveries,

        total,

        page:
          Number(page),

        pages:
          Math.ceil(
            total /
              Number(limit)
          ),
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/audit-logs",
  requireOwnerOrSuperAdmin,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 100,
      } = req.query

      const admins =
        await Admin.find()
          .select(
            "name email role auditLog"
          )
          .sort({
            createdAt:
              -1,
          })

      const allLogs = []

      admins.forEach(
        (admin) => {
          if (
            !Array.isArray(
              admin.auditLog
            )
          ) {
            return
          }

          admin.auditLog.forEach(
            (entry) => {
              allLogs.push({
                ...entry.toObject(),

                adminName:
                  admin.name,

                adminEmail:
                  admin.email,

                adminRole:
                  admin.role,
              })
            }
          )
        }
      )

      allLogs.sort(
        (a, b) =>
          new Date(
            b.at
          ) -
          new Date(
            a.at
          )
      )

      const start =
        (Number(page) -
          1) *
        Number(limit)

      const paged =
        allLogs.slice(
          start,
          start +
            Number(limit)
        )

      res.json({
        logs:
          paged,

        total:
          allLogs.length,

        page:
          Number(page),

        pages:
          Math.ceil(
            allLogs.length /
              Number(limit)
          ),
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL REPORTS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/reports/financial",
  requirePermission(
    "view_financial_reports"
  ),
  async (req, res) => {
    try {
      const {
        from,
        to,
      } = req.query

      const match = {
        paymentStatus:
          "released",
      }

      if (
        from ||
        to
      ) {
        match.createdAt =
          {}

        if (from) {
          match.createdAt.$gte =
            new Date(from)
        }

        if (to) {
          match.createdAt.$lte =
            new Date(to)
        }
      }

      const [
        revenue,
        byMethod,
        topSellers,
      ] =
        await Promise.all([
          Order.aggregate([
            {
              $match:
                match,
            },

            {
              $group: {
                _id: null,

                totalRevenue: {
                  $sum:
                    "$platformFee",
                },

                totalVolume: {
                  $sum:
                    "$amount",
                },

                totalOrders: {
                  $sum: 1,
                },

                avgOrderValue: {
                  $avg:
                    "$amount",
                },
              },
            },
          ]),

          Order.aggregate([
            {
              $match:
                match,
            },

            {
              $group: {
                _id:
                  "$paymentMethod",

                count: {
                  $sum: 1,
                },

                total: {
                  $sum:
                    "$amount",
                },
              },
            },
          ]),

          Order.aggregate([
            {
              $match:
                match,
            },

            {
              $group: {
                _id:
                  "$seller",

                totalSales: {
                  $sum:
                    "$amount",
                },

                orderCount: {
                  $sum: 1,
                },

                totalEarnings: {
                  $sum:
                    "$sellerAmount",
                },
              },
            },

            {
              $sort: {
                totalSales:
                  -1,
              },
            },

            {
              $limit: 10,
            },

            {
              $lookup: {
                from:
                  "users",

                localField:
                  "_id",

                foreignField:
                  "_id",

                as:
                  "seller",
              },
            },

            {
              $unwind: {
                path:
                  "$seller",

                preserveNullAndEmptyArrays:
                  true,
              },
            },

            {
              $project: {
                sellerName:
                  "$seller.name",

                sellerEmail:
                  "$seller.email",

                totalSales:
                  1,

                orderCount:
                  1,

                totalEarnings:
                  1,
              },
            },
          ]),
        ])

      res.json({
        summary:
          revenue[0] ||
          {
            totalRevenue:
              0,

            totalVolume:
              0,

            totalOrders:
              0,

            avgOrderValue:
              0,
          },

        byMethod,

        topSellers,

        period: {
          from:
            from ||
            "all time",

          to:
            to ||
            "now",
        },
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/security/activity",
  requirePermission(
    "view_activity_logs"
  ),
  async (req, res) => {
    try {
      const oneHourAgo =
        new Date(
          Date.now() -
            60 *
              60 *
              1000
        )

      const suspicious =
        await Order.aggregate([
          {
            $match: {
              createdAt: {
                $gte:
                  oneHourAgo,
              },
            },
          },

          {
            $group: {
              _id:
                "$payerPhone",

              count: {
                $sum: 1,
              },

              orders: {
                $push:
                  "$localOrderId",
              },
            },
          },

          {
            $match: {
              count: {
                $gte: 3,
              },
            },
          },

          {
            $sort: {
              count:
                -1,
            },
          },
        ])

      const suspendedUsers =
        await User.find({
          status:
            "Suspended",
        })
          .select(
            "name email suspendedAt"
          )
          .sort({
            suspendedAt:
              -1,
          })
          .limit(20)

      const flaggedListings =
        await Listing.find({
          status:
            "Flagged",
        })
          .populate(
            "seller",
            "name email"
          )
          .sort({
            updatedAt:
              -1,
          })
          .limit(20)

      res.json({
        suspicious,

        suspendedUsers,

        flaggedListings,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

export default router

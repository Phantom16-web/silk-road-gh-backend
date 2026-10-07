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
// CRITICAL:
//
// release_pending → released
//
// Nothing else is accepted.
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

      if (
        order.paymentStatus !==
        "release_pending"
      ) {
        return res.status(400).json({
          message:
            `Order cannot be released from payment state "${order.paymentStatus}".`,
        })
      }

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
      // ACTUAL SILK ROAD SETTLEMENT POINT
      //
      // In the current manual architecture, this is the point at which Silk
      // Road records that the funds are being released.
      //
      // When Paystack transfers are later implemented, this block becomes the
      // provider-specific settlement operation.
      // ─────────────────────────────────────────────────────────────────────

      order.paymentStatus =
        "released"

      order.status =
        "Completed"

      await order.save()

      // ─────────────────────────────────────────────────────────────────────
      // RIDER SETTLEMENT
      // ─────────────────────────────────────────────────────────────────────

      const delivery =
        await Delivery.findOne({
          order:
            order._id,

          status:
            "completed",
        })

      if (
        delivery &&
        delivery.rider
      ) {
        const rider =
          await Rider.findById(
            delivery.rider
          )

        if (rider) {
          const fee =
            Number(
              delivery.deliveryFee ||
                0
            )

          const pending =
            Number(
              rider.pendingEarnings ||
                0
            )

          const amountToSettle =
            Math.min(
              fee,
              pending
            )

          if (
            amountToSettle >
            0
          ) {
            rider.pendingEarnings =
              pending -
              amountToSettle

            rider.totalEarned =
              Number(
                rider.totalEarned ||
                  0
              ) +
              amountToSettle

            rider.totalPaid =
              Number(
                rider.totalPaid ||
                  0
              ) +
              amountToSettle

            await rider.save()
          }
        }
      }

      await logAction(
        req,
        "order_released",
        "order",
        order._id.toString(),
        {
          localOrderId:
            order.localOrderId,

          amount:
            order.amount,

          paymentMethod:
            order.paymentMethod,

          paymentStatus:
            "released",
        }
      )

      res.json({
        message:
          "Order released and settlement recorded.",

        order,
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
// release/settlement is NEVER silently reversed here.
//
// escrow_held/release_pending → refund_pending
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

      order.paymentStatus =
        "refund_pending"

      order.status =
        "Refund Pending"

      await order.save()

      await logAction(
        req,
        "refund_requested",
        "order",
        order._id.toString(),
        {
          localOrderId:
            order.localOrderId,

          amount:
            order.amount,

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
// refund_pending → refunded
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

      const payment =
        await Payment.findOne({
          order:
            order._id,
        }).sort({
          createdAt:
            -1,
        })

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

      await logAction(
        req,
        "refund_completed",
        "order",
        order._id.toString(),
        {
          localOrderId:
            order.localOrderId,

          amount:
            order.amount,

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

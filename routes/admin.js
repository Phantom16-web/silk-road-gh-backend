import express from "express"
import User from "../models/User.js"
import Listing from "../models/Listing.js"
import Order from "../models/Order.js"
import Rider from "../models/Rider.js"
import Delivery from "../models/Delivery.js"
import Admin from "../models/Admin.js"
import {
  requireAdminAuth,
  requireOwnerOrSuperAdmin,
  requirePermission,
  requireAnyPermission,
  logAction,
} from "../middleware/adminAuth.js"
const router = express.Router()
// ─────────────────────────────────────────────────────────────────────────────
// ALL ADMIN ROUTES REQUIRE ADMIN AUTHENTICATION
// ─────────────────────────────────────────────────────────────────────────────
router.use(requireAdminAuth)
// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// Available to all authenticated admins
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
        releasePendingOrders,
        refundPendingOrders,
        refundedOrders,
        pendingOrders,
        totalDeliveries,
        activeDeliveries,
      ] = await Promise.all([
        User.countDocuments(),
        Listing.countDocuments(),
        Order.countDocuments(),
        Rider.countDocuments(),
        // New source of truth
        Order.countDocuments({
          fulfillmentStatus: "completed",
        }),
        Order.countDocuments({
          paymentStatus: "escrow_held",
        }),
        Order.countDocuments({
          paymentStatus:
            "release_pending",
        }),
        Order.countDocuments({
          paymentStatus:
            "refund_pending",
        }),
        Order.countDocuments({
          paymentStatus: "refunded",
        }),
        Order.countDocuments({
          $or: [
            {
              paymentStatus:
                "pending",
            },
            {
              status: "Pending",
            },
            {
              status:
                "Pending Confirmation",
            },
          ],
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
      // FINANCIAL DASHBOARD
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
                $sum: "$amount",
              },
              sellerPayouts: {
                $sum:
                  "$sellerAmount",
              },
            },
          },
        ])
      const revenue =
        revenueAgg[0] || {
          totalRevenue: 0,
          totalVolume: 0,
          sellerPayouts: 0,
        }
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
                $sum: "$amount",
              },
            },
          },
        ])
      const escrowHeld =
        escrowAgg[0]?.total || 0
      // ─────────────────────────────────────────────────────────────────────
      // RELEASE PENDING
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
                $sum: "$amount",
              },
              sellerAmount: {
                $sum:
                  "$sellerAmount",
              },
            },
          },
        ])
      const releasePending =
        releasePendingAgg[0] || {
          total: 0,
          sellerAmount: 0,
        }
      // ─────────────────────────────────────────────────────────────────────
      // REFUND PENDING
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
                $sum: "$amount",
              },
            },
          },
        ])
      const refundPending =
        refundPendingAgg[0]?.total ||
        0
      res.json({
        users: totalUsers,
        listings:
          totalListings,
        orders:
          totalOrders,
        riders:
          totalRiders,
        completedOrders,
        escrowOrders,
        releasePendingOrders,
        refundPendingOrders,
        refundedOrders,
        pendingOrders,
        totalDeliveries,
        activeDeliveries,
        revenue:
          revenue.totalRevenue,
        totalVolume:
          revenue.totalVolume,
        sellerPayouts:
          revenue.sellerPayouts,
        escrowHeld,
        releasePending:
          releasePending.total,
        releasePendingSellerAmount:
          releasePending.sellerAmount,
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
  requirePermission("view_users"),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        search = "",
        status,
      } = req.query
      const query = {}
      if (search.trim()) {
        query.$or = [
          {
            name: {
              $regex: search,
              $options: "i",
            },
          },
          {
            email: {
              $regex: search,
              $options: "i",
            },
          },
        ]
      }
      if (status) {
        query.status = status
      }
      const [
        users,
        total,
      ] = await Promise.all([
        User.find(query)
          .select(
            "-passwordHash"
          )
          .sort({
            createdAt: -1,
          })
          .skip(
            (page - 1) * limit
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
            total / limit
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
// SUSPEND USER
// ─────────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────
// REINSTATE USER
// ─────────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────
// DELETE USER
// ─────────────────────────────────────────────────────────────────────────────
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
      if (search.trim()) {
        query.$or = [
          {
            title: {
              $regex: search,
              $options: "i",
            },
          },
          {
            category: {
              $regex: search,
              $options: "i",
            },
          },
        ]
      }
      if (status) {
        query.status = status
      }
      if (type) {
        query.type = type
      }
      const [
        listings,
        total,
      ] = await Promise.all([
        Listing.find(query)
          .populate(
            "seller",
            "name email university"
          )
          .sort({
            createdAt: -1,
          })
          .skip(
            (page - 1) * limit
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
            total / limit
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
// FLAG LISTING
// ─────────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────
// DELETE LISTING
// ─────────────────────────────────────────────────────────────────────────────
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
        fulfillmentStatus,
      } = req.query
      const query = {}
      if (search.trim()) {
        query.localOrderId = {
          $regex: search,
          $options: "i",
        }
      }
      /*
       * Legacy status filter retained for frontend compatibility.
       */
      if (status) {
        query.status = status
      }
      /*
       * New financial state.
       */
      if (paymentStatus) {
        query.paymentStatus =
          paymentStatus
      }
      /*
       * New fulfillment state.
       */
      if (fulfillmentStatus) {
        query.fulfillmentStatus =
          fulfillmentStatus
      }
      const [
        orders,
        total,
      ] = await Promise.all([
        Order.find(query)
          .populate(
            "listing",
            "title"
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
          .skip(
            (page - 1) * limit
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
            total / limit
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
// IMPORTANT:
//
// This is NOT the same as "delivery completed".
//
// Delivery completion puts:
//
// paymentStatus = release_pending
//
// This route performs the administrative financial release:
//
// paymentStatus = released
//
// The actual external payout provider can be added later without changing
// the order lifecycle.
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
      // ────────────────────────────────────────────────────────────────────
      // CANNOT RELEASE A CANCELLED ORDER
      // ────────────────────────────────────────────────────────────────────
      if (
        order.cancelled
      ) {
        return res.status(400).json({
          message:
            "Cancelled orders cannot be released.",
        })
      }
      // ────────────────────────────────────────────────────────────────────
      // MUST HAVE VERIFIED ESCROW PAYMENT
      // ────────────────────────────────────────────────────────────────────
      if (
        order.paymentStatus !==
        "release_pending"
      ) {
        return res.status(400).json({
          message:
            `Order is not awaiting release. Current payment status: ${order.paymentStatus || "unknown"}.`,
        })
      }
      // ────────────────────────────────────────────────────────────────────
      // DELIVERY MUST ACTUALLY BE COMPLETE
      // ────────────────────────────────────────────────────────────────────
      if (
        order.fulfillmentStatus !==
        "completed"
      ) {
        return res.status(400).json({
          message:
            "The order must be completed through the delivery/OTP process before funds can be released.",
        })
      }
      // ────────────────────────────────────────────────────────────────────
      // RELEASE
      // ────────────────────────────────────────────────────────────────────
      order.paymentStatus =
        "released"
      order.releasedAt =
        new Date()
      /*
       * Keep generic order status as Completed.
       *
       * Financial state is represented by paymentStatus.
       */
      order.status =
        "Completed"
      await order.save()
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
          sellerAmount:
            order.sellerAmount,
          platformFee:
            order.platformFee,
          paymentMethod:
            order.paymentMethod,
          paymentStatus:
            "released",
        }
      )
      res.json({
        message:
          "Order financially released.",
        order,
      })
    } catch (err) {
      console.error(
        "Release order error:",
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
// REFUND ORDER
//
// IMPORTANT:
//
// We do not pretend money has already returned to the buyer.
//
// First state:
//
// refund_pending
//
// Actual provider/manual refund process can then move it to:
//
// refunded
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
        order.paymentStatus ===
        "refunded"
      ) {
        return res.status(400).json({
          message:
            "Order already refunded.",
        })
      }
      if (
        order.paymentStatus ===
        "refund_pending"
      ) {
        return res.status(400).json({
          message:
            "Refund is already pending processing.",
        })
      }
      // ────────────────────────────────────────────────────────────────────
      // NO PAYMENT = NOTHING TO REFUND
      // ────────────────────────────────────────────────────────────────────
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
            `This order has no refundable escrowed payment. Current payment status: ${order.paymentStatus || "unknown"}.`,
        })
      }
      // ────────────────────────────────────────────────────────────────────
      // PREVENT REFUND AFTER ALREADY RELEASED FUNDS
      // ────────────────────────────────────────────────────────────────────
      if (
        order.paymentStatus ===
        "released"
      ) {
        return res.status(400).json({
          message:
            "Funds have already been released. Use the dispute/recovery process instead of a standard escrow refund.",
        })
      }
      order.paymentStatus =
        "refund_pending"
      order.fulfillmentStatus =
        "cancelled"
      order.status =
        "Refunded"
      order.cancelled =
        true
      order.cancelledAt =
        new Date()
      await order.save()
      await logAction(
        req,
        "order_refund_requested",
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
          paymentMethod:
            order.paymentMethod,
        }
      )
      res.json({
        message:
          "Refund marked as pending processing.",
        order,
      })
    } catch (err) {
      console.error(
        "Refund order error:",
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
      if (search.trim()) {
        query.$or = [
          {
            name: {
              $regex: search,
              $options: "i",
            },
          },
          {
            phone: {
              $regex: search,
              $options: "i",
            },
          },
          {
            zone: {
              $regex: search,
              $options: "i",
            },
          },
        ]
      }
      const [
        riders,
        total,
      ] = await Promise.all([
        Rider.find(query)
          .select(
            "-passwordHash"
          )
          .sort({
            createdAt: -1,
          })
          .skip(
            (page - 1) * limit
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
            total / limit
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
// DEACTIVATE RIDER
// ─────────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE RIDER
// ─────────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────
// DELETE RIDER
// ─────────────────────────────────────────────────────────────────────────────
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
      ] = await Promise.all([
        Delivery.find(query)
          .populate(
            "rider",
            "name phone"
          )
          .populate(
            "seller",
            "name email"
          )
          .populate(
            "buyer",
            "name email"
          )
          .populate(
            "order",
            "localOrderId amount paymentStatus fulfillmentStatus"
          )
          .sort({
            createdAt: -1,
          })
          .skip(
            (page - 1) * limit
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
            total / limit
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
// Owner or Super Admin only
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
            createdAt: -1,
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
          new Date(b.at) -
          new Date(a.at)
      )
      const start =
        (page - 1) *
        Number(limit)
      const paged =
        allLogs.slice(
          start,
          start +
            Number(limit)
        )
      const total =
        allLogs.length
      res.json({
        logs:
          paged,
        total,
        page:
          Number(page),
        pages:
          Math.ceil(
            total / limit
          ),
      })
    } catch (err) {
      console.error(
        "Audit log error:",
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
      /*
       * Financial revenue means money that has actually
       * reached the RELEASED state.
       *
       * Completed delivery alone is NOT revenue.
       */
      const match = {
        paymentStatus:
          "released",
      }
      if (from || to) {
        match.releasedAt =
          {}
        if (from) {
          match.releasedAt.$gte =
            new Date(from)
        }
        if (to) {
          match.releasedAt.$lte =
            new Date(to)
        }
      }
      const [
        revenue,
        byMethod,
        topSellers,
      ] = await Promise.all([
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
              totalSellerPayouts: {
                $sum:
                  "$sellerAmount",
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
          revenue[0] || {
            totalRevenue: 0,
            totalVolume: 0,
            totalSellerPayouts:
              0,
            totalOrders: 0,
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
      console.error(
        "Financial report error:",
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
// SECURITY ACTIVITY
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
              count: -1,
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
            suspendedAt: -1,
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
            updatedAt: -1,
          })
          .limit(20)
      res.json({
        suspicious,
        suspendedUsers,
        flaggedListings,
      })
    } catch (err) {
      console.error(
        "Security activity error:",
        err
      )
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)
export default router

import mongoose from "mongoose"
import express from "express"

import User from "../models/User.js"
import Listing from "../models/Listing.js"
import Order from "../models/Order.js"
import Rider from "../models/Rider.js"
import { syncRiderOnlineRoom, notify } from "../services/notify.js"
import Delivery from "../models/Delivery.js"
import Admin from "../models/Admin.js"
import Payment from "../models/Payment.js"
import { getEnvironmentMode } from "../models/Environment.js"

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

          Order.countDocuments({ environment: { $ne: "testing" } }),

          Rider.countDocuments(),

          Order.countDocuments({
            paymentStatus:
              "released",
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
          }),

          Order.countDocuments({
            paymentStatus:
              "escrow_held",
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
          }),

          Order.countDocuments({
            environment: { $ne: "testing" },
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
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
          }),

          Order.countDocuments({
            paymentStatus:
              "refund_pending",
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
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
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
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
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
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
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
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
              environment: { $ne: "testing" },
              isSimulatedPayment: { $ne: true },
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

router.get(
  "/dashboard/trends",
  async (req, res) => {
    try {
      const DAY = 86400000
      const since = new Date(); since.setHours(0, 0, 0, 0); since.setTime(since.getTime() - 13 * DAY)
      const day = field => ({ $dateToString: { format: "%Y-%m-%d", date: field } })
      const live = { createdAt: { $gte: since }, cancelled: { $ne: true } }
      const [orderDays, signupDays, categories, topSellers, recentOrders, recentUsers, mix] = await Promise.all([
        Order.aggregate([{ $match: live }, { $group: { _id: day("$createdAt"), orders: { $sum: 1 }, volume: { $sum: "$amount" } } }]),
        User.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: day("$createdAt"), signups: { $sum: 1 } } }]),
        Listing.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 6 }]),
        Order.aggregate([
          { $match: { paymentStatus: { $in: ["escrow_held", "release_pending", "released"] } } },
          { $group: { _id: "$seller", volume: { $sum: "$amount" }, orders: { $sum: 1 } } },
          { $sort: { volume: -1 } }, { $limit: 5 },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
          { $project: { name: { $arrayElemAt: ["$u.name", 0] }, volume: 1, orders: 1 } },
        ]),
        Order.find().sort({ createdAt: -1 }).limit(8).populate("listing", "title").select("amount paymentStatus createdAt payerName listing environment").lean(),
        User.find().sort({ createdAt: -1 }).limit(5).select("name university createdAt").lean(),
        Order.aggregate([{ $group: { _id: "$paymentStatus", count: { $sum: 1 } } }]),
      ])
      const ordersByDay = new Map(orderDays.map(d => [d._id, d])), signupsByDay = new Map(signupDays.map(d => [d._id, d.signups]))
      const days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(since.getTime() + i * DAY), key = d.toISOString().slice(0, 10)
        const o = ordersByDay.get(key)
        return { date: key, orders: o?.orders || 0, volume: o?.volume || 0, signups: signupsByDay.get(key) || 0 }
      })
      const recent = [
        ...recentOrders.map(o => ({ type: "order", title: `${o.payerName || "A buyer"} ordered ${o.listing?.title || "an item"}`, detail: `GH\u20B5${Number(o.amount || 0).toLocaleString()} \u00B7 ${o.paymentStatus}${o.environment === "testing" ? " \u00B7 test" : ""}`, at: o.createdAt })),
        ...recentUsers.map(u => ({ type: "signup", title: `${u.name} joined`, detail: u.university || "", at: u.createdAt })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10)
      res.json({
        days,
        categories: categories.filter(c => c._id).map(c => ({ name: c._id, count: c.count })),
        topSellers: topSellers.filter(s => s.name).map(s => ({ name: s.name, volume: s.volume, orders: s.orders })),
        mix: Object.fromEntries(mix.map(m => [m._id || "unknown", m.count])),
        recent,
      })
    } catch (err) {
      console.error("Admin trends error:", err)
      res.status(500).json({ message: err.message })
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

// Edit a user's basic details (Owner / Super Admin only, always audited).
router.put(
  "/users/:id",
  requireOwnerOrSuperAdmin,
  async (req, res) => {
    try {
      const user = await User.findById(req.params.id)
      if (!user) return res.status(404).json({ message: "User not found." })
      const changes = {}
      for (const field of ["name", "phone", "university"]) {
        if (req.body?.[field] === undefined) continue
        const value = String(req.body[field]).trim()
        if (field === "name" && value.length < 2) return res.status(400).json({ message: "Name must be at least 2 characters." })
        if (value.length > 120) return res.status(400).json({ message: `${field} is too long.` })
        if (value !== (user[field] || "")) { changes[field] = { from: user[field] || "", to: value }; user[field] = value }
      }
      if (!Object.keys(changes).length) return res.json({ message: "Nothing to change.", user })
      await user.save()
      await logAction(req, "user_edited", "user", user._id.toString(), { userEmail: user.email, changes })
      res.json({ message: `${user.name} updated.`, user })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  }
)

// Edit a listing's details (Owner / Super Admin only, always audited).
router.put(
  "/listings/:id",
  requireOwnerOrSuperAdmin,
  async (req, res) => {
    try {
      const listing = await Listing.findById(req.params.id)
      if (!listing) return res.status(404).json({ message: "Listing not found." })
      const changes = {}
      const text = { title: 160, desc: 4000, category: 80, condition: 80 }
      for (const [field, max] of Object.entries(text)) {
        if (req.body?.[field] === undefined) continue
        const value = String(req.body[field]).trim()
        if ((field === "title" || field === "category") && !value) return res.status(400).json({ message: `${field} cannot be empty.` })
        if (value.length > max) return res.status(400).json({ message: `${field} is too long.` })
        if (value !== (listing[field] || "")) { changes[field] = { from: listing[field] || "", to: value }; listing[field] = value }
      }
      for (const field of ["price", "dailyRate", "maxDays"]) {
        if (req.body?.[field] === undefined || req.body[field] === "") continue
        const n = Number(req.body[field])
        if (!Number.isFinite(n) || n <= 0 || n > 10000000) return res.status(400).json({ message: `${field} must be a positive number.` })
        if (field === "maxDays" && !Number.isInteger(n)) return res.status(400).json({ message: "maxDays must be a whole number." })
        if (n !== listing[field]) { changes[field] = { from: listing[field], to: n }; listing[field] = n }
      }
      if (!Object.keys(changes).length) return res.json({ message: "Nothing to change.", listing })
      await listing.save()
      await logAction(req, "listing_edited", "listing", listing._id.toString(), { title: listing.title, changes })
      res.json({ message: `"${listing.title}" updated.`, listing })
    } catch (err) {
      res.status(500).json({ message: err.message })
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
  requireAnyPermission("manage_orders", "manage_payments"),
  async (req, res) => {
    const session = await mongoose.startSession()
    let result = null

    try {
      // MongoDB transactions require a replica set or sharded cluster.
      // Fail closed rather than partially modifying financial balances.
      await session.withTransaction(async () => {
        const order = await Order.findById(req.params.id).session(session)
        if (!order) {
          const err = new Error("Order not found.")
          err.httpStatus = 404
          throw err
        }

        if (order.environment === "testing" || order.isSimulatedPayment) {
          const err = new Error("Simulated orders cannot use real settlement operations.")
          err.httpStatus = 403
          throw err
        }
        if ((await getEnvironmentMode()) !== "live") {
          const err = new Error("Real settlement is disabled outside Live Mode.")
          err.httpStatus = 403
          throw err
        }
        if (order.paymentStatus !== "release_pending" ||
            order.fulfillmentStatus !== "completed") {
          const err = new Error("Order must have completed fulfillment and be awaiting release.")
          err.httpStatus = 409
          throw err
        }

        const delivery = await Delivery.findOne({
          order: order._id,
          status: "completed",
        }).sort({ completedAt: -1, updatedAt: -1 }).session(session)

        const deliveryFee = delivery?.rider ? Number(delivery.deliveryFee) : 0
        if (!Number.isFinite(deliveryFee) || deliveryFee < 0) {
          const err = new Error("Invalid rider delivery fee.")
          err.httpStatus = 409
          throw err
        }

        if (delivery?.rider && deliveryFee > 0) {
          // Atomic conditional decrement protects against insufficient balance.
          const riderResult = await Rider.updateOne(
            { _id: delivery.rider, pendingEarnings: { $gte: deliveryFee } },
            {
              $inc: {
                pendingEarnings: -deliveryFee,
                totalEarned: deliveryFee,
                totalPaid: deliveryFee,
              },
            },
            { session }
          )
          if (riderResult.modifiedCount !== 1) {
            const err = new Error("Rider pending earnings are insufficient; release stopped.")
            err.httpStatus = 409
            throw err
          }
        } else if (delivery?.rider) {
          const riderExists = await Rider.exists({ _id: delivery.rider }).session(session)
          if (!riderExists) {
            const err = new Error("Delivery rider record not found.")
            err.httpStatus = 409
            throw err
          }
        }

        // Compare-and-swap ensures that only one request can release the order.
        const updatedOrder = await Order.findOneAndUpdate(
          {
            _id: order._id,
            environment: { $ne: "testing" },
            isSimulatedPayment: { $ne: true },
            paymentStatus: "release_pending",
            fulfillmentStatus: "completed",
          },
          { $set: { paymentStatus: "released", status: "Completed", releasedAt: new Date() } },
          { new: true, session, runValidators: true }
        )
        if (!updatedOrder) {
          const err = new Error("Order was modified during settlement. Retry after refreshing.")
          err.httpStatus = 409
          throw err
        }

        result = {
          order: updatedOrder,
          delivery,
          deliveryFee,
          riderSettlement: delivery?.rider ? deliveryFee : 0,
        }
      })

      // Audit is intentionally after commit. A failure to write the audit
      // must not cause the client to retry a committed financial settlement.
      try {
        await logAction(req, "order_released", "order", String(result.order._id), {
          localOrderId: result.order.localOrderId,
          amount: Number(result.order.amount || 0),
          sellerAmount: Number(result.order.sellerAmount || 0),
          platformFee: Number(result.order.platformFee || 0),
          paymentMethod: result.order.paymentMethod,
          previousPaymentStatus: "release_pending",
          paymentStatus: "released",
          deliveryId: result.delivery?._id || null,
          riderId: result.delivery?.rider || null,
          deliveryFee: result.deliveryFee,
          riderSettlement: result.riderSettlement,
        })
      } catch (auditError) {
        console.error("CRITICAL: Settlement committed but audit write failed:", auditError)
      }

      return res.json({
        message: "Order released and settlement recorded.",
        order: result.order,
        settlement: {
          riderId: result.delivery?.rider || null,
          riderAmount: result.riderSettlement,
          sellerAmount: Number(result.order.sellerAmount || 0),
          platformFee: Number(result.order.platformFee || 0),
        },
      })
    } catch (err) {
      console.error("Order release error:", err)
      return res.status(err.httpStatus || 503).json({
        message: err.httpStatus ? err.message : "Settlement could not be completed safely. No partial settlement should be committed.",
      })
    } finally {
      await session.endSession()
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

      // Test orders must never enter the real financial ledger.
      if (order.environment === "testing" || order.isSimulatedPayment) {
        return res.status(403).json({ message: "Simulated orders cannot use real settlement or refund operations." })
      }
      if ((await getEnvironmentMode()) !== "live") {
        return res.status(403).json({ message: "Real financial operations are disabled outside Live Mode." })
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

      // Test orders must never enter the real financial ledger.
      if (order.environment === "testing" || order.isSimulatedPayment) {
        return res.status(403).json({ message: "Simulated orders cannot use real settlement or refund operations." })
      }
      if ((await getEnvironmentMode()) !== "live") {
        return res.status(403).json({ message: "Real financial operations are disabled outside Live Mode." })
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

// Riders waiting for an identity decision (not yet approved, or photo not approved).
router.get(
  "/riders/review",
  requirePermission("manage_riders"),
  async (req, res) => {
    try {
      const riders = await Rider.find({ $or: [{ isApproved: false }, { photoReviewStatus: { $ne: "approved" } }] })
        .select("name phone email university vehicle isActive isApproved isTestRider photoUrl photoReviewStatus createdAt")
        .sort({ createdAt: -1 }).limit(100).lean()
      res.json(riders)
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  }
)

// Identity decision: approve (lets the rider take jobs), reject, or revoke an earlier approval.
router.put(
  "/riders/:id/review",
  requirePermission("manage_riders"),
  async (req, res) => {
    try {
      const decision = req.body?.decision
      if (!["approve", "reject", "revoke"].includes(decision)) {
        return res.status(400).json({ message: "decision must be approve, reject or revoke." })
      }
      const rider = await Rider.findById(req.params.id)
      if (!rider) return res.status(404).json({ message: "Rider not found." })
      if (decision === "approve" && !rider.photoUrl) {
        return res.status(409).json({ message: "This rider has not uploaded a photo yet." })
      }
      if (typeof req.body?.isTestRider === "boolean" && req.body.isTestRider !== !!rider.isTestRider) {
        if (rider.activeDelivery) return res.status(409).json({ message: "This rider has an active delivery. Finish it before switching test/live mode." })
        rider.isTestRider = req.body.isTestRider
      }
      rider.photoReviewedAt = new Date()
      if (decision === "approve") { rider.photoReviewStatus = "approved"; rider.isApproved = true }
      else {
        rider.photoReviewStatus = decision === "reject" ? "rejected" : "pending"
        rider.isApproved = false
        rider.isOnline = false
      }
      await rider.save()
      syncRiderOnlineRoom(req.app, rider._id, rider.isOnline, rider.isTestRider)
      const stamp = rider.photoReviewedAt.getTime()
      if (decision === "approve") notify(req.app, { recipient: rider._id, recipientModel: "Rider", type: "rider_approved", title: "You are approved", message: "Your identity was verified. Go online to start receiving delivery jobs.", dedupeKey: `rider_approved:${rider._id}:${stamp}` })
      if (decision === "reject") notify(req.app, { recipient: rider._id, recipientModel: "Rider", type: "rider_rejected", title: "Identity review needs attention", message: "We could not approve your photo. Please upload a clear, well-lit photo of your face, or contact support.", dedupeKey: `rider_rejected:${rider._id}:${stamp}` })
      await logAction(req, "rider_identity_reviewed", "rider", rider._id.toString(), { name: rider.name, decision, isTestRider: !!rider.isTestRider })
      res.json({ message: `${rider.name}: ${decision}d.`.replace("rejectd", "rejected").replace("revoked.", "revoked."), isApproved: rider.isApproved, photoReviewStatus: rider.photoReviewStatus })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  }
)

// Mark a rider as a TEST rider (sees and accepts Testing Mode jobs only) or back to a real rider.
router.put(
  "/riders/:id/test-mode",
  requirePermission("manage_riders"),
  async (req, res) => {
    try {
      if (typeof req.body?.isTestRider !== "boolean") {
        return res.status(400).json({ message: "isTestRider must be true or false." })
      }
      const rider = await Rider.findById(req.params.id)
      if (!rider) return res.status(404).json({ message: "Rider not found." })
      if (rider.activeDelivery) {
        return res.status(409).json({ message: "This rider has an active delivery. Finish or cancel it first." })
      }
      rider.isTestRider = req.body.isTestRider
      rider.isOnline = false
      await rider.save()
      syncRiderOnlineRoom(req.app, rider._id, false, rider.isTestRider)
      await logAction(req, "rider_test_mode_changed", "rider", rider._id.toString(), {
        name: rider.name,
        isTestRider: rider.isTestRider,
      })
      res.json({ message: `${rider.name} is now a ${rider.isTestRider ? "test" : "real"} rider.`, isTestRider: rider.isTestRider })
    } catch (err) {
      res.status(500).json({ message: err.message })
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

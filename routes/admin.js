import express from "express"
import User    from "../models/User.js"
import Listing from "../models/Listing.js"
import Order   from "../models/Order.js"
import Rider   from "../models/Rider.js"
import Delivery from "../models/Delivery.js"
import {
  requireAdminAuth,
  requireOwnerOrSuperAdmin,
  requirePermission,
  requireAnyPermission,
  logAction,
} from "../middleware/adminAuth.js"

const router = express.Router()

// All admin routes require a valid admin JWT
router.use(requireAdminAuth)

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — available to all authenticated admins
// ─────────────────────────────────────────────────────────────────────────────

router.get("/dashboard", async (req, res) => {
  try {
    const [
      totalUsers,
      totalListings,
      totalOrders,
      totalRiders,
      completedOrders,
      escrowOrders,
      pendingOrders,
      totalDeliveries,
      activeDeliveries,
    ] = await Promise.all([
      User.countDocuments(),
      Listing.countDocuments(),
      Order.countDocuments(),
      Rider.countDocuments(),
      Order.countDocuments({ status: "Completed" }),
      Order.countDocuments({ status: "In Escrow" }),
      Order.countDocuments({ status: { $in: ["Pending", "Pending Confirmation"] } }),
      Delivery.countDocuments(),
      Delivery.countDocuments({ status: { $in: ["accepted", "picked_up", "delivered"] } }),
    ])

    // Revenue — sum of platformFee on completed orders
    const revenueAgg = await Order.aggregate([
      { $match: { status: "Completed" } },
      { $group: { _id: null, total: { $sum: "$platformFee" }, volume: { $sum: "$amount" } } },
    ])
    const revenue      = revenueAgg[0]?.total  || 0
    const totalVolume  = revenueAgg[0]?.volume || 0

    const escrowAgg = await Order.aggregate([
      { $match: { status: "In Escrow" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ])
    const escrowHeld = escrowAgg[0]?.total || 0

    res.json({
      users:            totalUsers,
      listings:         totalListings,
      orders:           totalOrders,
      riders:           totalRiders,
      completedOrders,
      escrowOrders,
      pendingOrders,
      totalDeliveries,
      activeDeliveries,
      revenue,
      totalVolume,
      escrowHeld,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// USERS — user_seller role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/users", requirePermission("view_users"), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = "", status } = req.query
    const query = {}

    if (search.trim()) {
      query.$or = [
        { name:  { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ]
    }
    if (status) query.status = status

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-passwordHash")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      User.countDocuments(query),
    ])

    res.json({ users, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/users/:id/suspend", requirePermission("suspend_accounts"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: "User not found." })

    user.status     = "Suspended"
    user.suspendedAt = new Date()
    await user.save()

    await logAction(req, "user_suspended", "user", user._id.toString(), {
      userEmail: user.email, reason: req.body.reason || "",
    })

    res.json({ message: `User ${user.email} suspended.`, user })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/users/:id/reinstate", requirePermission("suspend_accounts"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: "User not found." })

    user.status      = "Active"
    user.suspendedAt = null
    await user.save()

    await logAction(req, "user_reinstated", "user", user._id.toString(), {
      userEmail: user.email,
    })

    res.json({ message: `User ${user.email} reinstated.`, user })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.delete("/users/:id", requireOwnerOrSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: "User not found." })

    await User.findByIdAndDelete(req.params.id)

    await logAction(req, "user_deleted", "user", req.params.id, {
      userEmail: user.email,
    })

    res.json({ message: `User ${user.email} permanently deleted.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// LISTINGS — user_seller or moderation role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/listings", requireAnyPermission("view_listings", "manage_listings"), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = "", status, type } = req.query
    const query = {}

    if (search.trim()) {
      query.$or = [
        { title:    { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ]
    }
    if (status) query.status = status
    if (type)   query.type   = type

    const [listings, total] = await Promise.all([
      Listing.find(query)
        .populate("seller", "name email university")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Listing.countDocuments(query),
    ])

    res.json({ listings, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/listings/:id/flag", requireAnyPermission("flag_content", "manage_listings"), async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found." })

    listing.status = "Flagged"
    await listing.save()

    await logAction(req, "listing_flagged", "listing", listing._id.toString(), {
      title: listing.title, reason: req.body.reason || "",
    })

    res.json({ message: "Listing flagged.", listing })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.delete("/listings/:id", requireAnyPermission("remove_listings", "manage_listings"), async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found." })

    await Listing.findByIdAndDelete(req.params.id)

    await logAction(req, "listing_removed", "listing", req.params.id, {
      title: listing.title, reason: req.body.reason || "",
    })

    res.json({ message: "Listing removed." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ORDERS — operations or finance role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/orders", requireAnyPermission("view_orders", "view_payments"), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = "", status } = req.query
    const query = {}

    if (search.trim()) query.localOrderId = { $regex: search, $options: "i" }
    if (status) query.status = status

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate("listing", "title")
        .populate("buyer",   "name email")
        .populate("seller",  "name email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Order.countDocuments(query),
    ])

    res.json({ orders, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/orders/:id/release", requireAnyPermission("manage_orders", "manage_payments"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found." })
    if (order.status === "Completed") return res.status(400).json({ message: "Order already completed." })

    order.status = "Completed"
    await order.save()

    await logAction(req, "order_released", "order", order._id.toString(), {
      localOrderId: order.localOrderId, amount: order.amount,
    })

    res.json({ message: "Payment released to seller.", order })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/orders/:id/refund", requireAnyPermission("manage_orders", "manage_refunds", "issue_refund_decisions"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found." })
    if (order.status === "Refunded") return res.status(400).json({ message: "Order already refunded." })

    order.status    = "Refunded"
    order.cancelled = true
    await order.save()

    await logAction(req, "order_refunded", "order", order._id.toString(), {
      localOrderId: order.localOrderId, amount: order.amount, reason: req.body.reason || "",
    })

    res.json({ message: "Order refunded.", order })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RIDERS — delivery role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/riders", requirePermission("view_riders"), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = "" } = req.query
    const query = {}

    if (search.trim()) {
      query.$or = [
        { name:  { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { zone:  { $regex: search, $options: "i" } },
      ]
    }

    const [riders, total] = await Promise.all([
      Rider.find(query).select("-passwordHash").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Rider.countDocuments(query),
    ])

    res.json({ riders, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/riders/:id/deactivate", requirePermission("manage_riders"), async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    rider.isActive = false
    await rider.save()

    await logAction(req, "rider_deactivated", "rider", rider._id.toString(), {
      name: rider.name, reason: req.body.reason || "",
    })

    res.json({ message: `Rider ${rider.name} deactivated.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put("/riders/:id/activate", requirePermission("manage_riders"), async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    rider.isActive = true
    await rider.save()

    await logAction(req, "rider_activated", "rider", rider._id.toString(), {
      name: rider.name,
    })

    res.json({ message: `Rider ${rider.name} activated.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.delete("/riders/:id", requireOwnerOrSuperAdmin, async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id)
    if (!rider) return res.status(404).json({ message: "Rider not found." })

    await Rider.findByIdAndDelete(req.params.id)

    await logAction(req, "rider_deleted", "rider", req.params.id, {
      name: rider.name,
    })

    res.json({ message: `Rider ${rider.name} permanently deleted.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERIES — delivery or operations role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/deliveries", requireAnyPermission("view_deliveries", "view_delivery_status"), async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query
    const query = {}
    if (status) query.status = status

    const [deliveries, total] = await Promise.all([
      Delivery.find(query)
        .populate("rider",  "name phone")
        .populate("seller", "name email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Delivery.countDocuments(query),
    ])

    res.json({ deliveries, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS — owner or super admin
// ─────────────────────────────────────────────────────────────────────────────

router.get("/audit-logs", requireOwnerOrSuperAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query

    // Pull audit logs from all admins
    const admins = await Admin.find().select("name email role auditLog").sort({ createdAt: -1 })

    const allLogs = []
    admins.forEach(admin => {
      admin.auditLog.forEach(entry => {
        allLogs.push({
          ...entry.toObject(),
          adminName:  admin.name,
          adminEmail: admin.email,
          adminRole:  admin.role,
        })
      })
    })

    // Sort by most recent
    allLogs.sort((a, b) => new Date(b.at) - new Date(a.at))

    const start  = (page - 1) * limit
    const paged  = allLogs.slice(start, start + Number(limit))
    const total  = allLogs.length

    res.json({ logs: paged, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL REPORTS — finance role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/reports/financial", requirePermission("view_financial_reports"), async (req, res) => {
  try {
    const { from, to } = req.query
    const match = { status: "Completed" }

    if (from || to) {
      match.createdAt = {}
      if (from) match.createdAt.$gte = new Date(from)
      if (to)   match.createdAt.$lte = new Date(to)
    }

    const [revenue, byMethod, topSellers] = await Promise.all([
      Order.aggregate([
        { $match: match },
        { $group: {
          _id:          null,
          totalRevenue: { $sum: "$platformFee" },
          totalVolume:  { $sum: "$amount" },
          totalOrders:  { $sum: 1 },
          avgOrderValue:{ $avg: "$amount" },
        }},
      ]),
      Order.aggregate([
        { $match: match },
        { $group: {
          _id:   "$paymentMethod",
          count: { $sum: 1 },
          total: { $sum: "$amount" },
        }},
      ]),
      Order.aggregate([
        { $match: match },
        { $group: {
          _id:           "$seller",
          totalSales:    { $sum: "$amount" },
          orderCount:    { $sum: 1 },
          totalEarnings: { $sum: "$sellerAmount" },
        }},
        { $sort:  { totalSales: -1 } },
        { $limit: 10 },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "seller" } },
        { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
        { $project: {
          sellerName:    "$seller.name",
          sellerEmail:   "$seller.email",
          totalSales:    1,
          orderCount:    1,
          totalEarnings: 1,
        }},
      ]),
    ])

    res.json({
      summary:    revenue[0]  || { totalRevenue: 0, totalVolume: 0, totalOrders: 0, avgOrderValue: 0 },
      byMethod,
      topSellers,
      period:     { from: from || "all time", to: to || "now" },
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY — security role
// ─────────────────────────────────────────────────────────────────────────────

router.get("/security/activity", requirePermission("view_activity_logs"), async (req, res) => {
  try {
    // Recent orders with unusual patterns — multiple orders from same payer phone in 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

    const suspicious = await Order.aggregate([
      { $match: { createdAt: { $gte: oneHourAgo } } },
      { $group: { _id: "$payerPhone", count: { $sum: 1 }, orders: { $push: "$localOrderId" } } },
      { $match: { count: { $gte: 3 } } },
      { $sort:  { count: -1 } },
    ])

    // Recently suspended users
    const suspendedUsers = await User.find({ status: "Suspended" })
      .select("name email suspendedAt")
      .sort({ suspendedAt: -1 })
      .limit(20)

    // Flagged listings
    const flaggedListings = await Listing.find({ status: "Flagged" })
      .populate("seller", "name email")
      .sort({ updatedAt: -1 })
      .limit(20)

    res.json({ suspicious, suspendedUsers, flaggedListings })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router


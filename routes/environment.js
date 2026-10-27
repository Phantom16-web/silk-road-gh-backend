import express from "express"
import mongoose from "mongoose"
import Environment, { getEnvironmentMode } from "../models/Environment.js"
import Order from "../models/Order.js"
import Delivery from "../models/Delivery.js"
import Payment from "../models/Payment.js"
import CheckoutGroup from "../models/CheckoutGroup.js"
import { requireAdminAuth, requireOwner, requireReAuth, logAction } from "../middleware/adminAuth.js"

const router = express.Router()
const switchingEnabled = () => process.env.ENABLE_ENVIRONMENT_SWITCH === "true"
const cleanupEnabled = () => process.env.ENABLE_DEV_RECORD_PURGE === "true"
const legacyFilter = { environment: { $ne: "testing" }, isSimulatedPayment: { $ne: true } }

// Conservative preflight, not atomic against newly created orders. Keep checkout
// traffic stopped while switching environments.
async function switchBlockers(targetMode) {
  const leaving = targetMode === "testing" ? "live" : "testing"
  const envFilter = leaving === "live" ? legacyFilter : { environment: "testing" }
  const activeOrders = await Order.find({ ...envFilter, cancelled: { $ne: true }, paymentStatus: { $in: ["escrow_held", "release_pending", "refund_pending", "disputed"] } }).select("_id localOrderId").limit(1).lean()
  const orderIds = await Order.find(envFilter).distinct("_id")
  const activeDeliveries = orderIds.length ? await Delivery.exists({ order: { $in: orderIds }, status: { $in: ["accepted", "picked_up", "delivered"] } }) : null
  const openPayment = leaving === "live" && orderIds.length ? await Payment.exists({ order: { $in: orderIds }, status: { $in: ["pending", "submitted", "under_review"] } }) : null
  return { unsettledOrders: Boolean(activeOrders.length), activeDeliveries: Boolean(activeDeliveries), openPayments: Boolean(openPayment) }
}

router.get("/", async (_req, res) => {
  try { const mode = await getEnvironmentMode(); return res.json({ mode, isTesting: mode === "testing", realPaymentsEnabled: mode === "live" }) }
  catch (error) { console.error("Environment status error:", error); return res.status(503).json({ message: "Unable to retrieve environment status." }) }
})
router.get("/owner", requireAdminAuth, requireOwner, async (_req, res) => {
  try { const env = await Environment.findById("global"); return res.json({ mode: env?.mode || "live", changedBy: env?.changedBy || null, changedAt: env?.changedAt || null, switchingEnabled: switchingEnabled(), cleanupEnabled: cleanupEnabled() }) }
  catch (error) { console.error("Owner environment lookup error:", error); return res.status(503).json({ message: "Unable to retrieve environment configuration." }) }
})

// Only explicitly selected orders are eligible. Never delete any order with a
// Payment, CheckoutGroup, Paystack reference or payment verification evidence.
async function inspect(order) {
  const [paymentCount, groupCount, deliveries] = await Promise.all([
    Payment.countDocuments({ order: order._id }),
    CheckoutGroup.countDocuments({ orderIds: order._id }),
    Delivery.find({ order: order._id }).select("_id status localOrderId").lean(),
  ])
  const reasons = []
  if (paymentCount) reasons.push("Payment records exist; independently reconcile funds first")
  if (groupCount) reasons.push("Checkout group exists; group settlement must be reviewed")
  if (order.paystackRef) reasons.push("Paystack reference exists")
  if (order.paymentVerifiedAt || order.releasedAt || order.refundedAt) reasons.push("Payment verification, payout or refund timestamp exists")
  if (order.environment === "testing" || order.isSimulatedPayment === true) reasons.push("Not a legacy Live Mode record")
  return { id: String(order._id), localOrderId: order.localOrderId || null, environment: order.environment || "legacy-live", paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, deliveryStatuses: deliveries.map(d => d.status), deliveryCount: deliveries.length, eligible: reasons.length === 0, reasons }
}

router.get("/owner/dev-records", requireAdminAuth, requireOwner, async (_req, res) => {
  try {
    const orders = await Order.find(legacyFilter).select("_id localOrderId environment paymentStatus paymentMethod paystackRef paymentVerifiedAt releasedAt refundedAt isSimulatedPayment").sort({ createdAt: -1 }).limit(200).lean()
    const records = await Promise.all(orders.map(inspect))
    const blockers = await switchBlockers("testing")
    return res.json({ records, blockers, truncated: orders.length === 200, cleanupEnabled: cleanupEnabled(), warning: "PERMANENT DELETION. Only select records independently confirmed to be fake and unpaid. Deleted data cannot be recovered without a backup." })
  } catch (error) { console.error("Development records inspection error:", error); return res.status(500).json({ message: "Unable to inspect records." }) }
})

router.post("/owner/dev-records/purge", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  if (!cleanupEnabled()) return res.status(503).json({ message: "Purge is disabled. Set ENABLE_DEV_RECORD_PURGE=true temporarily during maintenance." })
  if (req.body?.confirmation !== "PERMANENTLY DELETE TEST RECORDS") return res.status(400).json({ message: "Exact permanent-deletion confirmation required." })
  const ids = req.body?.orderIds
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => !mongoose.isValidObjectId(id))) return res.status(400).json({ message: "Choose 1–50 unique valid order IDs." })
  let session
  try {
    // MongoDB Atlas replica sets support transactions. No partial deletion on error.
    session = await mongoose.startSession()
    let deletedOrders = 0, deletedDeliveries = 0
    await session.withTransaction(async () => {
      const orders = await Order.find({ _id: { $in: ids }, ...legacyFilter }).session(session).lean()
      if (orders.length !== ids.length) throw new Error("Some selected orders no longer exist or are not legacy Live Mode records")
      for (const order of orders) {
        const [payments, groups] = await Promise.all([
          Payment.countDocuments({ order: order._id }).session(session),
          CheckoutGroup.countDocuments({ orderIds: order._id }).session(session),
        ])
        if (payments || groups || order.paystackRef || order.paymentVerifiedAt || order.releasedAt || order.refundedAt) throw new Error(`Order ${order.localOrderId || order._id} has financial evidence; deletion refused`)
      }
      const d = await Delivery.deleteMany({ order: { $in: ids } }).session(session)
      const o = await Order.deleteMany({ _id: { $in: ids }, ...legacyFilter }).session(session)
      if (o.deletedCount !== ids.length) throw new Error("Order deletion count mismatch; rolled back")
      deletedOrders = o.deletedCount
      deletedDeliveries = d.deletedCount
    })
    await logAction(req, "owner_permanent_dev_records_purge", "orders", "batch", { deletedOrders, deletedDeliveries, orderIds: ids })
    return res.json({ deletedOrders, deletedDeliveries, message: "Selected development records permanently deleted. Review remaining blockers before switching." })
  } catch (error) { console.error("Permanent development record purge rejected:", error); return res.status(409).json({ message: error.message || "Purge failed and was rolled back." }) }
  finally { if (session) await session.endSession() }
})

// One-time development reset. Only pending/failed/unsubmitted artifacts with no
// settlement evidence may be erased. Never assume a record is fake from its age.
router.post("/owner/reset-development-and-test", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  if (!cleanupEnabled() || !switchingEnabled()) return res.status(503).json({ message: "Enable both ENABLE_DEV_RECORD_PURGE and ENABLE_ENVIRONMENT_SWITCH during maintenance." })
  if (req.body?.confirmation !== "DELETE ALL DEVELOPMENT RECORDS AND SWITCH TO TESTING") return res.status(400).json({ message: "Exact irreversible-deletion confirmation required." })
  if (!String(process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_test_")) return res.status(409).json({ message: "A Paystack test secret key is required before switching." })
  let session
  try {
    session = await mongoose.startSession()
    let result
    await session.withTransaction(async () => {
      const env = await Environment.findById("global").session(session)
      if (env && env.mode !== "live") throw new Error("Marketplace must currently be in Live Mode")
      const orders = await Order.find(legacyFilter).session(session).lean()
      const ids = orders.map(o => o._id)
      const [payments, groups, allDeliveries] = await Promise.all([
        Payment.find({}).session(session).lean(),
        CheckoutGroup.find({ environment: { $ne: "testing" } }).session(session).lean(),
        Delivery.find({}).select("_id order localOrderId status").session(session).lean(),
      ])
      const idSet = new Set(ids.map(String))
      const orderRefs = new Set(orders.map(o => o.localOrderId).filter(Boolean))
      const badOrders = orders.filter(o =>
        o.paystackRef || o.paymentVerifiedAt || o.releasedAt || o.refundedAt ||
        ["escrow_held", "release_pending", "released", "refund_pending", "refunded", "disputed"].includes(o.paymentStatus) && !o.isSimulatedPayment
      )
      if (badOrders.length) throw new Error(`Review required: ${badOrders.length} legacy orders have payment or settlement indicators. No records were deleted.`)
      const unsafePayments = payments.filter(p =>
        !idSet.has(String(p.order)) ||
        !["pending", "failed"].includes(p.status) ||
        p.providerReference || p.buyerReference || p.evidenceUrl || p.verifiedAt ||
        p.verificationStartedAt || p.refundRequestedAt || p.refundReference ||
        p.refundedAt || p.providerData
      )
      if (unsafePayments.length) throw new Error(`Review required: ${unsafePayments.length} of ${payments.length} payment records are unlinked or contain payment/provider/verification evidence. No records were deleted.`)
      const unsafeGroups = groups.filter(g =>
        !["pending", "cancelled", "rejected"].includes(g.status) ||
        !Array.isArray(g.orderIds) || !g.orderIds.length ||
        g.orderIds.some(id => !idSet.has(String(id))) ||
        !orderRefs.has(g.localOrderId) ||
        g.buyerReference || g.evidenceUrl || g.submittedAt || g.verifiedAt ||
        g.refundRequestedAt || g.disputeOpenedAt ||
        (g.paymentMethod === "paystack" && g.status !== "cancelled" && g.status !== "rejected")
      )
      if (unsafeGroups.length) throw new Error(`Review required: ${unsafeGroups.length} of ${groups.length} checkout groups have payment evidence, unsafe status or unlinked orders. No records were deleted.`)
      const linkedDeliveries = allDeliveries.filter(d => idSet.has(String(d.order)))
      const orphanActive = allDeliveries.filter(d =>
        ["accepted", "picked_up", "delivered"].includes(d.status) && !idSet.has(String(d.order))
      )
      if (orphanActive.length) throw new Error(`Review required: ${orphanActive.length} active deliveries are not linked to removable legacy orders. No records were deleted.`)
      // Delete only the reviewed document IDs; do not touch testing records.
      const paymentIds = payments.map(p => p._id)
      const groupIds = groups.map(g => g._id)
      const deliveryIds = linkedDeliveries.map(d => d._id)
      const dp = paymentIds.length ? await Payment.deleteMany({ _id: { $in: paymentIds } }).session(session) : { deletedCount: 0 }
      const dg = groupIds.length ? await CheckoutGroup.deleteMany({ _id: { $in: groupIds } }).session(session) : { deletedCount: 0 }
      const dd = deliveryIds.length ? await Delivery.deleteMany({ _id: { $in: deliveryIds } }).session(session) : { deletedCount: 0 }
      const od = ids.length ? await Order.deleteMany({ _id: { $in: ids }, ...legacyFilter }).session(session) : { deletedCount: 0 }
      if (dp.deletedCount !== paymentIds.length || dg.deletedCount !== groupIds.length || dd.deletedCount !== deliveryIds.length || od.deletedCount !== ids.length) throw new Error("Deletion count mismatch; reset rolled back")
      const now = new Date()
      const updated = await Environment.findOneAndUpdate(
        { _id: "global", mode: "live" },
        { $set: { mode: "testing", changedBy: req.adminUser.email, changedAt: now } },
        { new: true, upsert: !env, session, runValidators: true }
      )
      if (!updated || updated.mode !== "testing") throw new Error("Environment switch failed; reset rolled back")
      result = { deletedOrders: od.deletedCount, deletedDeliveries: dd.deletedCount, deletedPayments: dp.deletedCount, deletedCheckoutGroups: dg.deletedCount, mode: "testing" }
    })
    await logAction(req, "owner_development_reset_to_testing", "environment", "global", result)
    return res.json({ ...result, message: "Eligible development records permanently deleted and environment switched to testing." })
  } catch (error) {
    console.error("Owner development reset refused:", error)
    return res.status(409).json({ message: error.message || "Reset refused; no records deleted." })
  } finally { if (session) await session.endSession() }
})

router.put("/mode", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  try {
    if (!switchingEnabled()) return res.status(503).json({ message: "Environment switching is not activated. Complete and verify payment and settlement safeguards first.", code: "ENVIRONMENT_SWITCH_NOT_READY" })
    const { mode } = req.body || {}
    if (!["testing", "live"].includes(mode)) return res.status(400).json({ message: "Mode must be either 'testing' or 'live'." })
    let current = await Environment.findById("global")
    if (!current) {
      try { current = await Environment.create({ _id: "global", mode: "live", changedBy: req.adminUser.email, changedAt: new Date() }) }
      catch (error) { if (error.code !== 11000) throw error; current = await Environment.findById("global"); if (!current) return res.status(503).json({ message: "Environment initialization failed." }) }
    }
    const previousMode = current.mode
    if (previousMode === mode) return res.json({ mode, changed: false, message: `The platform is already in ${mode} mode.` })
    const blockers = await switchBlockers(mode)
    if (Object.values(blockers).some(Boolean)) return res.status(409).json({ message: "Cannot switch environments while transactions or deliveries in the current environment remain active.", code: "ENVIRONMENT_ACTIVE_TRANSACTIONS", blockers })
    const now = new Date()
    const updated = await Environment.findOneAndUpdate({ _id: "global", mode: previousMode }, { $set: { mode, changedBy: req.adminUser.email, changedAt: now } }, { new: true, runValidators: true })
    if (!updated) return res.status(409).json({ message: "Environment configuration changed concurrently. Refresh and try again." })
    await logAction(req, "environment_mode_changed", "environment", "global", { previousMode, newMode: mode, changedAt: now.toISOString() })
    return res.json({ mode: updated.mode, changed: true, changedAt: updated.changedAt, message: `Environment switched to ${updated.mode}.` })
  } catch (error) { console.error("Environment switch error:", error); return res.status(500).json({ message: "Unable to change platform environment." }) }
})
export default router

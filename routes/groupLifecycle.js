import { checkGroup } from "../lib/reconciliationChecks.mjs"
import express from "express"
import mongoose from "mongoose"
import crypto from "crypto"
import protect from "../middleware/auth.js"
import { requireAdminAuth, requirePermission, logAction } from "../middleware/adminAuth.js"
import CheckoutGroup from "../models/CheckoutGroup.js"
import Order from "../models/Order.js"
import GroupFulfillment from "../models/GroupFulfillment.js"
import GroupTransfer from "../models/GroupTransfer.js"
import GroupAuditEvent from "../models/GroupAuditEvent.js"
import Payment from "../models/Payment.js"
import { getEnvironmentMode } from "../models/Environment.js"
const router = express.Router()
const error = (message, status = 409) => Object.assign(new Error(message), { status })
const digest = value => crypto.createHash("sha256").update(value).digest("hex")
const money = n => Math.round(Number(n) * 100)
const isId = id => mongoose.isValidObjectId(id) && /^[a-f\d]{24}$/i.test(String(id))
const validEvidence = ({ externalReference, network, recipient, notes = "" }) =>
  typeof externalReference === "string" && /^[A-Za-z0-9_-]{6,120}$/.test(externalReference.trim()) &&
  typeof network === "string" && /^[A-Za-z0-9_-]{2,32}$/.test(network.trim()) &&
  typeof recipient === "string" && /^[+0-9]{8,18}$/.test(recipient.trim()) &&
  typeof notes === "string" && notes.length <= 2000
const claim = (req, group) => {
  const token = req.headers["x-checkout-token"]
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) &&
    typeof group.claimTokenHash === "string" &&
    crypto.timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(group.claimTokenHash, "hex"))
}
async function runTransaction(res, callback) {
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => { result = await callback(session) })
    return res.json(result)
  } catch (e) {
    console.error("Group lifecycle operation failed:", e)
    return res.status(e.code === 11000 ? 409 : e.status || 500).json({ message: e.code === 11000 ? "This transfer or fulfillment record already exists." : e.status ? e.message : "Operation failed; check reconciliation before retrying." })
  } finally { await session.endSession() }
}
// Seller can view only their own grouped orders. Buyer claim tokens are never returned.
router.get("/seller/orders", protect, async (req,res)=>{
  try {
    const orders=await Order.find({seller:req.user.id,environment:"live",paymentStatus:{$in:["escrow_held","release_pending","released"]}}).select("_id seller listing amount sellerAmount paymentStatus fulfillmentStatus createdAt").sort({createdAt:-1}).limit(100).lean()
    if(!orders.length)return res.json({orders:[]})
    const groups=await CheckoutGroup.find({orderIds:{$in:orders.map(o=>o._id)},environment:"live"}).select("_id orderIds status").lean()
    const groupByOrder=new Map()
    for(const group of groups)for(const id of group.orderIds)if(!groupByOrder.has(String(id)))groupByOrder.set(String(id),group)
    return res.json({orders:orders.filter(o=>groupByOrder.has(String(o._id))).map(o=>({orderId:String(o._id),checkoutId:groupByOrder.get(String(o._id))._id,listingId:String(o.listing),amount:o.amount,sellerAmount:o.sellerAmount,paymentStatus:o.paymentStatus,fulfillmentStatus:o.fulfillmentStatus,groupStatus:groupByOrder.get(String(o._id)).status}))})
  }catch(e){console.error("Seller grouped orders error",e);return res.status(500).json({message:"Unable to load grouped sales."})}
})
// Read-only checkout state for the buyer holding the checkout claim token.
router.get("/:checkoutId/orders", async (req, res) => {
  try {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash")
    if (!group || !claim(req, group)) return res.status(403).json({ message: "Not authorized." })
    const orders = await Order.find({ _id: { $in: group.orderIds } }).select("_id seller listing amount sellerAmount paymentStatus fulfillmentStatus").lean()
    if (orders.length !== group.orderIds.length) return res.status(409).json({ message: "Checkout requires reconciliation." })
    const payouts = await GroupTransfer.find({ checkoutId: group.id, direction: "seller_payout" }).select("order amount verifiedAt").lean()
    const paid = new Set(payouts.map(p => String(p.order)))
    return res.json({ checkoutId: group.id, status: group.status, orders: orders.map(o => ({ orderId: String(o._id), listingId: String(o.listing), sellerId: String(o.seller), amount: o.amount, paymentStatus: o.paymentStatus, fulfillmentStatus: o.fulfillmentStatus, payoutRecorded: paid.has(String(o._id)) })) })
  } catch (e) { return res.status(500).json({ message: "Unable to load checkout orders." }) }
})
// Finance worklist: read-only and permission protected. No transfer is initiated here.
router.get("/admin/settlement-queue", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  try {
    const groups = await CheckoutGroup.find({ status: { $in: ["verified", "refund_pending"] }, environment: "live" }).select("_id amount status orderIds").sort({ updatedAt: -1 }).limit(100).lean()
    const ids = groups.flatMap(g => g.orderIds)
    const orders = await Order.find({ _id: { $in: ids }, paymentStatus: { $in: ["release_pending", "refund_pending"] } }).select("_id seller sellerAmount amount paymentStatus fulfillmentStatus").lean()
    const byId = new Map(orders.map(o => [String(o._id), o]))
    return res.json({ groups: groups.map(g => ({ checkoutId: g._id, status: g.status, amount: g.amount, orders: g.orderIds.map(id => byId.get(String(id))).filter(Boolean).map(o => ({ orderId: String(o._id), sellerId: String(o.seller), sellerAmount: o.sellerAmount, amount: o.amount, paymentStatus: o.paymentStatus, fulfillmentStatus: o.fulfillmentStatus })) })).filter(g => g.orders.length) })
  } catch (e) { return res.status(500).json({ message: "Unable to load settlement queue." }) }
})
// Reconciliation is read-only. Never equate a recorded transfer with an actual bank/MoMo transfer.
router.get("/admin/reconciliation", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const groups = await CheckoutGroup.find({ environment: "live", status: { $in: ["verified", "refund_pending", "disputed", "refunded"] } })
      .select("_id status amount orderIds paymentMethod verifiedAt").sort({ updatedAt: -1 }).limit(limit).lean()
    const orderIds = groups.flatMap(g => g.orderIds)
    const [orders, payments, transfers] = await Promise.all([
      Order.find({ _id: { $in: orderIds } }).select("_id amount sellerAmount platformFee paymentStatus fulfillmentStatus environment").lean(),
      Payment.find({ order: { $in: orderIds } }).select("order amount status method").lean(),
      GroupTransfer.find({ checkoutId: { $in: groups.map(g => g._id) } }).select("checkoutId order direction amount externalReference verifiedAt").lean(),
    ])
    const results = groups.map(g => {
      const issues = checkGroup({group:g, orders, payments, transfers})
      const outgoing = transfers.filter(t=>String(t.checkoutId)===String(g._id))
      return { checkoutId:g._id, status:g.status, amount:g.amount, orderCount:g.orderIds.length,
        sellerPayoutsRecorded:outgoing.filter(t=>t.direction==="seller_payout").length,
        buyerRefundsRecorded:outgoing.filter(t=>t.direction==="buyer_refund").length,
        issues, requiresReview:issues.length>0 }
    })
    res.json({ groups:results, flagged:results.filter(g=>g.requiresReview).length, note:"Read-only database consistency checks; independently reconcile all transfers against external statements." })
  } catch (e) { console.error("Reconciliation error",e); res.status(500).json({ message:"Unable to generate reconciliation report." }) }
})
// Append-only dispute decision history; requires finance permissions.
router.get("/admin/dispute-audit", requireAdminAuth, requirePermission("manage_refunds"), async (req,res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const events = await GroupAuditEvent.find({}).sort({createdAt:-1}).limit(limit).lean()
    return res.json({events})
  } catch(e) { console.error("Dispute audit read failed",e); return res.status(500).json({message:"Unable to load dispute audit."}) }
})
// Freeze a whole verified checkout during a dispute. Payouts are blocked by group.status.
// If any seller was already settled, the dispute is flagged for manual recovery,
// rather than pretending funds can be held or refunded automatically.
router.post("/:checkoutId/open-dispute", async (req, res) => {
  const reason = req.body?.reason
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 2000) return res.status(400).json({ message:"Explain the dispute in 10–2000 characters." })
  return runTransaction(res, async session => {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash").session(session)
    if (!group || !claim(req,group)) throw error("Not authorized.",403)
    if (group.environment !== "live" || await getEnvironmentMode() !== "live") throw error("Disputes for testing orders require the testing workflow.",403)
    if (group.status === "disputed") return { checkoutId:group.id,status:"disputed",message:"Dispute already open." }
    if (group.status !== "verified") throw error("This checkout cannot open a new dispute.")
    const orders = await Order.find({ _id: { $in: group.orderIds } }).session(session)
    if (orders.length !== group.orderIds.length) throw error("Missing seller order; contact support.")
    if (orders.some(o => ["refunded", "refund_pending"].includes(o.paymentStatus))) throw error("Checkout is already in refund handling.")
    const settled = orders.filter(o => o.paymentStatus === "released")
    const now = new Date()
    // Update only unreleased orders. A completed payout is never reversed by a database edit.
    await Order.updateMany({ _id: { $in: orders.filter(o => ["escrow_held", "release_pending"].includes(o.paymentStatus)).map(o => o._id) }, paymentStatus: { $in:["escrow_held", "release_pending"] } }, { $set: { paymentStatus:"disputed", status:"Disputed — Settlement Frozen" } }, { session })
    group.status = "disputed"; group.disputeOpenedAt = now; group.disputeReason = reason.trim()
    await group.save({ session })
    await GroupAuditEvent.create([{ checkoutId:group.id, action:"dispute_opened", actorType:"buyer_claim", actorId:"checkout_claim", previousStatus:"verified", nextStatus:"disputed", details:{ reason:reason.trim(), alreadySettledOrders:settled.length } }],{session})
    return { checkoutId:group.id,status:"disputed",alreadySettledOrders:settled.length,message:settled.length ? "Dispute opened. Some seller transfers were already recorded; support must investigate recovery." : "Dispute opened. Unreleased seller allocations frozen pending investigation." }
  })
})
// Admin may resolve a disputed checkout back to its prior eligible payment states.
// This does not execute transfers and must not overwrite already-released orders.
router.post("/:checkoutId/resolve-dispute", requireAdminAuth, requirePermission("manage_refunds"), async (req,res) => {
  const { decision, notes } = req.body || {}
  if (!["resume", "refund_review"].includes(decision) || typeof notes !== "string" || notes.trim().length < 10 || notes.length > 2000) return res.status(400).json({message:"Decision and investigation notes (10–2000 characters) required."})
  return runTransaction(res, async session => {
    const group = await CheckoutGroup.findById(req.params.checkoutId).session(session)
    if (!group || group.status !== "disputed" || group.environment !== "live" || await getEnvironmentMode() !== "live") throw error("Checkout is not in a resolvable dispute.")
    const orders = await Order.find({ _id: { $in:group.orderIds } }).session(session)
    if (orders.length !== group.orderIds.length || orders.some(o => !["disputed","released"].includes(o.paymentStatus))) throw error("Financial state changed; manual reconciliation required.")
    if (decision === "refund_review" && orders.some(o => o.paymentStatus === "released")) throw error("One or more payouts already recorded; full refund cannot be marked pending without manual recovery.")
    for (const o of orders.filter(o=>o.paymentStatus === "disputed")) {
      const next = decision === "refund_review" ? "refund_pending" : o.fulfillmentStatus === "completed" ? "release_pending" : "escrow_held"
      const changed = await Order.updateOne({ _id:o._id,paymentStatus:"disputed" }, { $set:{ paymentStatus:next,status:decision === "refund_review" ? "Refund Review" : "Dispute Resolved" } }, {session})
      if (changed.modifiedCount !== 1) throw error("Concurrent order update detected.")
    }
    group.status = decision === "refund_review" ? "refund_pending" : "verified"
    if (decision === "refund_review") { group.refundRequestedAt = new Date();group.refundReason = `Admin dispute resolution: ${notes.trim()}` }
    group.verificationNotes = `${group.verificationNotes || ""}\nDispute resolution by ${req.adminUser.email}: ${decision} — ${notes.trim()}`.slice(-2000)
    await group.save({session})
    await GroupAuditEvent.create([{ checkoutId:group.id, action:"dispute_resolved", actorType:"admin", actorId:String(req.adminUser._id), previousStatus:"disputed", nextStatus:group.status, details:{ decision, notes:notes.trim() } }],{session})
    return { checkoutId:group.id,status:group.status,decision,message:"Dispute decision recorded; no funds transferred." }
  })
})
// Buyer generates a short-lived, order-specific delivery code. It is NEVER sent to the seller by this endpoint.
router.post("/:checkoutId/orders/:orderId/delivery-code", async (req, res) => {
  if (!isId(req.params.orderId)) return res.status(400).json({ message: "Invalid order ID." })
  return runTransaction(res, async session => {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash").session(session)
    if (!group || !claim(req, group)) throw error("Not authorized.", 403)
    if (group.status !== "verified" || group.environment !== "live" || await getEnvironmentMode() !== "live") throw error("Delivery confirmation unavailable for this checkout.")
    const order = await Order.findOne({ _id: req.params.orderId, paymentStatus: "escrow_held", fulfillmentStatus: { $in: ["awaiting_delivery", "delivery_in_progress", "delivered_pending_otp"] }, environment: "live" }).session(session)
    if (!order || !group.orderIds.some(id => String(id) === String(order._id))) throw error("Order is not eligible for delivery confirmation.")
    const otp = String(crypto.randomInt(100000, 1000000))
    const otpHash = digest(`${group.id}:${order.id}:${otp}`)
    const expiry = new Date(Date.now() + 10 * 60 * 1000)
    await GroupFulfillment.findOneAndUpdate({ order: order._id, confirmedAt: null }, { $set: { checkoutId: group.id, seller: order.seller, otpHash, otpExpiresAt: expiry, attempts: 0 } }, { upsert: true, new: true, session })
    return { orderId: order.id, deliveryCode: otp, expiresAt: expiry, message: "Give this code only to the seller or rider after you have received and inspected this order's items." }
  })
})
// Authenticated seller enters the buyer's code; this confirms only that seller's order.
router.post("/:checkoutId/orders/:orderId/confirm-delivery", protect, async (req, res) => {
  if (!isId(req.params.orderId) || !/^\d{6}$/.test(String(req.body?.deliveryCode || ""))) return res.status(400).json({ message: "Valid order ID and six-digit delivery code required." })
  return runTransaction(res, async session => {
    const group = await CheckoutGroup.findById(req.params.checkoutId).session(session)
    if (!group || group.status !== "verified" || group.environment !== "live" || await getEnvironmentMode() !== "live") throw error("Checkout is not eligible.")
    const order = await Order.findOne({ _id: req.params.orderId, seller: req.user.id, paymentStatus: "escrow_held", environment: "live", fulfillmentStatus: { $in: ["awaiting_delivery", "delivery_in_progress", "delivered_pending_otp"] } }).session(session)
    if (!order || !group.orderIds.some(id => String(id) === String(order.id))) throw error("Seller is not authorized for this order.", 403)
    const record = await GroupFulfillment.findOne({ order: order._id }).select("+otpHash").session(session)
    if (!record || record.confirmedAt || !record.otpHash || !record.otpExpiresAt || record.otpExpiresAt <= new Date() || record.attempts >= 5) throw error("Delivery code expired or locked. Ask the buyer to generate another.")
    if (!crypto.timingSafeEqual(Buffer.from(record.otpHash, "hex"), Buffer.from(digest(`${group.id}:${order.id}:${req.body.deliveryCode}`), "hex"))) {
      record.attempts += 1; await record.save({ session })
      // Commit the failed-attempt counter without changing order state.
      return { verified: false, attemptsRemaining: 5 - record.attempts, message: "Incorrect delivery code." }
    }
    const now = new Date()
    const updated = await Order.updateOne({ _id: order._id, paymentStatus: "escrow_held", fulfillmentStatus: { $in: ["awaiting_delivery", "delivery_in_progress", "delivered_pending_otp"] } }, { $set: { fulfillmentStatus: "completed", paymentStatus: "release_pending", completedAt: now, status: "Delivery Confirmed — Payout Pending" } }, { session })
    if (updated.modifiedCount !== 1) throw error("Order changed during confirmation.")
    record.confirmedAt = now; record.otpHash = null; await record.save({ session })
    return { verified: true, orderId: order.id, paymentStatus: "release_pending", message: "Delivery confirmed. No payout has been sent yet." }
  })
})
// Admin records a seller payout ONLY after independently confirming a real outgoing transfer.
router.post("/:checkoutId/orders/:orderId/record-payout", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  if (!isId(req.params.orderId) || !validEvidence(req.body || {}) || !Number.isFinite(Number(req.body?.confirmedAmount))) return res.status(400).json({ message: "Valid independent transfer evidence and confirmed amount required." })
  const result = await runTransaction(res, async session => {
    const group = await CheckoutGroup.findById(req.params.checkoutId).session(session)
    if (!group || group.status !== "verified" || group.environment !== "live" || await getEnvironmentMode() !== "live") throw error("Checkout cannot be settled.")
    const order = await Order.findOne({ _id: req.params.orderId, paymentStatus: "release_pending", fulfillmentStatus: "completed", environment: "live" }).session(session)
    if (!order || !group.orderIds.some(id => String(id) === String(order.id))) throw error("Seller order is not ready for payout.")
    const verified = await Payment.findOne({ order: order.id, status: "verified", method: "manual_momo" }).session(session)
    if (!verified) throw error("Verified incoming payment record missing.")
    if (money(req.body.confirmedAmount) !== money(order.sellerAmount)) throw error("Payout amount must exactly match the seller allocation.")
    const now = new Date()
    await GroupTransfer.create([{ checkoutId: group.id, order: order._id, direction: "seller_payout", amount: order.sellerAmount, network: req.body.network.trim().toUpperCase(), recipient: req.body.recipient.trim(), externalReference: req.body.externalReference.trim().toUpperCase(), verifiedBy: req.adminUser.email, verifiedAt: now, notes: req.body.notes || "" }], { session })
    const updated = await Order.updateOne({ _id: order._id, paymentStatus: "release_pending", fulfillmentStatus: "completed" }, { $set: { paymentStatus: "released", releasedAt: now, status: "Settled" } }, { session })
    if (updated.modifiedCount !== 1) throw error("Order changed during payout recording.")
    return { orderId: order.id, paymentStatus: "released", recordedAmount: order.sellerAmount, message: "Externally confirmed payout recorded. This endpoint does not initiate transfers." }
  })
  return result
})
// Group-wide refund is only recorded AFTER full verified external refund to buyer.
// Partial refunds are intentionally unsupported until an allocation-aware refund ledger exists.
router.post("/:checkoutId/record-refund", requireAdminAuth, requirePermission("manage_refunds"), async (req, res) => {
  if (!validEvidence(req.body || {}) || !Number.isFinite(Number(req.body?.confirmedAmount))) return res.status(400).json({ message: "Valid independent refund evidence and confirmed amount required." })
  return runTransaction(res, async session => {
    const group = await CheckoutGroup.findById(req.params.checkoutId).session(session)
    if (!group || group.status !== "refund_pending" || group.environment !== "live" || await getEnvironmentMode() !== "live") throw error("Checkout is not awaiting a refund.")
    const orders = await Order.find({ _id: { $in: group.orderIds } }).session(session)
    if (orders.length !== group.orderIds.length || orders.some(o => o.paymentStatus !== "refund_pending" || o.environment !== "live" || o.releasedAt)) throw error("Order state conflict. Manual reconciliation required.")
    if (money(req.body.confirmedAmount) !== money(group.amount) || money(orders.reduce((sum, o) => sum + o.amount, 0)) !== money(group.amount)) throw error("Full refund amount mismatch.")
    const now = new Date()
    await GroupTransfer.create([{ checkoutId: group.id, order: null, direction: "buyer_refund", amount: group.amount, network: req.body.network.trim().toUpperCase(), recipient: req.body.recipient.trim(), externalReference: req.body.externalReference.trim().toUpperCase(), verifiedBy: req.adminUser.email, verifiedAt: now, notes: req.body.notes || "" }], { session })
    const update = await Order.updateMany({ _id: { $in: group.orderIds }, paymentStatus: "refund_pending" }, { $set: { paymentStatus: "refunded", refundedAt: now, fulfillmentStatus: "cancelled", cancelled: true, cancelledAt: now, status: "Refunded" } }, { session })
    if (update.modifiedCount !== orders.length) throw error("Refund state changed; aborting.")
    const changedPayments = await Payment.updateMany({ order: { $in: group.orderIds }, status: "verified" }, { $set: { status: "refunded", refundedAt: now, refundReference: req.body.externalReference.trim().toUpperCase() } }, { session })
    if (changedPayments.modifiedCount !== orders.length) throw error("Incoming payment ledger mismatch; refund must be reconciled manually.")
    group.status = "refunded"; await group.save({ session })
    return { checkoutId: group.id, status: "refunded", amount: group.amount, message: "Externally confirmed full refund recorded. No transfer was initiated by this endpoint." }
  })
})
export default router

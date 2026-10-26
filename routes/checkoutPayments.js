import express from "express"
import mongoose from "mongoose"
import crypto from "crypto"
import CheckoutGroup from "../models/CheckoutGroup.js"
import Order from "../models/Order.js"
import Payment from "../models/Payment.js"
import VerifiedReceipt from "../models/VerifiedReceipt.js"
import { getEnvironmentMode } from "../models/Environment.js"
import { requireAdminAuth, requirePermission, logAction } from "../middleware/adminAuth.js"

const router = express.Router()
const hash = token => crypto.createHash("sha256").update(token).digest("hex")
const validRef = value => typeof value === "string" && value.trim().length >= 5 && value.length <= 200

// A checkout claim token is a bearer secret issued at checkout creation. It must never
// be included in logs, URLs, or public order responses. Buyer authentication is a
// future improvement; this token preserves compatibility with anonymous checkout.
function authorizeClaim(req, group) {
  const provided = req.headers["x-checkout-token"]
  if (typeof provided !== "string" || !/^[0-9a-f]{64}$/.test(provided) || !group.claimTokenHash) return false
  return crypto.timingSafeEqual(Buffer.from(hash(provided), "hex"), Buffer.from(group.claimTokenHash, "hex"))
}

router.get("/:checkoutId/status", async (req, res) => {
  try {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash")
    if (!group) return res.status(404).json({ message: "Checkout not found." })
    if (!authorizeClaim(req, group)) return res.status(403).json({ message: "Not authorized." })
    res.json({ checkoutId: group.id, status: group.status, paymentStatus: group.status === "verified" ? "escrow_held" : group.status, amount: group.amount, environment: group.environment })
  } catch { res.status(500).json({ message: "Unable to load checkout." }) }
})

router.post("/:checkoutId/submit", async (req, res) => {
  const { buyerReference, evidenceUrl = null } = req.body || {}
  if (!validRef(buyerReference)) return res.status(400).json({ message: "Enter the real Mobile Money transaction reference (at least five characters)." })
  if (evidenceUrl !== null && (typeof evidenceUrl !== "string" || evidenceUrl.length > 1000 || !/^https:\/\//.test(evidenceUrl))) return res.status(400).json({ message: "Evidence URL must be HTTPS." })
  try {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash")
    if (!group) return res.status(404).json({ message: "Checkout not found." })
    if (!authorizeClaim(req, group)) return res.status(403).json({ message: "Not authorized." })
    if (group.paymentMethod !== "manual_momo") return res.status(409).json({ message: "Wrong payment method." })
    if (group.status === "submitted" || group.status === "under_review") return res.json({ status: group.status, message: "Payment is already submitted for review." })
    if (group.status !== "pending") return res.status(409).json({ message: "Checkout is not awaiting payment submission." })
    if (group.environment === "testing") return res.status(403).json({
      code: "TEST_CHECKOUT",
      message: "This is a test checkout. No Mobile Money payment is required. Use the test-submission option to practice the review workflow.",
    })
    const changed = await CheckoutGroup.findOneAndUpdate({ _id: group.id, status: "pending" }, { $set: { status: "submitted", buyerReference: buyerReference.trim(), evidenceUrl, submittedAt: new Date() } }, { new: true })
    if (!changed) return res.status(409).json({ message: "Checkout status changed; refresh before retrying." })
    res.json({ status: "submitted", message: "Evidence submitted. Payment is not yet verified." })
  } catch (err) { console.error("Group submission error", err); res.status(500).json({ message: "Could not submit payment evidence." }) }
})

// Practice the submission/review flow without claiming any real money was sent.
// This never creates a Payment, VerifiedReceipt, or real escrow balance.
router.post("/:checkoutId/submit-test", async (req, res) => {
  try {
    if (process.env.ENABLE_ENVIRONMENT_SWITCH !== "true" || await getEnvironmentMode() !== "testing")
      return res.status(403).json({ message: "Test submissions are only available while Testing Mode is enabled." })
    const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash")
    if (!group) return res.status(404).json({ message: "Checkout not found." })
    if (!authorizeClaim(req, group)) return res.status(403).json({ message: "Not authorized." })
    if (group.environment !== "testing" || group.paymentMethod !== "manual_momo")
      return res.status(403).json({ message: "Only manual Mobile Money test checkouts are eligible." })
    if (group.status === "submitted") return res.json({ status: "submitted", simulated: true })
    if (group.status !== "pending") return res.status(409).json({ message: "This test checkout is no longer pending." })
    const updated = await CheckoutGroup.findOneAndUpdate(
      { _id: group.id, environment: "testing", status: "pending" },
      { $set: { status: "submitted", buyerReference: `TEST-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, submittedAt: new Date() } },
      { new: true }
    )
    if (!updated) return res.status(409).json({ message: "Checkout changed. Refresh." })
    res.json({ status: "submitted", simulated: true, message: "Practice payment submitted. No money has been sent or verified." })
  } catch (err) {
    console.error("Test checkout submission error", err)
    res.status(500).json({ message: "Could not submit practice checkout." })
  }
})

// Admin verification MUST follow an independent check of the actual credited
// Mobile Money account and exact reference, amount, network, and date.
// A single MongoDB transaction updates all seller orders and allocation records.
router.put("/:checkoutId/verify", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  const { confirmedAmount, confirmedReference, confirmedNetwork, recipientAccount, notes = "" } = req.body || {}
  if (!validRef(confirmedReference) || !Number.isFinite(Number(confirmedAmount)) || Number(confirmedAmount) <= 0 || !/^[a-z0-9_-]{2,32}$/i.test(String(confirmedNetwork || "")) || !/^[+0-9]{8,18}$/.test(String(recipientAccount || "")) || typeof notes !== "string" || notes.length > 2000) return res.status(400).json({ message: "Verified reference and exact confirmed amount are required." })
  const session = await mongoose.startSession()
  try {
    let response
    await session.withTransaction(async () => {
      const group = await CheckoutGroup.findById(req.params.checkoutId).session(session)
      if (!group || group.status !== "submitted" || group.paymentMethod !== "manual_momo") throw Object.assign(new Error("Checkout is not awaiting verification."), { status: 409 })
      if (group.environment !== "live" || await getEnvironmentMode() !== "live") throw Object.assign(new Error("Real verification is blocked in Testing Mode."), { status: 403 })
      const cents = value => Math.round(Number(value) * 100)
      if (cents(confirmedAmount) !== cents(group.amount) || confirmedReference.trim() !== group.buyerReference) throw Object.assign(new Error("Reference or amount mismatch. Do not verify."), { status: 409 })
      // The unique _id on VerifiedReceipt is the race-proof replay guard.
      // A duplicate-key failure aborts the whole MongoDB transaction.
      const normalizedReference = confirmedReference.trim().replace(/\s+/g, "").toUpperCase()
      const network = confirmedNetwork.trim().toUpperCase()
      const recipient = recipientAccount.trim().replace(/\s+/g, "")
      const receiptKey = crypto.createHash("sha256").update(JSON.stringify([network, recipient, normalizedReference])).digest("hex")
      await VerifiedReceipt.create([{ _id: receiptKey, checkoutId: group.id, network, recipient,
        reference: normalizedReference, amount: group.amount, verifiedBy: req.adminUser.email }], { session })
      const orders = await Order.find({ _id: { $in: group.orderIds } }).session(session)
      if (orders.length !== group.orderIds.length || orders.some(o => o.environment !== "live" || o.paymentStatus !== "pending" || o.paymentMethod !== "manual_momo" || o.cancelled || o.fulfillmentStatus !== "pending_payment")) throw Object.assign(new Error("One or more seller orders changed; manual reconciliation required."), { status: 409 })
      if (cents(orders.reduce((sum, o) => sum + o.amount, 0)) !== cents(group.amount)) throw Object.assign(new Error("Seller allocation total mismatch."), { status: 409 })
      const existing = await Payment.find({ order: { $in: group.orderIds }, status: { $in: ["pending", "submitted", "under_review", "verified"] } }).session(session)
      if (existing.length) throw Object.assign(new Error("An order has an existing payment; reconcile before proceeding."), { status: 409 })
      const now = new Date()
      const payments = orders.map(o => ({ order: o._id, buyer: o.buyer, method: "manual_momo", provider: "manual", status: "verified", amount: o.amount, currency: "GHS", providerReference: group.paymentReference, buyerReference: group.buyerReference, evidenceUrl: group.evidenceUrl, verifiedAt: now, notes: `Group ${group.id}; ${notes}` }))
      await Payment.insertMany(payments, { session })
      const updated = await Order.updateMany({ _id: { $in: group.orderIds }, paymentStatus: "pending", environment: "live" }, { $set: { paymentStatus: "escrow_held", paymentVerifiedAt: now, fulfillmentStatus: "awaiting_delivery", status: "In Escrow" } }, { session })
      if (updated.modifiedCount !== orders.length) throw Object.assign(new Error("Seller order update mismatch."), { status: 409 })
      group.status = "verified"; group.verifiedAt = now; group.verifiedBy = req.adminUser.email; group.verificationNotes = notes
      await group.save({ session })
      response = { checkoutId: group.id, status: "verified", orderCount: orders.length, total: group.amount }
    })
    await logAction(req, "checkout_group_payment_verified", "checkout_group", req.params.checkoutId, { amount: response.total, orderCount: response.orderCount })
    res.json(response)
  } catch (err) { console.error("Group verification error", err); res.status(err.code === 11000 ? 409 : err.status || 500).json({ message: err.code === 11000 ? "Receipt already used for another checkout. No funds allocated." : err.status ? err.message : "Verification failed. No partial allocation should be accepted." }) }
  finally { await session.endSession() }
})


// Buyer may cancel a wholly unpaid checkout before submitting a receipt.
// Cancelling after evidence submission requires an administrator to investigate funds.
router.post("/:checkoutId/cancel", async (req, res) => {
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash").session(session)
      if (!group) throw Object.assign(new Error("Checkout not found."), { status: 404 })
      if (!authorizeClaim(req, group)) throw Object.assign(new Error("Not authorized."), { status: 403 })
      if (group.status === "cancelled") { result = { status: "cancelled" }; return }
      if (group.status !== "pending") throw Object.assign(new Error("Payment evidence submitted or payment verified. Contact support; do not cancel individual orders."), { status: 409 })
      const updated = await Order.updateMany({ _id: { $in: group.orderIds }, paymentStatus: "pending", fulfillmentStatus: "pending_payment", cancelled: { $ne: true } },
        { $set: { cancelled: true, cancelledAt: new Date(), fulfillmentStatus: "cancelled", paymentStatus: "failed", status: "Cancelled" } }, { session })
      if (updated.modifiedCount !== group.orderIds.length) throw Object.assign(new Error("One or more orders changed. Contact support."), { status: 409 })
      group.status = "cancelled"; await group.save({ session }); result = { status: "cancelled" }
    })
    res.json(result)
  } catch (err) { res.status(err.status || 500).json({ message: err.status ? err.message : "Cancellation failed; no partial cancellation committed." }) }
  finally { await session.endSession() }
})

// Group-wide refund/dispute intake only. This does NOT transfer money or mark a refund complete.
// All seller allocations are frozen together, in one transaction, for manual reconciliation.
router.post("/:checkoutId/request-refund", async (req, res) => {
  const reason = req.body?.reason
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 2000)
    return res.status(400).json({ message: "Provide a reason (10–2000 characters)." })
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      const group = await CheckoutGroup.findById(req.params.checkoutId).select("+claimTokenHash").session(session)
      if (!group) throw Object.assign(new Error("Checkout not found."), { status: 404 })
      if (!authorizeClaim(req, group)) throw Object.assign(new Error("Not authorized."), { status: 403 })
      if (group.status === "refund_pending") { result = { status: group.status }; return }
      if (group.status !== "verified") throw Object.assign(new Error("Only verified checkouts may request a refund; contact support for submitted payments."), { status: 409 })
      const orders = await Order.find({ _id: { $in: group.orderIds } }).session(session)
      if (orders.length !== group.orderIds.length || orders.some(o => o.paymentStatus !== "escrow_held" || o.fulfillmentStatus === "completed" || o.environment !== group.environment))
        throw Object.assign(new Error("Some orders are no longer eligible. Contact support for manual reconciliation."), { status: 409 })
      const now = new Date()
      const update = await Order.updateMany({ _id: { $in: group.orderIds }, paymentStatus: "escrow_held" },
        { $set: { paymentStatus: "refund_pending", fulfillmentStatus: "disputed", status: "Refund Review" } }, { session })
      if (update.modifiedCount !== orders.length) throw Object.assign(new Error("Order status conflict."), { status: 409 })
      group.status = "refund_pending"; group.refundRequestedAt = now; group.refundReason = reason.trim()
      await group.save({ session })
      result = { status: group.status, checkoutId: group.id, message: "Refund requested. No refund has been issued. Support must reconcile all seller allocations." }
    })
    res.json(result)
  } catch (err) { res.status(err.status || 500).json({ message: err.status ? err.message : "Refund request failed; no partial change committed." }) }
  finally { await session.endSession() }
})

// Admin-only queue, deliberately excludes testing and never exposes claim tokens.
router.get("/admin/submitted", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  try {
    const [groups, testGroups, livePending, testPending] = await Promise.all([
      CheckoutGroup.find({ status: "submitted", environment: "live" }).sort({ submittedAt: 1 }).limit(100).lean(),
      CheckoutGroup.find({ status: "submitted", environment: "testing" }).sort({ submittedAt: -1 }).limit(40).lean(),
      CheckoutGroup.countDocuments({ status: "pending", environment: "live" }),
      CheckoutGroup.countDocuments({ status: "pending", environment: "testing" }),
    ])
    res.json({ groups, testGroups, counts: { livePending, testPending, liveSubmitted: groups.length, testSubmitted: testGroups.length },
      note: "Only live submissions can be independently verified as received money. Test submissions are informational." })
  } catch { res.status(500).json({ message: "Could not load verification queue." }) }
})
export default router

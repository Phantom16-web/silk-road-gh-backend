import express from "express"
import mongoose from "mongoose"
import crypto from "crypto"
import CheckoutGroup from "../models/CheckoutGroup.js"
import Order from "../models/Order.js"
import Payment from "../models/Payment.js"
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
    res.json({ checkoutId: group.id, status: group.status, paymentStatus: group.status === "verified" ? "escrow_held" : "pending", amount: group.amount, environment: group.environment })
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
    if (group.environment === "testing") return res.status(403).json({ message: "Do not submit real payment evidence for simulated checkouts." })
    const changed = await CheckoutGroup.findOneAndUpdate({ _id: group.id, status: "pending" }, { $set: { status: "submitted", buyerReference: buyerReference.trim(), evidenceUrl, submittedAt: new Date() } }, { new: true })
    if (!changed) return res.status(409).json({ message: "Checkout status changed; refresh before retrying." })
    res.json({ status: "submitted", message: "Evidence submitted. Payment is not yet verified." })
  } catch (err) { console.error("Group submission error", err); res.status(500).json({ message: "Could not submit payment evidence." }) }
})

// Admin verification MUST follow an independent check of the actual credited
// Mobile Money account and exact reference, amount, network, and date.
// A single MongoDB transaction updates all seller orders and allocation records.
router.put("/:checkoutId/verify", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  const { confirmedAmount, confirmedReference, notes = "" } = req.body || {}
  if (!validRef(confirmedReference) || !Number.isFinite(Number(confirmedAmount)) || typeof notes !== "string" || notes.length > 2000) return res.status(400).json({ message: "Verified reference and exact confirmed amount are required." })
  const session = await mongoose.startSession()
  try {
    let response
    await session.withTransaction(async () => {
      const group = await CheckoutGroup.findById(req.params.checkoutId).session(session)
      if (!group || group.status !== "submitted" || group.paymentMethod !== "manual_momo") throw Object.assign(new Error("Checkout is not awaiting verification."), { status: 409 })
      if (group.environment !== "live" || await getEnvironmentMode() !== "live") throw Object.assign(new Error("Real verification is blocked in Testing Mode."), { status: 403 })
      const cents = value => Math.round(Number(value) * 100)
      if (cents(confirmedAmount) !== cents(group.amount) || confirmedReference.trim() !== group.buyerReference) throw Object.assign(new Error("Reference or amount mismatch. Do not verify."), { status: 409 })
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
  } catch (err) { console.error("Group verification error", err); res.status(err.status || 500).json({ message: err.status ? err.message : "Verification failed. No partial allocation should be accepted." }) }
  finally { await session.endSession() }
})

// Admin-only queue, deliberately excludes testing and never exposes claim tokens.
router.get("/admin/submitted", requireAdminAuth, requirePermission("manage_payments"), async (req, res) => {
  try {
    const groups = await CheckoutGroup.find({ status: "submitted", environment: "live" }).sort({ submittedAt: 1 }).limit(100).lean()
    res.json({ groups })
  } catch { res.status(500).json({ message: "Could not load verification queue." }) }
})
export default router

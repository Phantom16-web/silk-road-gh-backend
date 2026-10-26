import express from "express"
import PaymentSettings, { getPaymentMode } from "../models/PaymentSettings.js"
import { requireAdminAuth, requireOwner, requireReAuth, logAction } from "../middleware/adminAuth.js"
const router = express.Router()
// Public metadata only; do not expose keys or credentials.
const publicSettings = { contactPhone: "054 388 3608", contactWhatsApp: "233543883608", deliveryFee: 10,
  footerTagline: "Ghana's student marketplace. Buy, sell, rent and request services with Mobile Money.",
  aboutText: "Silk Road GH connects university students across Ghana.",
  privacyText: "Contact, order and delivery information is processed to facilitate transactions." }
router.get("/", async (req, res) => {
  try { res.json({ ...publicSettings, paymentMode: await getPaymentMode() }) }
  catch { res.status(503).json({ message: "Payment configuration unavailable." }) }
})
router.get("/payment-mode", requireAdminAuth, requireOwner, async (req, res) => {
  try { res.json({ paymentMode: await getPaymentMode(), paystackAvailable: false }) }
  catch { res.status(503).json({ message: "Payment configuration unavailable." }) }
})
router.put("/payment-mode", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  const mode = req.body?.mode
  if (!["manual", "paystack"].includes(mode)) return res.status(400).json({ message: "Invalid payment provider." })
  // Fail closed until verified Paystack initialization, callback and reconciliation are ready.
  if (mode === "paystack") return res.status(409).json({ message: "Paystack activation is locked until the complete payment verification integration is certified." })
  try {
    const previous = await getPaymentMode()
    await PaymentSettings.findByIdAndUpdate("global", { paymentMode: "manual", changedBy: req.adminUser.email, changedAt: new Date() }, { upsert: true, runValidators: true })
    await logAction(req, "payment_provider_changed", "payment_settings", "global", { from: previous, to: "manual" })
    res.json({ paymentMode: "manual", paystackAvailable: false })
  } catch (err) { res.status(500).json({ message: "Unable to save payment settings." }) }
})
// Generic settings mutation is intentionally not exposed until a properly authenticated,
// persistent configuration model for non-payment fields is implemented.
export default router

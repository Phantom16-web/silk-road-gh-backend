import mongoose from "mongoose"
const schema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  paymentMode: { type: String, enum: ["manual", "paystack"], default: "manual", required: true },
  // The ONE email sent to Paystack for every payment. Buyers are never asked for an email. Set by the Owner admin.
  paystackReceiptEmail: { type: String, default: "" },
  manualMomo: {
    enabled: { type: Boolean, default: false },
    network: { type: String, enum: ["MTN", "Telecel", "AT"], default: "MTN" },
    number: { type: String, default: "" },
    accountName: { type: String, default: "" },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  changedBy: { type: String, default: null },
  changedAt: { type: Date, default: Date.now },
}, { versionKey: false })
const PaymentSettings = mongoose.models.PaymentSettings || mongoose.model("PaymentSettings", schema)
export async function getPaymentMode() {
  const config = await PaymentSettings.findById("global").lean()
  return config?.paymentMode === "paystack" ? "paystack" : "manual"
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isValidReceiptEmail = value => typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim())
// Owner-set email first, PAYSTACK_RECEIPT_EMAIL env var as a fallback. Null when neither is configured.
export async function getPaystackReceiptEmail() {
  const config = await PaymentSettings.findById("global").select("paystackReceiptEmail").lean()
  const email = String(config?.paystackReceiptEmail || process.env.PAYSTACK_RECEIPT_EMAIL || "").trim().toLowerCase()
  return isValidReceiptEmail(email) ? email : null
}
export default PaymentSettings

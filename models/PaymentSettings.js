import mongoose from "mongoose"
const schema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  paymentMode: { type: String, enum: ["manual", "paystack"], default: "manual", required: true },
  changedBy: { type: String, default: null },
  changedAt: { type: Date, default: Date.now },
}, { versionKey: false })
const PaymentSettings = mongoose.models.PaymentSettings || mongoose.model("PaymentSettings", schema)
export async function getPaymentMode() {
  const config = await PaymentSettings.findById("global").lean()
  return config?.paymentMode === "paystack" ? "paystack" : "manual"
}
export default PaymentSettings

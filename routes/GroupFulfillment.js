import mongoose from "mongoose"
const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
  checkoutId: { type: String, required: true, index: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  otpHash: { type: String, default: null, select: false },
  otpExpiresAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  confirmedAt: { type: Date, default: null },
}, { timestamps: true })
export default mongoose.models.GroupFulfillment || mongoose.model("GroupFulfillment", schema)

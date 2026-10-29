import mongoose from "mongoose"
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  localOrderId: { type: String, required: true },
  buyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
  amount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ["manual_momo", "paystack"], required: true },
  paymentReference: { type: String, required: true },
  environment: { type: String, enum: ["testing", "live"], required: true },
  status: { type: String, enum: ["pending", "submitted", "under_review", "verified", "cancelled", "rejected", "refund_pending", "disputed", "refunded"], default: "pending" },
  refundRequestedAt: { type: Date, default: null },
  refundReason: { type: String, default: null, maxlength: 2000 },
  disputeOpenedAt: { type: Date, default: null },
  disputeReason: { type: String, default: null, maxlength: 2000 },
  claimTokenHash: { type: String, required: true, select: false },
  buyerReference: { type: String, default: null, maxlength: 200 },
  evidenceUrl: { type: String, default: null, maxlength: 1000 },
  payerName: { type: String, default: null },
  payerPhone: { type: String, default: null },
  submittedAt: { type: Date, default: null },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: String, default: null },
  verificationNotes: { type: String, default: null },
}, { timestamps: true })
schema.index({ buyer: 1, localOrderId: 1 }, { unique: true, partialFilterExpression: { buyer: { $type: "objectId" } } })
export default mongoose.models.CheckoutGroup || mongoose.model("CheckoutGroup", schema)

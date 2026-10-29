import mongoose from "mongoose"
const schema = new mongoose.Schema({
  checkoutId: { type: String, required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  direction: { type: String, enum: ["seller_payout", "buyer_refund"], required: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "GHS" },
  network: { type: String, required: true },
  recipient: { type: String, required: true },
  externalReference: { type: String, required: true },
  verifiedBy: { type: String, required: true },
  verifiedAt: { type: Date, required: true },
  notes: { type: String, default: "" },
}, { timestamps: true })
schema.index({ direction: 1, network: 1, externalReference: 1 }, { unique: true })
schema.index({ order: 1, direction: 1 }, { unique: true, partialFilterExpression: { order: { $type: "objectId" } } })
schema.index({ checkoutId: 1, direction: 1 }, { unique: true, partialFilterExpression: { direction: "buyer_refund" } })
export default mongoose.models.GroupTransfer || mongoose.model("GroupTransfer", schema)

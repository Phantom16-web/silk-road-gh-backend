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
  status: { type: String, enum: ["pending", "verified", "cancelled"], default: "pending" },
}, { timestamps: true })
schema.index({ buyer: 1, localOrderId: 1 }, { unique: true, partialFilterExpression: { buyer: { $type: "objectId" } } })
export default mongoose.models.CheckoutGroup || mongoose.model("CheckoutGroup", schema)

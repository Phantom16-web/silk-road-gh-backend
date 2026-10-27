import mongoose from "mongoose"

const schema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  type: { type: String, enum: ["new_order"], default: "new_order" },
  itemTitle: { type: String, default: "New order" },
  amount: { type: Number, default: 0 },
  paymentMethod: { type: String, default: "manual_momo" },
  deliveryMethod: { type: String, default: "pickup" },
  status: { type: String, enum: ["unread", "read"], default: "unread", index: true },
  readAt: { type: Date, default: null },
}, { timestamps: true })

schema.index({ seller: 1, order: 1, type: 1 }, { unique: true })
export default mongoose.models.SellerNotification || mongoose.model("SellerNotification", schema)

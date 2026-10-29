import mongoose from "mongoose"
// A single normalized, independently verified receipt may fund one checkout only.
const schema = new mongoose.Schema({
  _id: { type: String, required: true }, // SHA-256(network + reference + recipient)
  checkoutId: { type: String, required: true, unique: true },
  network: { type: String, required: true },
  recipient: { type: String, required: true },
  reference: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  verifiedBy: { type: String, required: true },
}, { timestamps: true })
export default mongoose.models.VerifiedReceipt || mongoose.model("VerifiedReceipt", schema)

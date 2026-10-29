import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  checkoutId: { type: String, required: true, index: true },
  rateBasisPoints: { type: Number, required: true, min: 0, max: 10000 },
  schedule: { type: mongoose.Schema.Types.ObjectId, default: null },
  chargedAt: { type: Date, required: true },
  feeGHS: { type: Number, required: true, min: 0 }
}, { timestamps: true })
export default mongoose.models.CommissionOrderSnapshot || mongoose.model('CommissionOrderSnapshot', schema)

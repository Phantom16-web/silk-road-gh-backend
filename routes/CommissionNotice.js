import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  schedule: { type: mongoose.Schema.Types.ObjectId, ref: 'CommissionSchedule', required: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['announcement','reminder','cancelled'], required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  readAt: { type: Date, default: null }
}, { timestamps: true })
schema.index({ schedule: 1, seller: 1, kind: 1 }, { unique: true })
schema.index({ seller: 1, createdAt: -1 })
export default mongoose.models.CommissionNotice || mongoose.model('CommissionNotice', schema)

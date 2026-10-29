import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  effectiveAt: { type: Date, required: true, unique: true },
  rateBasisPoints: { type: Number, required: true, min: 0, max: 10000 },
  previousRateBasisPoints: { type: Number, required: true, min: 0, max: 10000 },
  status: { type: String, enum: ['scheduled','cancelled'], default: 'scheduled', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  createdByEmail: { type: String, required: true },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  cancelledAt: { type: Date, default: null },
  reason: { type: String, required: true, maxlength: 2000 },
  noticeStatus: { type: String, enum: ['pending','processing','complete'], default: 'pending' },
  noticeCursor: { type: mongoose.Schema.Types.ObjectId, default: null },
  noticeCount: { type: Number, default: 0 },
  noticeLastRunAt: { type: Date, default: null }
}, { timestamps: true })
schema.index({ status: 1, effectiveAt: -1 })
export default mongoose.models.CommissionSchedule || mongoose.model('CommissionSchedule', schema)

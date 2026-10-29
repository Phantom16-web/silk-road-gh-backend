import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  schedule: { type: mongoose.Schema.Types.ObjectId, required: true },
  action: { type: String, enum: ['scheduled','cancelled'], required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, required: true },
  actorEmail: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true })
schema.index({ schedule: 1, createdAt: -1 })
export default mongoose.models.CommissionAudit || mongoose.model('CommissionAudit', schema)

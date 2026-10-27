import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  event: { type: String, required: true },
  reference: { type: String, required: true },
  receivedAt: { type: Date, default: Date.now },
  state: { type: String, enum: ['pending','processing','completed','retry','ignored'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  lastError: { type: String, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true })
schema.index({ state: 1, nextAttemptAt: 1 })
export default mongoose.models.PaystackWebhookInbox || mongoose.model('PaystackWebhookInbox',schema)

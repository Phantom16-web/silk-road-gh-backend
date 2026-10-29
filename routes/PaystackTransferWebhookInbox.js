import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  event: { type: String, enum: ['transfer.success','transfer.failed','transfer.reversed'], required: true },
  reference: { type: String, required: true, index: true },
  state: { type: String, enum: ['pending','processing','retry','completed'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
  lastError: { type: String, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true })
export default mongoose.models.PaystackTransferWebhookInbox || mongoose.model('PaystackTransferWebhookInbox', schema)

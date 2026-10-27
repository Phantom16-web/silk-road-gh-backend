import mongoose from 'mongoose'

// Each entitlement is unique per order, beneficiary and settlement generation.
// References are immutable once generated and reused for every Paystack retry.
const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  checkoutId: { type: String, required: true, index: true },
  beneficiary: { type: mongoose.Schema.Types.ObjectId, required: true },
  role: { type: String, enum: ['seller', 'rider'], required: true },
  generation: { type: Number, default: 1, min: 1 },
  environment: { type: String, enum: ['test', 'live'], required: true },
  provider: { type: String, enum: ['paystack', 'manual'], required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ['GHS'], default: 'GHS' },
  recipientCode: { type: String, default: null },
  reference: { type: String, required: true, unique: true, immutable: true },
  state: { type: String, enum: ['approved', 'submitting', 'pending', 'succeeded', 'failed', 'reversed', 'needs_reconciliation', 'cancelled'], default: 'approved', index: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  approvedAt: { type: Date, default: Date.now },
  submittedAt: { type: Date, default: null },
  settledAt: { type: Date, default: null },
  lastReconciledAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null },
  providerTransferCode: { type: String, default: null },
}, { timestamps: true })
schema.index({ order: 1, role: 1, beneficiary: 1, generation: 1 }, { unique: true })
schema.index({ environment: 1, provider: 1, state: 1 })
export default mongoose.models.PayoutIntent || mongoose.model('PayoutIntent', schema)

import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  checkoutId: { type: String, required: true, index: true },
  reference: { type: String, required: true, unique: true },
  environment: { type: String, enum: ['test','live'], required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ['GHS'], default: 'GHS' },
  state: { type: String, enum: ['initializing','pending','verified','failed','reconcile'], default: 'initializing' },
  authorizationUrl: { type: String, default: null },
  // 'checkout' = Paystack hosted page, 'mobile_money' = direct charge from the buyer's phone number.
  channel: { type: String, enum: ['checkout','mobile_money'], default: 'checkout' },
  chargeStatus: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
  providerId: { type: String, default: null },
  lastError: { type: String, default: null },
}, { timestamps: true })
schema.index({ checkoutId: 1 }, { unique: true })
export default mongoose.models.PaystackCheckoutAttempt || mongoose.model('PaystackCheckoutAttempt', schema)

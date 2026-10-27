import mongoose from 'mongoose'
import PayoutIntent from '../models/PayoutIntent.js'
import Order from '../models/Order.js'
import CheckoutGroup from '../models/CheckoutGroup.js'
import RiderFundingChoice from '../models/RiderFundingChoice.js'

// The Paystack transfer MUST already be independently verified as succeeded.
// All cross-model finalization is idempotent and atomic; never infer a payout
// from order fulfillment or a transfer submission response.
export async function finalizeVerifiedPayouts(orderId) {
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session)
      if (!order) throw new Error('Order not found')
      const intents = await PayoutIntent.find({ order: order._id, provider: 'paystack' }).session(session)
      if (!intents.length || !intents.some(i => i.role === 'seller')) throw new Error('No approved seller payout')
      if (intents.some(i => i.state !== 'succeeded')) { result = { finalized: false, reason: 'One or more payouts are not confirmed successful' }; return }
      const group = await CheckoutGroup.findOne({ orderIds: order._id }).session(session)
      if (!group || group.paymentMethod !== 'paystack' || group.status !== 'verified' || group._id !== intents[0].checkoutId) throw new Error('Verified group mismatch')
      if (intents.some(i => i.checkoutId !== group.id || i.environment !== (order.environment === 'testing' ? 'test' : 'live'))) throw new Error('Payout environment mismatch')
      if (order.cancelled || ['disputed','refund_pending','refunded'].includes(order.paymentStatus) || group.status !== 'verified') {
        result = { finalized: false, reason: 'Settlement is frozen' }; return
      }
      const funding = await RiderFundingChoice.findOne({ order: order._id }).session(session)
      const riderIntent = intents.find(i => i.role === 'rider')
      if (funding?.fundingSource === 'earnings' && !riderIntent) throw new Error('Rider payout missing')
      if (!funding && riderIntent) throw new Error('Unexpected rider payout')
      if (funding && !['delivery_confirmed','rider_paid'].includes(funding.status)) throw new Error('Rider delivery not confirmed')
      if (order.paymentStatus === 'released') {
        result = { finalized: true, alreadyFinalized: true }; return
      }
      if (order.paymentStatus !== 'release_pending' || order.fulfillmentStatus !== 'completed') {
        result = { finalized: false, reason: 'Order is not eligible for finalization' }; return
      }
      if (funding?.fundingSource === 'earnings') {
        const updated = await RiderFundingChoice.updateOne({ _id: funding.id, status: 'delivery_confirmed' }, { $set: { status: 'rider_paid' } }, { session })
        if (updated.modifiedCount !== 1) throw new Error('Rider payout status changed')
      }
      const updated = await Order.updateOne({ _id: order.id, paymentStatus: 'release_pending', fulfillmentStatus: 'completed', cancelled: { $ne: true } }, { $set: { paymentStatus: 'released', releasedAt: new Date(), status: 'Settled' } }, { session })
      if (updated.modifiedCount !== 1) throw new Error('Order settlement state changed')
      result = { finalized: true, alreadyFinalized: false }
    })
    return result
  } finally { await session.endSession() }
}

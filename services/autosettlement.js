import mongoose from 'mongoose'
import crypto from 'node:crypto'
import Order from '../models/Order.js'
import CheckoutGroup from '../models/CheckoutGroup.js'
import RiderFundingChoice from '../models/RiderFundingChoice.js'
import PayoutIntent from '../models/PayoutIntent.js'
import PayoutRecipient from '../models/PayoutRecipient.js'
import Delivery from '../models/Delivery.js'
import { assertServiceSettlementReady } from './serviceSettlementGuard.js'
import { assertRentalSettlementReady } from './rentalSettlementGuard.js'
import { ghsToMinor } from './settlementMath.js'
import { paystackKeyMode } from './paystackTransfers.js'
import { submitApprovedPayout, reconcilePayout } from './payoutExecutor.js'
import { notifySeller } from './orderEvents.js'

// Releases the seller's money (and the rider's fee) as soon as the buyer's delivery code is confirmed. No admin step.
//   Testing Mode: simulated. Nothing is sent to Paystack and no real money moves.
//   Live Mode:    real Paystack transfers. Every safety check of the old Owner-approved flow still runs
//                 (verified checkout, matching environment, completed delivery, no frozen order, one payout per order).
// Safe to call any number of times for the same order.
const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const cedi = n => `GH\u20B5${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const validRecipient = x => typeof x === 'string' && /^RCP_[A-Za-z0-9]+$/.test(x)
const executionEnabled = () => process.env.ENABLE_PAYSTACK_PAYOUT_EXECUTION === 'true'

export async function autoSettleOrder(orderId) {
  try {
    const order = await Order.findById(orderId)
    if (!order || order.paymentStatus !== 'release_pending' || order.fulfillmentStatus !== 'completed' || order.cancelled) return { status: 'skipped' }
    return order.environment === 'testing' ? await simulateRelease(order) : await releaseLive(order)
  } catch (err) {
    console.error('Auto settlement failed for order', String(orderId), err.message)
    return { status: 'error', message: err.message }
  }
}

// Testing Mode: same end state as a real payout (order Settled, rider funding paid), nothing sent anywhere.
async function simulateRelease(order) {
  if (order.isSimulatedPayment !== true) throw fail('Only simulated test orders can be auto-released in Testing Mode')
  const session = await mongoose.startSession()
  let released = false
  try {
    await session.withTransaction(async () => {
      const funding = await RiderFundingChoice.findOne({ order: order._id }).session(session)
      if (funding?.status === 'delivery_confirmed') await RiderFundingChoice.updateOne({ _id: funding.id, status: 'delivery_confirmed' }, { $set: { status: 'rider_paid' } }, { session })
      const moved = await Order.updateOne({ _id: order._id, paymentStatus: 'release_pending', fulfillmentStatus: 'completed', environment: 'testing', isSimulatedPayment: true, cancelled: { $ne: true } }, { $set: { paymentStatus: 'released', releasedAt: new Date(), status: 'Settled (Test)' } }, { session })
      released = moved.modifiedCount === 1
    })
  } finally { await session.endSession() }
  if (released) notifySeller(order.seller, 'payout_sent', 'Payout released (test)', `Your ${cedi(order.sellerAmount)} was released automatically. This is a test order, so no real money moved.`, order._id, `payout_sent:${order._id}`)
  return { status: released ? 'released_test' : 'skipped' }
}

async function releaseLive(order) {
  if (!executionEnabled()) return { status: 'disabled' } // owner has not switched on automatic transfers on the server
  const group = await CheckoutGroup.findOne({ orderIds: order._id, status: 'verified', paymentMethod: 'paystack' })
  if (!group || group.environment !== order.environment) return { status: 'skipped' } // manual Mobile Money orders are not auto-settled
  if (paystackKeyMode() !== 'live') throw fail('Paystack key environment mismatch')

  const existing = await PayoutIntent.find({ order: order._id })
  if (existing.length) return await submitPending(order, existing)

  // Work out who gets what, exactly as the Owner-approved flow did.
  await assertRentalSettlementReady(order)
  await assertServiceSettlementReady(order)
  const funding = await RiderFundingChoice.findOne({ order: order._id })
  if (funding && funding.status !== 'delivery_confirmed') return { status: 'waiting_rider_confirmation' }
  if (funding?.fundingSource === 'separate') throw fail('Separate rider funding needs manual reconciliation')
  if (funding?.fundingSource === 'earnings' && !funding.deliveryId) throw fail('Missing assigned rider delivery')
  const riderMinor = funding?.fundingSource === 'earnings' ? ghsToMinor(funding.quotedFee) : 0
  const sellerMinor = ghsToMinor(order.sellerAmount) - riderMinor
  if (sellerMinor < 0) throw fail('Rider fee exceeds seller proceeds')
  if (sellerMinor < 1000 || (riderMinor > 0 && riderMinor < 1000)) {
    await notifySeller(order.seller, 'payout_held', 'Payout needs manual release', `This order is below the GH\u20B510 automatic payout minimum, so our team will release ${cedi(order.sellerAmount)} to you manually.`, order._id, `payout_manual:${order._id}`)
    return { status: 'below_minimum' }
  }
  const items = [{ role: 'seller', beneficiary: order.seller, amountMinor: sellerMinor }]
  if (riderMinor) {
    const delivery = await Delivery.findById(funding.deliveryId)
    if (!delivery?.rider) throw fail('Assigned rider not found')
    items.push({ role: 'rider', beneficiary: delivery.rider, amountMinor: riderMinor })
  }
  for (const item of items) {
    const bound = await PayoutRecipient.findOne({ beneficiary: item.beneficiary, role: item.role, environment: 'live', status: 'approved' })
    if (!bound || !validRecipient(bound.recipientCode)) {
      if (item.role === 'seller') await notifySeller(order.seller, 'payout_needs_account', 'Add your payout account', `Your ${cedi(sellerMinor / 100)} is ready. Add your Mobile Money payout account in Account \u2192 Payouts and it is sent automatically.`, order._id, `payout_needs_account:${order._id}`)
      return { status: 'waiting_recipient', role: item.role }
    }
    if (bound.holdUntil && bound.holdUntil > new Date()) {
      if (item.role === 'seller') await notifySeller(order.seller, 'payout_held', 'Payout briefly on hold', `You changed your payout account recently. For your protection your ${cedi(sellerMinor / 100)} is released automatically after ${bound.holdUntil.toLocaleString('en-GH')}.`, order._id, `payout_held:${order._id}`)
      return { status: 'held', until: bound.holdUntil }
    }
    item.recipientCode = bound.recipientCode
  }

  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const fresh = await Order.findById(order._id).session(session)
      if (!fresh || fresh.paymentStatus !== 'release_pending' || fresh.fulfillmentStatus !== 'completed' || fresh.cancelled) throw fail('Order changed during settlement')
      if (await PayoutIntent.exists({ order: order._id }).session(session)) throw fail('Payout already created')
      await PayoutIntent.insertMany(items.map(item => ({
        order: order._id, checkoutId: group.id, beneficiary: item.beneficiary, role: item.role, environment: 'live', provider: 'paystack',
        amountMinor: item.amountMinor, recipientCode: item.recipientCode,
        reference: `SR-${item.role.toUpperCase()}-${crypto.randomBytes(16).toString('hex').toUpperCase()}`,
        approvedBy: null, approvedAt: new Date(),
      })), { session })
    })
  } catch (err) {
    if (err.code === 11000 || /already created/.test(err.message)) return { status: 'in_progress' }
    throw err
  } finally { await session.endSession() }
  return await submitPending(order, await PayoutIntent.find({ order: order._id }))
}

// Sends every intent that has not gone out yet. The executor claims each one atomically, so two servers cannot double-send.
async function submitPending(order, intents) {
  if (intents.some(i => ['failed', 'reversed', 'cancelled'].includes(i.state))) return { status: 'needs_attention' }
  let sent = 0
  for (const intent of intents.filter(i => i.state === 'approved')) {
    try { await submitApprovedPayout(intent.id); sent++ } catch (err) { console.error('Payout submit failed', intent.reference, err.message) }
  }
  return { status: sent ? 'submitted' : 'in_progress' }
}

// Runs every minute: retries orders that were waiting (for a payout account, a hold to end, or a restart),
// confirms transfers whose webhook never arrived, and tells sellers when their money has landed.
let sweeping = false
export async function sweepSettlements() {
  if (sweeping) return
  sweeping = true
  try {
    const waiting = await Order.find({ paymentStatus: 'release_pending', fulfillmentStatus: 'completed', paymentMethod: 'paystack', cancelled: { $ne: true } }).select('_id').sort({ completedAt: 1 }).limit(25).lean()
    for (const o of waiting) await autoSettleOrder(o._id)
    if (executionEnabled()) {
      const stale = await PayoutIntent.find({ state: { $in: ['pending', 'needs_reconciliation'] }, updatedAt: { $lt: new Date(Date.now() - 3 * 60 * 1000) } }).select('reference').limit(20).lean()
      for (const i of stale) { try { await reconcilePayout(i.reference) } catch (err) { console.error('Payout reconcile failed', i.reference, err.message) } }
      const done = await Order.find({ paymentStatus: 'released', paymentMethod: 'paystack', environment: 'live', releasedAt: { $gt: new Date(Date.now() - 24 * 3600 * 1000) } }).select('_id seller sellerAmount').limit(50).lean()
      for (const o of done) await notifySeller(o.seller, 'payout_sent', 'Payout sent', `${cedi(o.sellerAmount)} has been sent to your Mobile Money account.`, o._id, `payout_sent:${o._id}`)
    }
  } catch (err) { console.error('Settlement sweep failed:', err.message) } finally { sweeping = false }
}
export const startSettlementSweeper = () => { setInterval(sweepSettlements, 60 * 1000).unref?.(); setTimeout(sweepSettlements, 15 * 1000).unref?.() }

import express from 'express'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import CheckoutGroup from '../models/CheckoutGroup.js'
import Order from '../models/Order.js'
import Payment from '../models/Payment.js'
import PaystackCheckoutAttempt from '../models/PaystackCheckoutAttempt.js'
import { minor, keyEnvironment, checkoutClaim, matchesProviderTransaction } from '../services/paystackCheckoutCore.js'
const router = express.Router()
const secret = () => process.env.PAYSTACK_SECRET_KEY || ''
const fail = (message, status=409) => Object.assign(new Error(message), { status })
async function paystack(path, options={}) {
  const response = await fetch(`https://api.paystack.co${path}`, { ...options, headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) })
  const payload = await response.json()
  if (!response.ok || payload?.status !== true) throw fail(payload?.message || 'Paystack API unavailable', 503)
  return payload.data
}
function guarded(res, err) { console.error('Checkout Paystack:', err); return res.status(err.status || 500).json({ message: err.status ? err.message : 'Payment could not be processed safely.' }) }

// Only the buyer holding the original checkout claim token may initialize or inspect.
router.post('/:checkoutId/initialize', async (req,res) => {
  try {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select('+claimTokenHash')
    if (!group) throw fail('Checkout not found',404)
    if (!checkoutClaim(req.headers['x-checkout-token'], group.claimTokenHash)) throw fail('Not authorized',403)
    if (group.paymentMethod !== 'paystack' || group.status !== 'pending') throw fail('Checkout is not awaiting Paystack payment')
    const env = keyEnvironment(secret())
    if (group.environment !== (env === 'test' ? 'testing' : 'live')) throw fail('Checkout and Paystack key environment differ',403)
    const email = req.body?.email
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw fail('Valid payer email required',400)
    const existing = await PaystackCheckoutAttempt.findOne({ checkoutId: group.id })
    if (existing) return res.status(existing.authorizationUrl ? 200 : 409).json({ reference: existing.reference, authorizationUrl: existing.authorizationUrl, state: existing.state, message: existing.authorizationUrl ? 'Existing payment attempt' : 'Payment initialization is being reconciled; do not retry.' })
    const reference = `SR-GRP-${crypto.randomBytes(16).toString('hex').toUpperCase()}`
    let attempt
    try { attempt = await PaystackCheckoutAttempt.create({ checkoutId: group.id, reference, environment: env, amountMinor: minor(group.amount) }) }
    catch (err) { if (err.code === 11000) return res.status(409).json({ code:'PAYSTACK_INITIALIZATION_IN_PROGRESS', message:'Another payment attempt exists. Refresh and retry verification, not initialization.' }); throw err }
    try {
      const data = await paystack('/transaction/initialize', { method:'POST', body: JSON.stringify({ email, amount: attempt.amountMinor, currency:'GHS', reference, metadata: { silk_road_checkout_id: group.id } }) })
      if (data.reference !== reference || !data.authorization_url) throw fail('Unexpected provider initialization response',503)
      await PaystackCheckoutAttempt.updateOne({ _id: attempt.id, state:'initializing' }, { $set: { state:'pending', authorizationUrl:data.authorization_url } })
      return res.status(201).json({ reference, authorizationUrl:data.authorization_url, state:'pending' })
    } catch (e) {
      await PaystackCheckoutAttempt.updateOne({ _id:attempt.id }, { $set:{ state:'reconcile', lastError:e.message } })
      throw fail('Initialization outcome uncertain; reconcile before retry',503)
    }
  } catch(e) { return guarded(res,e) }
})

// Idempotent, all-or-nothing allocation of one Paystack group charge across orders.
export async function reconcilePaystackGroup(reference) {
  const attempt = await PaystackCheckoutAttempt.findOne({ reference })
  if (!attempt) throw fail('Unknown reference',404)
  const tx = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`)
  if (!matchesProviderTransaction(tx,attempt)) return { verified:false, providerStatus:tx?.status || 'unknown' }
  const session = await mongoose.startSession()
  try {
    let output
    await session.withTransaction(async () => {
      const group = await CheckoutGroup.findById(attempt.checkoutId).session(session)
      if (!group) throw fail('Checkout missing',404)
      if (group.status === 'verified') {
        if (group.paymentReference !== reference) throw fail('Checkout verified with a different reference')
        output = { verified:true, alreadyVerified:true }; return
      }
      if (group.status !== 'pending' || group.paymentMethod !== 'paystack' || group.environment !== (attempt.environment === 'test' ? 'testing' : 'live')) throw fail('Checkout is no longer eligible')
      const orders = await Order.find({ _id:{ $in:group.orderIds } }).session(session)
      if (orders.length !== group.orderIds.length || orders.some(o => o.paymentStatus !== 'pending' || o.paymentMethod !== 'paystack' || o.environment !== group.environment || o.cancelled || o.fulfillmentStatus !== 'pending_payment')) throw fail('Order states conflict')
      if (orders.reduce((s,o)=>s+minor(o.amount),0) !== attempt.amountMinor || minor(group.amount) !== attempt.amountMinor) throw fail('Allocation amount mismatch')
      const existing = await Payment.exists({ order:{ $in:group.orderIds }, status:{ $in:['pending','submitted','under_review','verified'] } }).session(session)
      if (existing) throw fail('Existing payment allocation must be reconciled')
      const now = new Date()
      await Payment.insertMany(orders.map(o=>({ order:o.id, buyer:o.buyer, method:'paystack', provider:'paystack', status:'verified', amount:o.amount, currency:'GHS', providerReference:reference, verifiedAt:now, notes:`Paystack checkout ${group.id} (${attempt.environment})` })), { session })
      const updated = await Order.updateMany({ _id:{ $in:group.orderIds }, paymentStatus:'pending', paymentMethod:'paystack' }, { $set:{ paymentStatus:'escrow_held', paymentVerifiedAt:now, fulfillmentStatus:'awaiting_delivery', status:'In Escrow', paystackRef:reference } }, { session })
      if (updated.modifiedCount !== orders.length) throw fail('Order update conflict')
      group.status='verified'; group.paymentReference=reference; group.verifiedAt=now; group.verifiedBy=`paystack:${attempt.environment}`
      await group.save({ session })
      await PaystackCheckoutAttempt.updateOne({ _id:attempt.id }, { $set:{ state:'verified', verifiedAt:now, providerId:String(tx.id || '') } }, { session })
      output = { verified:true, orderCount:orders.length }
    })
    return output
  } finally { await session.endSession() }
}
router.post('/:checkoutId/verify', async (req,res) => {
  try {
    const group = await CheckoutGroup.findById(req.params.checkoutId).select('+claimTokenHash')
    if (!group) throw fail('Checkout not found',404)
    if (!checkoutClaim(req.headers['x-checkout-token'],group.claimTokenHash)) throw fail('Not authorized',403)
    const attempt = await PaystackCheckoutAttempt.findOne({ checkoutId:group.id }).sort({ createdAt:-1 })
    if (!attempt) throw fail('Payment not initialized',404)
    res.json(await reconcilePaystackGroup(attempt.reference))
  } catch(e) { return guarded(res,e) }
})
export default router

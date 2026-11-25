import express from 'express'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import CheckoutGroup from '../models/CheckoutGroup.js'
import Order from '../models/Order.js'
import Payment from '../models/Payment.js'
import PaystackCheckoutAttempt from '../models/PaystackCheckoutAttempt.js'
import { getPaystackReceiptEmail } from '../models/PaymentSettings.js'
import { normalizeGhPhone, momoProvider, MOMO_PROVIDERS, maskPhone } from '../services/ghPhone.js'
import { notifyOrdersPaid } from '../services/orderEvents.js'
import { minor, keyEnvironment, checkoutClaim, matchesProviderTransaction } from '../services/paystackCheckoutCore.js'
const router = express.Router()
const secret = () => process.env.PAYSTACK_SECRET_KEY || ''
const fail = (message, status=409) => Object.assign(new Error(message), { status })
const newReference = () => `SR-GRP-${crypto.randomBytes(16).toString('hex').toUpperCase()}`
// A mobile money prompt expires after about 3 minutes. After this long with no payment we treat the attempt as dead.
const PROMPT_WINDOW_MS = 4 * 60 * 1000
const STALE_MS = 10 * 60 * 1000
// With a Paystack TEST key (Testing Mode) there is no real phone to prompt, so payments are approved automatically,
// exactly like the Owner's "simulate payment" tool. Set PAYSTACK_TEST_AUTO_APPROVE=false to use Paystack's own test flow instead.
// A live key can NEVER take this path: it needs a test key AND a Testing Mode checkout.
const autoApproveTest = env => env === 'test' && process.env.PAYSTACK_TEST_AUTO_APPROVE !== 'false'

// Keeps Paystack's HTTP status so we can tell "Paystack understood and refused this request" (nothing was charged,
// safe to retry) from "we do not know what happened" (must be reconciled, never retried blindly).
async function paystack(path, options={}) {
  let response
  try { response = await fetch(`https://api.paystack.co${path}`, { ...options, headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) }) }
  catch { throw fail('Paystack API unavailable', 503) }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.status !== true) {
    const err = fail(payload?.message || 'Paystack API unavailable', 503)
    err.definitive = Boolean(payload) && response.status >= 400 && response.status < 500
    err.providerMessage = typeof payload?.message === 'string' ? payload.message.slice(0, 200) : ''
    throw err
  }
  return payload.data
}
function guarded(res, err) { console.error('Checkout Paystack:', err); return res.status(err.status || 500).json({ message: err.status ? err.message : 'Payment could not be processed safely.' }) }

// The ONE email Paystack receives for every payment is set by the Owner admin. Buyers are never asked for one.
async function receiptEmail() {
  const email = await getPaystackReceiptEmail()
  if (!email) throw fail('Online payment is not fully set up yet. Please contact support.', 503)
  return email
}
// Only the buyer holding the original checkout claim token may pay or inspect.
async function loadPayableGroup(req) {
  const group = await CheckoutGroup.findById(req.params.checkoutId).select('+claimTokenHash')
  if (!group) throw fail('Checkout not found',404)
  if (!checkoutClaim(req.headers['x-checkout-token'], group.claimTokenHash)) throw fail('Not authorized',403)
  if (group.paymentMethod !== 'paystack' || group.status !== 'pending') throw fail('Checkout is not awaiting Paystack payment')
  const env = keyEnvironment(secret())
  if (group.environment !== (env === 'test' ? 'testing' : 'live')) throw fail('Checkout and Paystack key environment differ',403)
  return { group, env }
}

// Pay from the buyer's phone: no hosted page, no email, no card form. The prompt appears on their phone.
// Uses the phone number the buyer already gave at checkout; they may correct it or pick another network.
router.post('/:checkoutId/charge', async (req,res) => {
  try {
    const { group, env } = await loadPayableGroup(req)
    if (autoApproveTest(env)) return res.status(201).json(await approveTestCheckout(group))
    const phone = normalizeGhPhone(req.body?.phone || group.payerPhone)
    if (!phone.ok) throw fail('Please enter a valid Ghana Mobile Money number.',400)
    const wanted = typeof req.body?.provider === 'string' ? req.body.provider.toLowerCase() : ''
    if (wanted && !MOMO_PROVIDERS.includes(wanted)) throw fail('Unsupported Mobile Money network.',400)
    const provider = wanted || momoProvider(phone.local)
    if (!provider) throw fail('We could not tell which network this number is on. Please choose MTN, Telecel or AT.',400)
    const email = await receiptEmail()

    let attempt = await PaystackCheckoutAttempt.findOne({ checkoutId: group.id })
    if (attempt) {
      const decision = await retryDecision(attempt)
      if (decision === 'settle') return res.json({ ...(await reconcilePaystackGroup(attempt.reference)), state: 'verified' })
      if (decision === 'wait') return res.json({ reference: attempt.reference, state: 'pending', alreadyPending: true, phoneMasked: maskPhone(phone.local), message: 'A payment prompt is already on its way. Approve it on your phone.' })
      if (decision === 'blocked') throw fail('Your last payment attempt is still being checked. Please wait a minute and do not pay twice.',409)
      // The old attempt is confirmed dead: put a fresh reference on the same attempt row.
      const swapped = await PaystackCheckoutAttempt.findOneAndUpdate(
        { _id: attempt.id, reference: attempt.reference, state: attempt.state },
        { $set: { reference: newReference(), state: 'initializing', authorizationUrl: null, channel: 'mobile_money', chargeStatus: null, lastError: null } }, { new: true })
      if (!swapped) throw fail('Another payment attempt just started. Check its status instead.',409)
      attempt = swapped
    } else {
      try { attempt = await PaystackCheckoutAttempt.create({ checkoutId: group.id, reference: newReference(), environment: env, amountMinor: minor(group.amount), channel: 'mobile_money' }) }
      catch (err) { if (err.code === 11000) throw fail('Another payment attempt just started. Check its status instead.',409); throw err }
    }

    let data
    try {
      data = await paystack('/charge', { method:'POST', body: JSON.stringify({ email, amount: attempt.amountMinor, currency:'GHS', reference: attempt.reference, mobile_money: { phone: phone.local, provider }, metadata: { silk_road_checkout_id: group.id } }) })
    } catch (e) {
      if (e.definitive) {
        await PaystackCheckoutAttempt.updateOne({ _id: attempt.id }, { $set: { state:'failed', lastError: e.providerMessage || e.message } })
        throw fail(e.providerMessage || 'The payment request was declined. Check the number and network, then try again.',422)
      }
      await PaystackCheckoutAttempt.updateOne({ _id: attempt.id }, { $set: { state:'reconcile', lastError: e.message } })
      throw fail('We could not confirm the payment request. Please wait a minute and check again before paying.',503)
    }
    return res.status(201).json({ ...(await recordChargeOutcome(attempt, data)), provider, phoneMasked: maskPhone(phone.local) })
  } catch(e) { return guarded(res,e) }
})

// Telecel and some other numbers ask for a one-time code before the prompt. The buyer types it in our app.
router.post('/:checkoutId/submit-otp', async (req,res) => {
  try {
    const { group } = await loadPayableGroup(req)
    const otp = String(req.body?.otp || '').trim()
    if (!/^\d{4,8}$/.test(otp)) throw fail('Enter the code you received by SMS.',400)
    const attempt = await PaystackCheckoutAttempt.findOne({ checkoutId: group.id })
    if (!attempt || attempt.state !== 'pending' || attempt.channel !== 'mobile_money') throw fail('There is no payment waiting for a code.')
    let data
    try { data = await paystack('/charge/submit_otp', { method:'POST', body: JSON.stringify({ otp, reference: attempt.reference }) }) }
    catch (e) { throw fail(e.definitive ? (e.providerMessage || 'That code was not accepted. Check it and try again.') : 'We could not check that code. Please try again in a moment.', e.definitive ? 422 : 503) }
    return res.json(await recordChargeOutcome(attempt, data))
  } catch(e) { return guarded(res,e) }
})

// Hosted Paystack page: kept only as a fallback (for example card payments). Needs no buyer email.
router.post('/:checkoutId/initialize', async (req,res) => {
  try {
    const { group, env } = await loadPayableGroup(req)
    if (autoApproveTest(env)) return res.status(201).json(await approveTestCheckout(group))
    const email = await receiptEmail()
    const existing = await PaystackCheckoutAttempt.findOne({ checkoutId: group.id })
    if (existing) return res.status(existing.authorizationUrl ? 200 : 409).json({ reference: existing.reference, authorizationUrl: existing.authorizationUrl, state: existing.state, message: existing.authorizationUrl ? 'Existing payment attempt' : 'A payment attempt already exists. Check its status instead of starting a new one.' })
    const reference = newReference()
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

// What to do about an earlier attempt when the buyer asks to pay again.
//   settle  = Paystack says it WAS paid, so finish the order instead of charging again
//   wait    = the prompt is probably still live
//   retry   = Paystack confirms it failed or was abandoned, so nothing was charged and a new attempt is safe
//   blocked = we cannot tell; never risk a double charge
async function retryDecision(attempt) {
  if (attempt.state === 'verified') return 'settle'
  if (attempt.state === 'reconcile' || attempt.state === 'initializing') return 'blocked'
  let tx = null
  try { tx = await paystack(`/transaction/verify/${encodeURIComponent(attempt.reference)}`) } catch { tx = null }
  if (tx?.status === 'success') return 'settle'
  if (tx?.status === 'failed' || tx?.status === 'abandoned') return 'retry'
  if (attempt.state === 'failed') return 'retry'
  const age = Date.now() - new Date(attempt.updatedAt).getTime()
  if (age < PROMPT_WINDOW_MS) return 'wait'
  return tx && age > STALE_MS ? 'retry' : 'blocked'
}

// Turns Paystack's answer to a charge into something the app can show.
async function recordChargeOutcome(attempt, data) {
  const status = String(data?.status || '')
  const base = { reference: attempt.reference, chargeStatus: status, displayText: typeof data?.display_text === 'string' ? data.display_text.slice(0, 240) : null }
  if (data?.reference && data.reference !== attempt.reference) {
    await PaystackCheckoutAttempt.updateOne({ _id: attempt.id }, { $set: { state:'reconcile', lastError:'Reference mismatch in charge response' } })
    throw fail('Unexpected payment provider response. Please contact support before paying again.',503)
  }
  if (['failed','timeout'].includes(status)) {
    await PaystackCheckoutAttempt.updateOne({ _id: attempt.id }, { $set: { state:'failed', chargeStatus: status, lastError: typeof data?.message === 'string' ? data.message.slice(0,200) : status } })
    return { ...base, state: 'failed', canRetry: true, message: 'The payment was not approved. You have not been charged. Please try again.' }
  }
  await PaystackCheckoutAttempt.updateOne({ _id: attempt.id }, { $set: { state:'pending', chargeStatus: status } })
  if (status === 'success') {
    try { const out = await reconcilePaystackGroup(attempt.reference); return { ...base, ...out, state: out.verified ? 'verified' : 'pending' } }
    catch { return { ...base, state: 'pending' } }
  }
  return { ...base, state: 'pending', needsOtp: status === 'send_otp' }
}

// Testing Mode only. Approves the whole grouped checkout in one all-or-nothing step, the same way the Owner's
// "simulate payment" tool does for a single order: no Paystack call, no Payment record (that would look like real money),
// orders marked simulated and "In Test Escrow", and paymentVerifiedAt left empty.
async function approveTestCheckout(group) {
  const reference = `SR-TEST-${crypto.randomBytes(12).toString('hex').toUpperCase()}`
  const amountMinor = minor(group.amount)
  const session = await mongoose.startSession()
  try {
    let output, paid = null
    await session.withTransaction(async () => {
      const fresh = await CheckoutGroup.findById(group.id).session(session)
      if (!fresh) throw fail('Checkout missing',404)
      if (fresh.status === 'verified') { output = { verified:true, state:'verified', alreadyVerified:true, simulated:true }; return }
      if (fresh.status !== 'pending' || fresh.paymentMethod !== 'paystack' || fresh.environment !== 'testing') throw fail('Checkout is no longer eligible')
      const orders = await Order.find({ _id:{ $in:fresh.orderIds } }).session(session)
      if (orders.length !== fresh.orderIds.length || orders.some(o => o.paymentStatus !== 'pending' || o.paymentMethod !== 'paystack' || o.environment !== 'testing' || o.cancelled || o.fulfillmentStatus !== 'pending_payment')) throw fail('Order states conflict')
      if (orders.reduce((sum,o)=>sum+minor(o.amount),0) !== amountMinor || minor(fresh.amount) !== amountMinor) throw fail('Allocation amount mismatch')
      if (await Payment.exists({ order:{ $in:fresh.orderIds } }).session(session)) throw fail('An order already has a payment record and cannot be simulated.')
      const now = new Date()
      const updated = await Order.updateMany({ _id:{ $in:fresh.orderIds }, paymentStatus:'pending', paymentMethod:'paystack', environment:'testing', isSimulatedPayment:{ $ne:true } }, { $set:{ isSimulatedPayment:true, simulatedPaymentAt:now, paymentStatus:'escrow_held', fulfillmentStatus:'awaiting_delivery', status:'In Test Escrow', paymentVerifiedAt:null, paystackRef:reference } }, { session })
      if (updated.modifiedCount !== orders.length) throw fail('Order update conflict')
      fresh.status = 'verified'; fresh.paymentReference = reference; fresh.verifiedAt = now; fresh.verifiedBy = 'test:auto-approve'
      await fresh.save({ session })
      await PaystackCheckoutAttempt.findOneAndUpdate({ checkoutId: fresh.id }, { $set:{ reference, environment:'test', amountMinor, state:'verified', channel:'mobile_money', chargeStatus:'simulated', verifiedAt:now, lastError:null } }, { upsert:true, session })
      output = { verified:true, state:'verified', simulated:true, orderCount:orders.length, reference }
      paid = { ids: fresh.orderIds, checkoutId: fresh.id }
    })
    if (paid) notifyOrdersPaid(paid.ids, paid.checkoutId)
    return output
  } finally { await session.endSession() }
}

// Idempotent, all-or-nothing allocation of one Paystack group charge across orders.
export async function reconcilePaystackGroup(reference) {
  const attempt = await PaystackCheckoutAttempt.findOne({ reference })
  if (!attempt) throw fail('Unknown reference',404)
  const tx = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`)
  if (!matchesProviderTransaction(tx,attempt)) return { verified:false, providerStatus:tx?.status || 'unknown' }
  const session = await mongoose.startSession()
  try {
    let output, paid = null
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
      const updated = await Order.updateMany({ _id:{ $in:group.orderIds }, paymentStatus:'pending', paymentMethod:'paystack' }, { $set:{ paymentStatus:'escrow_held', paymentVerifiedAt:attempt.environment === 'test' ? null : now, fulfillmentStatus:'awaiting_delivery', status:attempt.environment === 'test' ? 'In Test Escrow' : 'In Escrow', paystackRef:reference, ...(attempt.environment === 'test' ? { isSimulatedPayment:true, simulatedPaymentAt:now } : {}) } }, { session })
      if (updated.modifiedCount !== orders.length) throw fail('Order update conflict')
      group.status='verified'; group.paymentReference=reference; group.verifiedAt=now; group.verifiedBy=`paystack:${attempt.environment}`
      await group.save({ session })
      await PaystackCheckoutAttempt.updateOne({ _id:attempt.id }, { $set:{ state:'verified', verifiedAt:now, providerId:String(tx.id || '') } }, { session })
      output = { verified:true, orderCount:orders.length }
      paid = { ids: group.orderIds, checkoutId: group.id }
    })
    if (paid) notifyOrdersPaid(paid.ids, paid.checkoutId)
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
    if (attempt.state === 'verified' && group.status === 'verified') return res.json({ verified:true, alreadyVerified:true })
    const outcome = await reconcilePaystackGroup(attempt.reference)
    if (outcome.verified) return res.json(outcome)
    if (outcome.providerStatus === 'failed') await PaystackCheckoutAttempt.updateOne({ _id: attempt.id, state: { $ne: 'verified' } }, { $set: { state:'failed' } })
    const age = Date.now() - new Date(attempt.updatedAt).getTime()
    const canRetry = outcome.providerStatus === 'failed' || outcome.providerStatus === 'abandoned' || attempt.state === 'failed' || (attempt.channel === 'mobile_money' && age > PROMPT_WINDOW_MS)
    return res.json({ ...outcome, channel: attempt.channel, canRetry })
  } catch(e) { return guarded(res,e) }
})
export default router

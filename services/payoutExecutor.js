import PayoutIntent from '../models/PayoutIntent.js'
import { initiateTransfer, fetchTransfer, paystackKeyMode } from './paystackTransfers.js'
import { canTransfer } from './settlementMath.js'
import { finalizeVerifiedPayouts } from './payoutFinalizer.js'

// Call only after authoritative fulfillment, escrow, refund, and dispute checks.
// Never expose this function directly to buyers or riders.
export async function submitApprovedPayout(intentId) {
  const intent = await PayoutIntent.findById(intentId)
  if (!intent) throw new Error('Payout intent not found')
  if (!canTransfer({ ...intent.toObject(), keyMode: paystackKeyMode() })) {
    throw new Error('Payout not eligible for automated transfer')
  }
  const claimed = await PayoutIntent.findOneAndUpdate(
    { _id: intent._id, state: 'approved' },
    { $set: { state: 'submitting', submittedAt: new Date() } },
    { new: true }
  )
  if (!claimed) return { state: 'already_claimed' }
  try {
    const data = await initiateTransfer({ reference: claimed.reference, recipientCode: claimed.recipientCode, amountGhs: claimed.amountMinor / 100 })
    await PayoutIntent.updateOne({ _id: claimed._id, state: 'submitting' }, { $set: {
      state: 'pending', providerTransferCode: data.transfer_code || null,
    } })
    // Even a provider response saying success is reconciled through verification/webhook.
    return { state: 'pending', reference: claimed.reference }
  } catch (error) {
    // A request may have reached Paystack before a timeout. NEVER issue a new reference.
    await PayoutIntent.updateOne({ _id: claimed._id, state: 'submitting' }, { $set: {
      state: 'needs_reconciliation', lastErrorCode: error.code || 'TRANSFER_UNKNOWN',
    } })
    throw error
  }
}

export async function reconcilePayout(reference) {
  const intent = await PayoutIntent.findOne({ reference })
  if (!intent || intent.provider !== 'paystack') throw new Error('Unknown Paystack payout reference')
  if (intent.environment !== paystackKeyMode()) throw new Error('Paystack environment mismatch')
  const data = await fetchTransfer(reference)
  if (data.reference !== reference || data.currency !== 'GHS' || Number(data.amount) !== intent.amountMinor || data.domain !== intent.environment) {
    throw new Error('Paystack transfer identity mismatch')
  }
  const status = data.status
  const next = status === 'success' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'reversed' ? 'reversed' : 'pending'
  // Reversed is allowed after success; other stale events cannot demote succeeded.
  const allowed = next === 'reversed' ? ['pending', 'succeeded', 'needs_reconciliation', 'submitting'] : ['pending', 'needs_reconciliation', 'submitting']
  await PayoutIntent.updateOne({ _id: intent._id, state: { $in: allowed } }, { $set: {
    state: next, lastReconciledAt: new Date(), ...(next === 'succeeded' ? { settledAt: new Date() } : {}),
  } })
  const refreshed = await PayoutIntent.findById(intent._id)
  if (refreshed.state === 'succeeded') {
    // Reconciliation and finalization are separate, retryable operations.
    // A failed DB finalization must not change Paystack's confirmed result.
    await finalizeVerifiedPayouts(refreshed.order)
  }
  return refreshed
}

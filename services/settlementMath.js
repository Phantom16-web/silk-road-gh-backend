// Pure calculations in integer pesewas. Never use client-supplied commission or rider fee.
export function ghsToMinor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid GHS amount')
  const cents = Math.round(value * 100)
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) throw new Error('GHS amount must have at most two decimals')
  return cents
}
export function allocateOrder({ grossMinor, commissionBps, riderMinor = 0 }) {
  for (const x of [grossMinor, commissionBps, riderMinor]) {
    if (!Number.isSafeInteger(x) || x < 0) throw new Error('Invalid settlement inputs')
  }
  if (commissionBps > 10000) throw new Error('Invalid commission')
  const commissionMinor = Math.round(grossMinor * commissionBps / 10000)
  const eligibleSellerMinor = grossMinor - commissionMinor
  if (riderMinor > eligibleSellerMinor) throw new Error('Rider fee exceeds eligible seller proceeds')
  const sellerMinor = eligibleSellerMinor - riderMinor
  if (sellerMinor + riderMinor + commissionMinor !== grossMinor) throw new Error('Settlement does not balance')
  return { grossMinor, commissionMinor, riderMinor, sellerMinor }
}
export function canTransfer({ environment, provider, state, amountMinor, recipientCode, keyMode }) {
  return provider === 'paystack' && state === 'approved' &&
    environment === keyMode && Number.isSafeInteger(amountMinor) && amountMinor >= 1000 &&
    /^RCP_[A-Za-z0-9]+$/.test(recipientCode || '')
}

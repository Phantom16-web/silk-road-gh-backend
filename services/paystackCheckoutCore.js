import crypto from 'node:crypto'
export function minor(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw Error('INVALID_AMOUNT')
  const n = Math.round(amount * 100)
  if (!Number.isSafeInteger(n) || Math.abs(amount * 100 - n) > 0.00001) throw Error('INVALID_AMOUNT')
  return n
}
export function keyEnvironment(key) {
  if (key?.startsWith('sk_test_')) return 'test'
  if (key?.startsWith('sk_live_')) return 'live'
  throw Error('PAYSTACK_KEY_UNCONFIGURED')
}
export function verifySignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest()
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}
export function matchesProviderTransaction(tx, attempt) {
  return tx?.status === 'success' && tx.reference === attempt.reference && tx.currency === 'GHS' && Number(tx.amount) === attempt.amountMinor && tx.domain === attempt.environment
}
export function checkoutClaim(token, hash) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || !/^[0-9a-f]{64}$/.test(hash || '')) return false
  const computed = crypto.createHash('sha256').update(token).digest()
  return crypto.timingSafeEqual(computed, Buffer.from(hash,'hex'))
}

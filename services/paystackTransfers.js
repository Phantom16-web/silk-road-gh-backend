// Shared provider adapter for the MAIN Silk Road payout flow, not a test console.
// A caller must first commit an authorized, uniquely identified payout intent in
// Silk Road's own ledger. Never call this directly from buyer/seller input.
const BASE = 'https://api.paystack.co'

export class PaystackTransferError extends Error {
  constructor(message, code = 'PAYSTACK_TRANSFER_ERROR') {
    super(message)
    this.code = code
  }
}

export function paystackKeyMode() {
  const key = process.env.PAYSTACK_SECRET_KEY || ''
  if (key.startsWith('sk_test_')) return 'test'
  if (key.startsWith('sk_live_')) return 'live'
  return 'unconfigured'
}

async function request(path, { method = 'GET', body } = {}) {
  const key = process.env.PAYSTACK_SECRET_KEY || ''
  if (paystackKeyMode() === 'unconfigured') throw new PaystackTransferError('Paystack secret key is not configured', 'PAYSTACK_NOT_CONFIGURED')
  let response, payload
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    })
    payload = await response.json()
  } catch {
    // A timeout is ambiguous: Paystack may have accepted the transfer.
    // Reconcile using its unique reference before considering a retry.
    throw new PaystackTransferError('Paystack response unavailable; reconcile reference before retry', 'PAYSTACK_UNKNOWN_OUTCOME')
  }
  if (!response.ok || payload?.status !== true) {
    throw new PaystackTransferError(payload?.message || 'Paystack rejected the request', 'PAYSTACK_API_REJECTED')
  }
  return payload.data
}

function validGhs(amount) {
  const cents = Math.round(Number(amount) * 100)
  if (!Number.isSafeInteger(cents) || cents <= 0 || Math.abs(Number(amount) * 100 - cents) > 0.00001) {
    throw new PaystackTransferError('Invalid GHS amount', 'INVALID_AMOUNT')
  }
  return cents
}

export async function createTransferRecipient({ name, accountNumber, bankCode, type = 'mobile_money' }) {
  if (!['mobile_money', 'ghipss'].includes(type)) throw new PaystackTransferError('Unsupported recipient type', 'INVALID_RECIPIENT_TYPE')
  if (![name, accountNumber, bankCode].every(x => typeof x === 'string' && x.trim())) throw new PaystackTransferError('Incomplete recipient details', 'INVALID_RECIPIENT')
  return request('/transferrecipient', { method: 'POST', body: {
    type, name: name.trim(), account_number: accountNumber.trim(), bank_code: bankCode.trim(), currency: 'GHS',
  } })
}

export async function initiateTransfer({ reference, recipientCode, amountGhs, reason = 'Silk Road settlement' }) {
  if (!/^SR-(?:SELLER|RIDER)-[A-Za-z0-9-]{8,120}$/.test(reference || '')) throw new PaystackTransferError('Invalid payout reference', 'INVALID_REFERENCE')
  if (!/^RCP_[A-Za-z0-9]+$/.test(recipientCode || '')) throw new PaystackTransferError('Invalid recipient code', 'INVALID_RECIPIENT')
  return request('/transfer', { method: 'POST', body: {
    source: 'balance', amount: validGhs(amountGhs), recipient: recipientCode,
    reference, reason: String(reason).slice(0, 100), currency: 'GHS',
  } })
}

export async function fetchTransfer(reference) {
  if (typeof reference !== 'string' || !/^SR-(?:SELLER|RIDER)-[A-Za-z0-9-]{8,120}$/.test(reference)) throw new PaystackTransferError('Invalid reference', 'INVALID_REFERENCE')
  return request(`/transfer/verify/${encodeURIComponent(reference)}`)
}

export async function verifyTransaction(reference, expectedGhs) {
  if (typeof reference !== 'string' || !/^[A-Za-z0-9._-]{6,180}$/.test(reference)) throw new PaystackTransferError('Invalid payment reference', 'INVALID_REFERENCE')
  const data = await request(`/transaction/verify/${encodeURIComponent(reference)}`)
  if (data.reference !== reference || data.currency !== 'GHS' || Number(data.amount) !== validGhs(expectedGhs)) {
    throw new PaystackTransferError('Paystack transaction does not match the order', 'PAYSTACK_AMOUNT_MISMATCH')
  }
  const expectedDomain = paystackKeyMode()
  if (data.domain !== expectedDomain) throw new PaystackTransferError('Paystack environment mismatch', 'PAYSTACK_ENV_MISMATCH')
  return { verified: data.status === 'success', status: data.status, domain: data.domain, reference: data.reference, amountGhs: Number(data.amount) / 100 }
}

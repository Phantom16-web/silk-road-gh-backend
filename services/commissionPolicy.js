import CommissionSchedule from '../models/CommissionSchedule.js'
export const DEFAULT_RATE_BPS = 800 // INITIAL 8% DEFAULT ONLY; NOT HARDCODED CHARGE POLICY
export const rateToBasisPoints = input => {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 100 || Math.abs(Math.round(input * 100) - input * 100) > 1e-7) throw new Error('Rate must be a percentage from 0 to 100 with at most two decimals.')
  return Math.round(input * 100)
}
export const feeInPesewas = (amountPesewas, rateBasisPoints) => {
  if (!Number.isSafeInteger(amountPesewas) || amountPesewas < 0 || !Number.isInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10000) throw new Error('Invalid commission calculation.')
  return Math.round(amountPesewas * rateBasisPoints / 10000)
}
export async function commissionAt(instant, session) {
  const query = CommissionSchedule.findOne({ status: 'scheduled', effectiveAt: { $lte: instant } }).sort({ effectiveAt: -1 })
  if (session) query.session(session)
  const row = await query.lean()
  return { rateBasisPoints: row?.rateBasisPoints ?? DEFAULT_RATE_BPS, scheduleId: row?._id ?? null, effectiveAt: row?.effectiveAt ?? null }
}
export function validateActivation({ currentBps, newBps, effectiveAt, now = new Date() }) {
  if (!(effectiveAt instanceof Date) || !Number.isFinite(effectiveAt.getTime())) throw new Error('Invalid effective date/time.')
  const minimum = newBps > currentBps ? 7 * 86400000 : 3600000
  if (effectiveAt.getTime() < now.getTime() + minimum) throw new Error(newBps > currentBps ? 'Commission increases require at least seven days notice.' : 'Schedule changes at least one hour in advance.')
  if (effectiveAt.getTime() > now.getTime() + 366 * 86400000) throw new Error('Effective date must be within one year.')
}

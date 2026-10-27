import express from 'express'
import mongoose from 'mongoose'
import CommissionSchedule from '../models/CommissionSchedule.js'
import CommissionNotice from '../models/CommissionNotice.js'
import CommissionAudit from '../models/CommissionAudit.js'
import { commissionAt, rateToBasisPoints, validateActivation } from '../services/commissionPolicy.js'
import { requireAdminAuth, requireOwner, requireReAuth, logAction } from '../middleware/adminAuth.js'
import protect from '../middleware/auth.js'
const router = express.Router()
router.get('/current', async (_req, res) => {
 try { const c = await commissionAt(new Date()); res.json({ ratePercent: c.rateBasisPoints / 100, effectiveAt: c.effectiveAt, currency: 'GHS', timezone: 'Africa/Accra' }) }
 catch { res.status(503).json({ message: 'Commission policy unavailable.' }) }
})
router.get('/owner', requireAdminAuth, requireOwner, async (_req, res) => {
 try { const now = new Date(); const [current, history] = await Promise.all([commissionAt(now), CommissionSchedule.find({}).sort({ effectiveAt: -1 }).limit(100).lean()]); res.json({ currentRatePercent: current.rateBasisPoints / 100, now, timezone: 'Africa/Accra', schedules: history.map(s => ({ ...s, ratePercent: s.rateBasisPoints / 100, previousRatePercent: s.previousRateBasisPoints / 100, effective: s.status === 'scheduled' && s.effectiveAt <= now })) }) }
 catch { res.status(503).json({ message: 'Commission management unavailable.' }) }
})
router.post('/owner/schedule', requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
 const { ratePercent, effectiveAt, reason } = req.body || {}
 let bps, at
 try { bps = rateToBasisPoints(ratePercent); at = new Date(effectiveAt); if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 2000) throw new Error('Explain the change in 10–2000 characters.'); if (typeof effectiveAt !== 'string' || !/Z$|[+-]\d\d:\d\d$/.test(effectiveAt)) throw new Error('An offset-aware effective timestamp is required.') }
 catch (e) { return res.status(400).json({ message: e.message }) }
 const session = await mongoose.startSession()
 try {
  let scheduled
  await session.withTransaction(async () => {
   const now = new Date(), current = await commissionAt(now, session)
   const pending = await CommissionSchedule.find({ status: 'scheduled', effectiveAt: { $gt: now } }).session(session)
   if (pending.length) throw Object.assign(new Error('Cancel the existing pending change before scheduling another.'), { status: 409 })
   if (bps === current.rateBasisPoints) throw Object.assign(new Error('New rate must differ from the active rate.'), { status: 409 })
   validateActivation({ currentBps: current.rateBasisPoints, newBps: bps, effectiveAt: at, now })
   const rows = await CommissionSchedule.create([{ effectiveAt: at, rateBasisPoints: bps, previousRateBasisPoints: current.rateBasisPoints, reason: reason.trim(), createdBy: req.adminUser._id, createdByEmail: req.adminUser.email }], { session })
   scheduled = rows[0]
   await CommissionAudit.create([{ schedule: scheduled._id, action: 'scheduled', actor: req.adminUser._id, actorEmail: req.adminUser.email, details: { oldRateBps: current.rateBasisPoints, newRateBps: bps, effectiveAt: at, reason: reason.trim() } }], { session })
  })
  await logAction(req, 'commission_scheduled', 'commission', String(scheduled._id), { ratePercent, effectiveAt: at.toISOString() })
  return res.status(201).json({ scheduleId: scheduled.id, effectiveAt: scheduled.effectiveAt, ratePercent: bps / 100, noticeStatus: 'pending', message: 'Commission change scheduled. In-app seller notice delivery will be processed asynchronously.' })
 } catch (e) { return res.status(e.status || (e.code === 11000 ? 409 : 503)).json({ message: e.status || e.code === 11000 ? e.message : 'Unable to schedule commission change.' }) }
 finally { await session.endSession() }
})
router.post('/owner/:id/cancel', requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
 if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule ID.' })
 const session = await mongoose.startSession()
 try {
  let cancelled
  await session.withTransaction(async () => {
   const now = new Date()
   cancelled = await CommissionSchedule.findOneAndUpdate({ _id: req.params.id, status: 'scheduled', effectiveAt: { $gt: now } }, { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: req.adminUser._id } }, { new: true, session })
   if (!cancelled) throw Object.assign(new Error('Only future scheduled changes may be cancelled.'), { status: 409 })
   await CommissionAudit.create([{ schedule: cancelled._id, action: 'cancelled', actor: req.adminUser._id, actorEmail: req.adminUser.email, details: { effectiveAt: cancelled.effectiveAt, rateBasisPoints: cancelled.rateBasisPoints } }], { session })
  })
  await logAction(req, 'commission_cancelled', 'commission', String(cancelled._id), {})
  return res.json({ status: 'cancelled', scheduleId: cancelled.id, message: 'Scheduled change cancelled. Cancellation notices will be generated for affected sellers.' })
 } catch (e) { return res.status(e.status || 503).json({ message: e.status ? e.message : 'Unable to cancel schedule.' }) }
 finally { await session.endSession() }
})
router.get('/seller/notices', protect, async (req, res) => {
 try { const notices = await CommissionNotice.find({ seller: req.user.id }).sort({ createdAt: -1 }).limit(100).lean(); res.json({ notices }) }
 catch { res.status(503).json({ message: 'Unable to load commission notices.' }) }
})
router.post('/seller/notices/:id/read', protect, async (req, res) => {
 if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notice.' })
 const result = await CommissionNotice.updateOne({ _id: req.params.id, seller: req.user.id, readAt: null }, { $set: { readAt: new Date() } })
 return res.json({ acknowledged: result.modifiedCount === 1 })
})
export default router

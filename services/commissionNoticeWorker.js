import CommissionSchedule from '../models/CommissionSchedule.js'
import CommissionNotice from '../models/CommissionNotice.js'
import Listing from '../models/Listing.js'
let timer = null
let busy = false
export async function processCommissionNotices() {
 if (busy) return
 busy = true
 try {
  const now = new Date()
  const schedules = await CommissionSchedule.find({ $or: [{ status: 'scheduled', effectiveAt: { $gt: now } }, { status: 'cancelled' }] }).sort({ createdAt: 1 }).limit(20).lean()
  const sellerIds = (await Listing.distinct('seller', { seller: { $ne: null } })).filter(Boolean)
  for (const schedule of schedules) {
   const needsAnnouncement = schedule.noticeStatus !== 'complete'
   const needsReminder = schedule.status === 'scheduled' && schedule.effectiveAt.getTime() - now.getTime() <= 24 * 3600000
   const needsCancellation = schedule.status === 'cancelled'
   const kinds = [needsAnnouncement ? 'announcement' : null, needsReminder ? 'reminder' : null, needsCancellation ? 'cancelled' : null].filter(Boolean)
   if (!kinds.length) continue
   const oldRate = (schedule.previousRateBasisPoints / 100).toFixed(2), newRate = (schedule.rateBasisPoints / 100).toFixed(2)
   const when = `${schedule.effectiveAt.toISOString().replace('T', ' ').slice(0, 16)} GMT`
   for (let start = 0; start < sellerIds.length; start += 250) {
    const chunk = sellerIds.slice(start, start + 250)
    const ops = chunk.flatMap(seller => kinds.map(kind => ({ updateOne: { filter: { schedule: schedule._id, seller, kind }, update: { $setOnInsert: { title: kind === 'cancelled' ? 'Commission change cancelled' : kind === 'reminder' ? 'Commission change reminder' : 'Scheduled commission change', message: kind === 'cancelled' ? `The planned commission change from ${oldRate}% to ${newRate}% for ${when} has been cancelled.` : `Silk Road's platform commission is scheduled to change from ${oldRate}% to ${newRate}% on ${when}. Existing checkout commission allocations will not change.` } }, upsert: true } })))
    if (ops.length) await CommissionNotice.bulkWrite(ops, { ordered: false })
   }
   if (needsAnnouncement) await CommissionSchedule.updateOne({ _id: schedule._id }, { $set: { noticeStatus: 'complete', noticeCount: sellerIds.length, noticeLastRunAt: new Date() } })
  }
 } catch (e) { console.error('Commission notice delivery failed:', e) }
 finally { busy = false }
}
export function startCommissionNoticeWorker() {
 if (timer) return
 void processCommissionNotices()
 timer = setInterval(() => { void processCommissionNotices() }, 120000)
 timer.unref?.()
}

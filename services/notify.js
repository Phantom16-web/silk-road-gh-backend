import mongoose from "mongoose"
import Notification from "../models/Notification.js"

// Socket rooms. Authenticated sockets join these in server.js.
export const userRoom = id => `user:${id}`
export const riderRoom = id => `rider:${id}`
export const ONLINE_RIDERS_ROOM = "riders:online"
export const ONLINE_TEST_RIDERS_ROOM = "riders:online:test"

// server.js registers the socket server once, so code with no request (webhook workers, sweepers) can notify too.
let ioRef = null
export const registerIo = io => { ioRef = io }
const getIo = app => app?.get?.("io") || ioRef

const toId = v => (v && mongoose.isValidObjectId(String(v)) ? String(v) : null)

/**
 * Save a notification, then push it live to the recipient's room.
 * Saving comes first, so a user who is offline still sees it on next load.
 * Never throws: a notification failure must not break a delivery request.
 *
 *  type      legacy socket event name (delivery_accepted, ...). Frontend listeners keep working.
 *  data      safe to store and to emit
 *  live      emitted only, never stored (e.g. { otp })
 *  aliases   extra event names to emit the same payload under
 *  dedupeKey if set, a second notify with the same key for this recipient is ignored
 */
export async function notify(app, {
  recipient, recipientModel = "User", type, title = "", message = "",
  deliveryId = null, orderId = null, data = {}, live = {}, aliases = [], dedupeKey = null,
}) {
  try {
    const to = toId(recipient)
    if (!to || !type) return null

    let doc
    try {
      doc = await Notification.create({
        recipient: to, recipientModel, type, title, message,
        delivery: toId(deliveryId), order: toId(orderId), data,
        ...(dedupeKey ? { dedupeKey: String(dedupeKey) } : {}),
      })
    } catch (err) {
      if (err?.code === 11000) return null // already notified for this event
      throw err
    }

    const io = getIo(app)
    if (io) {
      const room = recipientModel === "Rider" ? riderRoom(to) : userRoom(to)
      const publicPayload = { ...data, message, title, type, notificationId: String(doc._id), createdAt: doc.createdAt }
      const payload = { ...publicPayload, ...live }
      io.to(room).emit(type, payload)
      for (const alias of aliases) io.to(room).emit(alias, payload)
      io.to(room).emit("notification", publicPayload) // one generic event the bell and toasts listen to (never carries secrets)
    }
    return doc
  } catch (err) {
    console.error("notify error:", err.message)
    return null
  }
}

// New job: only online, approved riders of the matching mode get it. Testing Mode jobs go to
// test riders only; live jobs go to real riders only, so the two never mix.
export function notifyOnlineRiders(app, jobPayload, { testing = false } = {}) {
  try {
    getIo(app)?.to(testing ? ONLINE_TEST_RIDERS_ROOM : ONLINE_RIDERS_ROOM).emit("new_delivery_job", jobPayload)
  } catch (err) { console.error("notifyOnlineRiders error:", err.message) }
}

// Call after a rider's online/approved state changes so live job pushes follow it.
export function syncRiderOnlineRoom(app, riderId, shouldBeOnline, isTestRider = false) {
  try {
    const io = getIo(app)
    const id = toId(riderId)
    if (!io || !id) return
    const sockets = io.in(riderRoom(id))
    sockets.socketsLeave(ONLINE_RIDERS_ROOM)
    sockets.socketsLeave(ONLINE_TEST_RIDERS_ROOM)
    if (shouldBeOnline) sockets.socketsJoin(isTestRider ? ONLINE_TEST_RIDERS_ROOM : ONLINE_RIDERS_ROOM)
  } catch (err) { console.error("syncRiderOnlineRoom error:", err.message) }
}

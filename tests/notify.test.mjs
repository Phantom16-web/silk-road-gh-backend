import test from "node:test"
import assert from "node:assert/strict"
import Notification from "../models/Notification.js"
import { notify, notifyOnlineRiders, syncRiderOnlineRoom, ONLINE_RIDERS_ROOM, ONLINE_TEST_RIDERS_ROOM } from "../services/notify.js"

const ID = "64b7f0c2a1b2c3d4e5f60718"
const RIDER = "64b7f0c2a1b2c3d4e5f60719"

function fakeApp() {
  const emitted = []
  const io = { to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) }
  return { emitted, app: { get: key => (key === "io" ? io : undefined) } }
}
function stubCreate(impl) { const orig = Notification.create; Notification.create = impl; return () => { Notification.create = orig } }

test("stores first, then emits to the user's room", async () => {
  const { app, emitted } = fakeApp(); const saved = []
  const restore = stubCreate(async doc => { saved.push(doc); return { _id: "n1", createdAt: new Date(0) } })
  await notify(app, { recipient: ID, type: "delivery_accepted", title: "T", message: "hi", deliveryId: ID, data: { deliveryId: ID } })
  restore()
  assert.equal(saved.length, 1)
  assert.equal(emitted[0].room, `user:${ID}`)
  assert.equal(emitted[0].event, "delivery_accepted")
  assert.equal(emitted[0].payload.notificationId, "n1")
})

test("OTP is emitted live but never stored", async () => {
  const { app, emitted } = fakeApp(); let saved
  const restore = stubCreate(async doc => { saved = doc; return { _id: "n2", createdAt: new Date() } })
  await notify(app, { recipient: ID, type: "delivery_otp_ready", data: { deliveryId: ID }, live: { otp: "123456" }, aliases: ["delivery_otp"] })
  restore()
  assert.ok(!JSON.stringify(saved).includes("123456"))
  assert.deepEqual(emitted.map(e => e.event), ["delivery_otp_ready", "delivery_otp", "notification"])
  assert.equal(emitted[2].payload.otp, undefined) // the generic event never carries the code
  assert.equal(emitted[0].payload.otp, "123456")
})

test("riders are addressed by rider room", async () => {
  const { app, emitted } = fakeApp()
  const restore = stubCreate(async () => ({ _id: "n3", createdAt: new Date() }))
  await notify(app, { recipient: RIDER, recipientModel: "Rider", type: "delivery_completed" })
  restore()
  assert.equal(emitted[0].room, `rider:${RIDER}`)
})

test("duplicate event is ignored: no second emit", async () => {
  const { app, emitted } = fakeApp()
  const restore = stubCreate(async () => { const e = new Error("dup"); e.code = 11000; throw e })
  const result = await notify(app, { recipient: ID, type: "sale_completed", dedupeKey: "k" })
  restore()
  assert.equal(result, null); assert.equal(emitted.length, 0)
})

test("bad recipient or database failure never throws", async () => {
  const { app, emitted } = fakeApp()
  assert.equal(await notify(app, { recipient: "nope", type: "x" }), null)
  const restore = stubCreate(async () => { throw new Error("db down") })
  assert.equal(await notify(app, { recipient: ID, type: "x" }), null)
  restore(); assert.equal(emitted.length, 0)
})

test("new jobs go to the online-riders room only", () => {
  const { app, emitted } = fakeApp()
  notifyOnlineRiders(app, { _id: "d1" })
  assert.deepEqual(emitted.map(e => [e.room, e.event]), [[ONLINE_RIDERS_ROOM, "new_delivery_job"]])
})

test("Testing Mode jobs go to the test riders room, never the live one", () => {
  const { app, emitted } = fakeApp()
  notifyOnlineRiders(app, { _id: "d2" }, { testing: true })
  assert.deepEqual(emitted.map(e => [e.room, e.event]), [[ONLINE_TEST_RIDERS_ROOM, "new_delivery_job"]])
})

test("online state moves a rider into the room that matches their mode", () => {
  const calls = []
  const io = { in: room => ({ socketsJoin: r => calls.push(["join", room, r]), socketsLeave: r => calls.push(["leave", room, r]) }) }
  const app = { get: () => io }
  syncRiderOnlineRoom(app, RIDER, true, true)
  assert.deepEqual(calls.filter(c => c[0] === "join"), [["join", `rider:${RIDER}`, ONLINE_TEST_RIDERS_ROOM]])
  calls.length = 0
  syncRiderOnlineRoom(app, RIDER, false, true)
  assert.equal(calls.filter(c => c[0] === "join").length, 0)
  assert.equal(calls.filter(c => c[0] === "leave").length, 2)
})

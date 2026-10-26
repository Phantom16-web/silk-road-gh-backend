import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// Intentionally opt-in. NEVER point these tests at production or a shared database.
const uri = process.env.SILK_ROAD_TEST_MONGODB_URI
const dbName = process.env.SILK_ROAD_TEST_DB
const enabled = Boolean(uri && dbName && /^silk_road_test_[a-z0-9_]+$/i.test(dbName))
const testDb = (name, fn) => test(name, { skip: !enabled && 'Requires SILK_ROAD_TEST_MONGODB_URI and an isolated silk_road_test_* database' }, fn)
let mongoose, VerifiedReceipt, GroupTransfer
async function init() {
  if (mongoose) return
  const m = await import('mongoose')
  mongoose = m.default
  VerifiedReceipt = (await import('../models/VerifiedReceipt.js')).default
  GroupTransfer = (await import('../models/GroupTransfer.js')).default
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000 })
  // Create the unique indexes before attempting concurrent writes.
  await Promise.all([VerifiedReceipt.init(), GroupTransfer.init()])
}
after(async () => { if (mongoose?.connection?.readyState === 1) await mongoose.disconnect() })
const id = () => `SC-TEST-${crypto.randomUUID()}`
const ref = () => `TEST-${crypto.randomUUID()}`

testDb('concurrent duplicate receipt inserts permit exactly one claimant', async () => {
  await init()
  const receiptId = crypto.createHash('sha256').update(ref()).digest('hex')
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
    VerifiedReceipt.create({ _id: receiptId, checkoutId: id(), network: 'test', recipient: 'test', reference: ref(), amount: 25, verifiedBy: 'test' })
  ))
  const success = attempts.filter(x => x.status === 'fulfilled')
  assert.equal(success.length, 1)
  assert.equal(attempts.filter(x => x.status === 'rejected').length, 7)
  await VerifiedReceipt.deleteOne({ _id: receiptId })
})

testDb('concurrent seller payout writes permit only one payout per order', async () => {
  await init()
  const order = new mongoose.Types.ObjectId()
  const checkoutId = id()
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
    GroupTransfer.create({ checkoutId, order, direction: 'seller_payout', amount: 23,
      network: 'test', recipient: 'test', externalReference: ref(), verifiedBy: 'test', verifiedAt: new Date() })
  ))
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1)
  await GroupTransfer.deleteMany({ checkoutId })
})

testDb('transaction rollback leaves no receipt or transfer on forced failure', async () => {
  await init()
  const checkoutId = id()
  const receiptId = crypto.createHash('sha256').update(ref()).digest('hex')
  const session = await mongoose.startSession()
  try {
    await assert.rejects(session.withTransaction(async () => {
      await VerifiedReceipt.create([{ _id: receiptId, checkoutId, network: 'test', recipient: 'test', reference: ref(), amount: 25, verifiedBy: 'test' }], { session })
      await GroupTransfer.create([{ checkoutId, order: new mongoose.Types.ObjectId(), direction: 'seller_payout', amount: 23,
        network: 'test', recipient: 'test', externalReference: ref(), verifiedBy: 'test', verifiedAt: new Date() }], { session })
      throw new Error('Intentional rollback')
    }), /Intentional rollback/)
    assert.equal(await VerifiedReceipt.countDocuments({ _id: receiptId }), 0)
    assert.equal(await GroupTransfer.countDocuments({ checkoutId }), 0)
  } finally { await session.endSession() }
})

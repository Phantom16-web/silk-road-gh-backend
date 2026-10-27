import express from 'express'
import crypto from 'node:crypto'
import { verifySignature } from '../services/paystackCheckoutCore.js'
import PaystackCheckoutAttempt from '../models/PaystackCheckoutAttempt.js'
import PaystackWebhookInbox from '../models/PaystackWebhookInbox.js'
import PaystackTransferWebhookInbox from '../models/PaystackTransferWebhookInbox.js'
import PayoutIntent from '../models/PayoutIntent.js'
const router = express.Router()
router.post('/', express.raw({ type:'application/json', limit:'256kb' }), async (req,res) => {
  const key = process.env.PAYSTACK_SECRET_KEY || ''
  if (!Buffer.isBuffer(req.body) || !key || !verifySignature(req.body,req.headers['x-paystack-signature'],key)) return res.sendStatus(401)
  let event
  try { event=JSON.parse(req.body.toString('utf8')) } catch { return res.sendStatus(400) }
  if (!['charge.success','transfer.success','transfer.failed','transfer.reversed'].includes(event.event)) return res.sendStatus(200)
  const reference=event.data?.reference
  if (typeof reference !== 'string' || reference.length > 150) return res.sendStatus(400)
  try {
    const fingerprint=crypto.createHash('sha256').update(req.body).digest('hex')
    if (event.event === 'charge.success') {
      if (!await PaystackCheckoutAttempt.exists({ reference })) return res.sendStatus(200)
      await PaystackWebhookInbox.updateOne({ _id:fingerprint }, { $setOnInsert:{ event:'charge.success', reference } }, { upsert:true })
    } else {
      if (!await PayoutIntent.exists({ reference, provider:'paystack' })) return res.sendStatus(200)
      await PaystackTransferWebhookInbox.updateOne({ _id:fingerprint }, { $setOnInsert:{ event:event.event, reference } }, { upsert:true })
    }
    return res.sendStatus(200)
  } catch(err) { console.error('Webhook inbox write failed',err); return res.sendStatus(503) }
})
export default router

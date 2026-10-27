import express from 'express'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { requireAdminAuth, requireOwner, requireReAuth, logAction } from '../middleware/adminAuth.js'

const router = express.Router()
const schema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  enabled: { type: Boolean, default: false },
  updatedBy: String,
  updatedAt: Date,
}, { versionKey: false })
const SandboxSettings = mongoose.models.PaystackSandboxSettings || mongoose.model('PaystackSandboxSettings', schema)
const runSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  amountPesewas: { type: Number, required: true },
  email: { type: String, required: true },
  status: { type: String, enum: ['initialized','success','failed','abandoned'], default: 'initialized' },
  providerId: String,
  verifiedAt: Date,
  createdBy: String,
}, { timestamps: true })
const SandboxRun = mongoose.models.PaystackSandboxRun || mongoose.model('PaystackSandboxRun', runSchema)
const key = () => process.env.PAYSTACK_TEST_SECRET_KEY || ''
const configured = () => /^sk_test_[A-Za-z0-9]+$/.test(key())
const permitted = () => process.env.ENABLE_PAYSTACK_SANDBOX === 'true' && configured()
const enabled = async () => Boolean((await SandboxSettings.findById('global').lean())?.enabled)

async function api(path, options = {}) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json()
  if (!response.ok || payload.status !== true) throw new Error(payload.message || 'Paystack request failed')
  return payload.data
}
router.get('/settings', requireAdminAuth, requireOwner, async (req,res) => {
  try { res.json({ enabled: permitted() && await enabled(), configured: configured(), serverAllowed: process.env.ENABLE_PAYSTACK_SANDBOX === 'true', mode: 'test', affectsRealOrders: false }) }
  catch { res.status(503).json({ message: 'Sandbox settings unavailable' }) }
})
router.put('/settings', requireAdminAuth, requireOwner, requireReAuth, async (req,res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be boolean' })
  if (req.body.enabled && !permitted()) return res.status(409).json({ message: 'Set ENABLE_PAYSTACK_SANDBOX=true and a valid PAYSTACK_TEST_SECRET_KEY on the server' })
  try {
    await SandboxSettings.findByIdAndUpdate('global', { enabled: req.body.enabled, updatedBy: req.adminUser.email, updatedAt: new Date() }, { upsert: true, runValidators: true })
    await logAction(req, 'paystack_sandbox_toggled', 'payment_settings', 'global', { enabled: req.body.enabled })
    res.json({ enabled: req.body.enabled, mode: 'test', affectsRealOrders: false })
  } catch { res.status(503).json({ message: 'Unable to save sandbox setting' }) }
})
router.post('/initialize', requireAdminAuth, requireOwner, async (req,res) => {
  if (!permitted() || !(await enabled())) return res.status(403).json({ message: 'Paystack sandbox is disabled' })
  const email = String(req.body?.email || '').trim()
  const amount = Number(req.body?.amountGhs)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isFinite(amount) || amount < 1 || amount > 1000 || Math.round(amount * 100) !== amount * 100) return res.status(400).json({ message: 'Provide a valid email and amount between GHS 1 and GHS 1,000 (two decimal places)' })
  const reference = `SRTEST-${crypto.randomUUID()}`
  try {
    await SandboxRun.create({ reference, email, amountPesewas: Math.round(amount * 100), createdBy: req.adminUser.email })
    const data = await api('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: Math.round(amount * 100), currency: 'GHS', reference, metadata: { purpose: 'silk_road_sandbox_only' } }) })
    if (data.reference !== reference || !/^https:\/\/checkout\.paystack\.com\//.test(data.authorization_url || '')) throw new Error('Unexpected Paystack response')
    res.json({ reference, authorizationUrl: data.authorization_url, testOnly: true })
  } catch (err) { res.status(502).json({ message: 'Unable to initialize test transaction. Check Paystack test configuration.' }) }
})
router.get('/verify/:reference', requireAdminAuth, requireOwner, async (req,res) => {
  if (!permitted()) return res.status(403).json({ message: 'Paystack sandbox unavailable' })
  const run = await SandboxRun.findOne({ reference: req.params.reference })
  if (!run) return res.status(404).json({ message: 'Unknown test reference' })
  try {
    const data = await api(`/transaction/verify/${encodeURIComponent(run.reference)}`)
    if (data.reference !== run.reference || data.currency !== 'GHS' || data.amount !== run.amountPesewas || data.domain !== 'test') return res.status(409).json({ message: 'Provider verification mismatch. No status updated.' })
    const status = ['success','failed','abandoned'].includes(data.status) ? data.status : 'initialized'
    await SandboxRun.updateOne({ _id: run.id, status: { $ne: 'success' } }, { $set: { status, providerId: String(data.id || ''), ...(status === 'success' ? { verifiedAt: new Date() } : {}) } })
    res.json({ reference: run.reference, status, amountGhs: run.amountPesewas / 100, testOnly: true, createsEscrow: false, triggersRiderPayout: false })
  } catch { res.status(502).json({ message: 'Unable to verify with Paystack. Retry later.' }) }
})
export default router

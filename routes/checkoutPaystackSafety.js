import express from 'express'
import PaystackCheckoutAttempt from '../models/PaystackCheckoutAttempt.js'
const router = express.Router()
// A pending or uncertain Paystack charge must be reconciled before cancellation.
router.post('/:checkoutId/cancel', async (req,res,next) => {
  try {
    const attempt = await PaystackCheckoutAttempt.exists({ checkoutId:req.params.checkoutId, state:{ $in:['initializing','pending','reconcile','verified'] } })
    if (attempt) return res.status(409).json({ code:'PAYSTACK_RECONCILIATION_REQUIRED', message:'Paystack payment may have been initiated. Verify provider status and contact support before cancelling or refunding.' })
    return next()
  } catch(e) { console.error('Paystack cancellation guard failed',e); return res.status(503).json({message:'Cancellation safety check unavailable.'}) }
})
export default router

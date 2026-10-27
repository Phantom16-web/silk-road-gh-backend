import express from 'express'
import PaymentSettings, { getPaymentMode } from '../models/PaymentSettings.js'
import { requireAdminAuth, requireOwner, requireReAuth, logAction } from '../middleware/adminAuth.js'
const router=express.Router()
const paystackReady=()=>Boolean(process.env.PAYSTACK_SECRET_KEY?.match(/^sk_(test|live)_[A-Za-z0-9]+$/)) && process.env.ENABLE_HYBRID_PAYSTACK==='true'
const publicSettings={contactPhone:'054 388 3608',contactWhatsApp:'233543883608',deliveryFee:10,footerTagline:"Ghana's student marketplace. Buy, sell, rent and request services with Mobile Money.",aboutText:'Silk Road GH connects university students across Ghana.',privacyText:'Contact, order and delivery information is processed to facilitate transactions.'}
router.get('/',async(req,res)=>{try{res.json({...publicSettings,paymentMode:await getPaymentMode()})}catch{res.status(503).json({message:'Payment configuration unavailable.'})}})
router.get('/payment-mode',requireAdminAuth,requireOwner,async(req,res)=>{try{res.json({paymentMode:await getPaymentMode(),paystackAvailable:paystackReady(),providerEnvironment:process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_test_')?'test':process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_')?'live':'unconfigured'})}catch{res.status(503).json({message:'Payment configuration unavailable.'})}})
router.put('/payment-mode',requireAdminAuth,requireOwner,requireReAuth,async(req,res)=>{
 const mode=req.body?.mode
 if(!['manual','paystack'].includes(mode))return res.status(400).json({message:'Invalid payment provider.'})
 if(mode==='paystack'&&!paystackReady())return res.status(409).json({message:'Paystack is not configured or hybrid activation is disabled.'})
 try{const previous=await getPaymentMode();await PaymentSettings.findByIdAndUpdate('global',{paymentMode:mode,changedBy:req.adminUser.email,changedAt:new Date()},{upsert:true,runValidators:true});await logAction(req,'payment_provider_changed','payment_settings','global',{from:previous,to:mode});return res.json({paymentMode:mode,paystackAvailable:paystackReady()})}catch(e){console.error('Payment mode update failed',e);return res.status(500).json({message:'Unable to save payment settings.'})}
})
export default router

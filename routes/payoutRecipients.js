import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Rider from '../models/Rider.js'
import PayoutRecipient from '../models/PayoutRecipient.js'
import {requireAdminAuth,requireOwner,requireReAuth,logAction} from '../middleware/adminAuth.js'
import {createTransferRecipient,paystackKeyMode} from '../services/paystackTransfers.js'
import {sweepSettlements} from '../services/autoSettlement.js'
import {normalizeGhPhone} from '../services/ghPhone.js'
const router=express.Router()
const respond=(fn)=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error('Recipient onboarding:',e);res.status(e.status||503).json({message:e.status?e.message:'Recipient verification unavailable; contact support.'})})
const fail=(m,status=400)=>Object.assign(new Error(m),{status})
// Beneficiaries enroll their OWN payout destination; Owner cannot silently
// substitute a recipient at settlement approval.
router.post('/me',respond(async(req,res)=>{
 const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
 let id
 try{id=jwt.verify(token||'',process.env.JWT_SECRET)?.id}catch{throw fail('Login required',401)}
 if(!mongoose.isValidObjectId(id))throw fail('Invalid login',401)
 const {role,accountName,accountNumber,bankCode,type}=req.body||{}
 if(!['seller','rider'].includes(role)||!['mobile_money','ghipss'].includes(type)||![accountName,accountNumber,bankCode].every(v=>typeof v==='string'&&v.trim()&&v.length<=120))throw fail('Invalid payout destination')
 if(!/^[+0-9]{8,30}$/.test(accountNumber.trim())||!/^[A-Za-z0-9_-]{2,30}$/.test(bankCode.trim()))throw fail('Invalid account or network code')
 const beneficiary=role==='rider'?await Rider.findById(id).select('isApproved isActive'):await User.findById(id).select('_id')
 if(!beneficiary||(role==='rider'&&(!beneficiary.isApproved||!beneficiary.isActive)))throw fail('Eligible account required',403)
 const environment=paystackKeyMode()
 if(!['test','live'].includes(environment))throw fail('Paystack not configured',503)
 const existing=await PayoutRecipient.findOne({beneficiary:id,role,environment}).select('+accountNumber')
 const number=type==='mobile_money'?(normalizeGhPhone(accountNumber).local||accountNumber.trim()):accountNumber.trim()
 if(existing?.status==='approved'&&existing.accountNumber===number&&existing.bankCode===bankCode.trim())return res.json({status:'approved',message:'This payout account is already active.'})
 // Created at Paystack straight away. In Testing Mode nothing is sent to Paystack because test payouts are simulated.
 let recipientCode='RCP_TESTSIM'
 if(environment==='live'){
  const provider=await createTransferRecipient({name:accountName.trim(),accountNumber:number,bankCode:bankCode.trim(),type})
  if(!/^RCP_[A-Za-z0-9]+$/.test(provider.recipient_code||''))throw fail('Paystack could not verify this account. Check the number and network.',503)
  recipientCode=provider.recipient_code
 }
 // Changing an active destination pauses payouts to the new one for 24 hours, so a hijacked session cannot redirect money quickly.
 const holdUntil=existing?.status==='approved'&&environment==='live'?new Date(Date.now()+24*3600*1000):null
 await PayoutRecipient.findOneAndUpdate({beneficiary:id,role,environment},{ $set:{accountName:accountName.trim(),accountNumber:number,bankCode:bankCode.trim(),type,status:'approved',recipientCode,reviewedAt:new Date(),reviewedBy:'system:auto',reviewEvidence:'Self-service destination, verified by Paystack recipient creation',holdUntil} },{upsert:true,new:true,runValidators:true})
 sweepSettlements().catch(()=>{})
 res.status(201).json({status:'approved',holdUntil,message:holdUntil?'Saved. For your protection payouts to this new account start in 24 hours.':'Payout account saved. Your money is sent here automatically after each confirmed delivery.'})
}))
// What the owner of the account sees on their Payouts screen (the full number is never returned).
router.get('/me/summary',respond(async(req,res)=>{
 const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
 let id
 try{id=jwt.verify(token||'',process.env.JWT_SECRET)?.id}catch{throw fail('Login required',401)}
 if(!mongoose.isValidObjectId(id))throw fail('Invalid login',401)
 const role=req.query.role==='rider'?'rider':'seller'
 const environment=paystackKeyMode()
 const row=['test','live'].includes(environment)?await PayoutRecipient.findOne({beneficiary:id,role,environment}).select('+accountNumber').lean():null
 const n=row?.accountNumber||''
 res.json({environment,configured:Boolean(row&&row.status==='approved'),recipient:row?{accountName:row.accountName,bankCode:row.bankCode,type:row.type,numberMasked:n.length>=7?`${n.slice(0,3)} \u2022\u2022\u2022 ${n.slice(-4)}`:'\u2022\u2022\u2022\u2022',holdUntil:row.holdUntil||null}:null})
}))
router.get('/owner/pending',requireAdminAuth,requireOwner,respond(async(req,res)=>{
 const rows=await PayoutRecipient.find({status:'pending_review'}).select('-accountNumber').limit(100).lean()
 res.json({recipients:rows})
}))
router.post('/owner/:id/approve',requireAdminAuth,requireOwner,requireReAuth,respond(async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))throw fail('Invalid recipient')
 const evidence=String(req.body?.reviewEvidence||'').trim()
 if(evidence.length<12||evidence.length>500)throw fail('Record independent identity/account ownership verification evidence (12–500 characters)')
 const profile=await PayoutRecipient.findById(req.params.id).select('+accountNumber')
 if(!profile||profile.status!=='pending_review')throw fail('Recipient no longer awaiting review',409)
 if(profile.environment!==paystackKeyMode())throw fail('Paystack environment mismatch',409)
 // The Paystack recipient is created using the beneficiary-submitted destination,
 // never a recipient code supplied by the Owner at payout time.
 const provider=await createTransferRecipient({name:profile.accountName,accountNumber:profile.accountNumber,bankCode:profile.bankCode,type:profile.type})
 if(!/^RCP_[A-Za-z0-9]+$/.test(provider.recipient_code||''))throw fail('Provider did not confirm recipient',503)
 const changed=await PayoutRecipient.updateOne({_id:profile.id,status:'pending_review'},{$set:{recipientCode:provider.recipient_code,status:'approved',reviewedAt:new Date(),reviewedBy:req.adminUser.email,reviewEvidence:evidence}})
 if(changed.modifiedCount!==1)throw fail('Recipient review changed; reconcile duplicate provider recipient before retry',409)
 await logAction(req,'paystack_recipient_approved','payout_recipient',profile.id,{role:profile.role,environment:profile.environment})
 res.json({status:'approved',role:profile.role,environment:profile.environment})
}))
export default router

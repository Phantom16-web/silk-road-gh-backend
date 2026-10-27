import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Rider from '../models/Rider.js'
import PayoutRecipient from '../models/PayoutRecipient.js'
import {requireAdminAuth,requireOwner,requireReAuth,logAction} from '../middleware/adminAuth.js'
import {createTransferRecipient,paystackKeyMode} from '../services/paystackTransfers.js'
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
 const existing=await PayoutRecipient.findOne({beneficiary:id,role,environment})
 if(existing?.status==='approved')throw fail('Approved payout destinations cannot be changed here; contact support',409)
 if(existing?.status==='pending_review')throw fail('Payout destination is awaiting review',409)
 await PayoutRecipient.findOneAndUpdate({beneficiary:id,role,environment},{ $set:{accountName:accountName.trim(),accountNumber:accountNumber.trim(),bankCode:bankCode.trim(),type,status:'pending_review',recipientCode:null,reviewedAt:null,reviewedBy:null,reviewEvidence:null} },{upsert:true,new:true,runValidators:true})
 res.status(201).json({status:'pending_review',message:'Payout destination submitted for independent Owner review. No transfer has been made.'})
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

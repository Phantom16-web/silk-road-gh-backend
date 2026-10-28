import express from 'express'
import jwt from 'jsonwebtoken'
import Rider from '../models/Rider.js'
import upload from '../middleware/upload.js'

const router = express.Router()
const generateToken = id => jwt.sign({ id, role: 'rider' }, process.env.JWT_SECRET, { expiresIn: '30d' })
function getRiderId(req) {
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    if (!token) return null
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    return payload.role === 'rider' ? payload.id : null
  } catch { return null }
}
function safe(r) {
  return { _id:r._id, name:r.name, phone:r.phone, email:r.email, university:r.university,
    vehicle:r.vehicle, isOnline:r.isOnline, isActive:r.isActive, isApproved:r.isApproved,
    photoReviewStatus:r.photoReviewStatus, photoUrl:r.photoReviewStatus==='approved'?r.photoUrl:null,
    totalEarned:r.totalEarned, totalDeliveries:r.totalDeliveries, rating:r.rating }
}
router.post('/register', upload.single('photo'), async(req,res)=>{
  try {
    const {name,phone,email,password,university,vehicle} = req.body || {}
    if (![name,phone,email].every(x=>typeof x==='string'&&x.trim()) || typeof password!=='string' || password.length<8)
      return res.status(400).json({message:'Name, phone, email and password of at least 8 characters are required.'})
    if (!req.file?.path) return res.status(400).json({message:'A clear rider face photograph is required.'})
    const v=vehicle||'motorbike'
    if (!['motorbike','bicycle','walking'].includes(v)) return res.status(400).json({message:'Unsupported vehicle type.'})
    const normalizedEmail=email.trim().toLowerCase(), normalizedPhone=phone.trim()
    if (await Rider.exists({$or:[{email:normalizedEmail},{phone:normalizedPhone}]})) return res.status(409).json({message:'Email or phone already registered.'})
    const rider=await Rider.create({name:name.trim(),phone:normalizedPhone,email:normalizedEmail,password,
      university:typeof university==='string'?university.trim():'',vehicle:v,isApproved:false,isOnline:false,isActive:true,
      photoUrl:req.file.path,photoPublicId:req.file.filename||null,photoReviewStatus:'pending'})
    return res.status(201).json({message:'Application submitted for photo and identity review.',rider:safe(rider),token:generateToken(rider.id)})
  }catch(err){
    if(err.code===11000) return res.status(409).json({message:'Email or phone already registered.'})
    console.error('Rider registration:',err)
    return res.status(500).json({message:'Unable to register rider.'})
  }
})
router.post('/login',async(req,res)=>{
  try {
    const {email,password}=req.body||{}
    if(typeof email!=='string'||typeof password!=='string') return res.status(400).json({message:'Email and password required.'})
    const rider=await Rider.findOne({email:email.trim().toLowerCase()})
    if(!rider||!await rider.matchPassword(password)) return res.status(401).json({message:'Invalid credentials.'})
    if(!rider.isActive) return res.status(403).json({message:'Rider account deactivated.'})
    return res.json({...safe(rider),token:generateToken(rider.id)})
  }catch(err){console.error(err);return res.status(500).json({message:'Login failed.'})}
})
router.get('/me',async(req,res)=>{
  try { const id=getRiderId(req);if(!id)return res.status(401).json({message:'Not authorized.'})
    const rider=await Rider.findById(id);if(!rider)return res.status(404).json({message:'Rider not found.'})
    return res.json(safe(rider))
  }catch{return res.status(500).json({message:'Unable to load rider.'})}
})
router.put('/toggle-online',async(req,res)=>{
  try {const id=getRiderId(req);if(!id)return res.status(401).json({message:'Not authorized.'})
    const rider=await Rider.findById(id);if(!rider||!rider.isActive)return res.status(403).json({message:'Rider unavailable.'})
    if(!rider.isApproved||rider.photoReviewStatus!=='approved')return res.status(403).json({message:'Admin identity and photo approval required before going online.'})
    rider.isOnline=!rider.isOnline;await rider.save();return res.json({isOnline:rider.isOnline})
  }catch{return res.status(500).json({message:'Unable to change availability.'})}
})
router.put('/location',async(req,res)=>{
  try {const id=getRiderId(req);if(!id)return res.status(401).json({message:'Not authorized.'})
    const {lat,lng}=req.body||{};if(typeof lat!=='number'||typeof lng!=='number'||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return res.status(400).json({message:'Invalid coordinates.'})
    await Rider.updateOne({_id:id,isActive:true},{$set:{currentLocation:{lat,lng,updatedAt:new Date()}}});return res.json({message:'Location updated.'})
  }catch{return res.status(500).json({message:'Location update failed.'})}
})
router.delete('/delete-account',async(req,res)=>{
  try {const id=getRiderId(req);if(!id)return res.status(401).json({message:'Not authorized.'})
    const rider=await Rider.findById(id);if(!rider)return res.status(404).json({message:'Rider not found.'})
    if(rider.activeDelivery)return res.status(409).json({message:'Complete or resolve the active delivery before account closure.'})
    rider.isActive=false;rider.isOnline=false;await rider.save();return res.json({message:'Rider account deactivated. Contact support for data deletion.'})
  }catch{return res.status(500).json({message:'Unable to deactivate account.'})}
})
export default router

import express from 'express'
import Rider from '../models/Rider.js'
import upload from '../middleware/upload.js'
import { requireAdminAuth, requirePermission } from '../middleware/adminAuth.js'

const router=express.Router()
router.get('/',async(req,res)=>{
  try {const riders=await Rider.find({isApproved:true,isActive:true,photoReviewStatus:'approved',photoUrl:{$type:'string',$ne:''}})
    .select('name vehicle rating ratingCount isOnline university photoUrl createdAt').sort({createdAt:-1}).lean()
    return res.json(riders)
  }catch(err){console.error(err);return res.status(500).json({message:'Unable to retrieve riders.'})}
})
router.post('/',upload.single('photo'),async(req,res)=>{
  try {const {name,phone,email,password,university,vehicle}=req.body||{}
    if (![name,phone,email].every(x=>typeof x==='string'&&x.trim())||typeof password!=='string'||password.length<8)return res.status(400).json({message:'Name, phone, email and password of at least 8 characters required.'})
    if(!req.file?.path)return res.status(400).json({message:'A clear face photograph is required.'})
    const v=vehicle||'motorbike';if(!['motorbike','bicycle','walking'].includes(v))return res.status(400).json({message:'Unsupported vehicle.'})
    const normalizedEmail=email.trim().toLowerCase(),normalizedPhone=phone.trim()
    if(await Rider.exists({$or:[{email:normalizedEmail},{phone:normalizedPhone}]}))return res.status(409).json({message:'Rider already exists.'})
    const rider=await Rider.create({name:name.trim(),phone:normalizedPhone,email:normalizedEmail,password,university:typeof university==='string'?university.trim():'',vehicle:v,
      photoUrl:req.file.path,photoPublicId:req.file.filename||null,photoReviewStatus:'pending',isApproved:false,isActive:true,isOnline:false})
    return res.status(201).json({message:'Rider application awaiting photo and identity review.',rider:{id:rider.id,name:rider.name,isApproved:false,photoReviewStatus:'pending'}})
  }catch(err){if(err.code===11000)return res.status(409).json({message:'Email or phone already exists.'});console.error(err);return res.status(500).json({message:'Unable to register rider.'})}
})
router.get('/admin/review',requireAdminAuth,requirePermission('manage_riders'),async(req,res)=>{
  try {const riders=await Rider.find({$or:[{isApproved:false},{photoReviewStatus:{$ne:'approved'}}]}).select('name phone email university vehicle isActive isApproved photoUrl photoReviewStatus createdAt').sort({createdAt:-1}).lean();return res.json(riders)}
  catch(err){console.error(err);return res.status(500).json({message:'Unable to retrieve applications.'})}
})
router.put('/:id/status',requireAdminAuth,requirePermission('manage_riders'),async(req,res)=>{
  try {const rider=await Rider.findById(req.params.id);if(!rider)return res.status(404).json({message:'Rider not found.'})
    const {isActive,isApproved,isOnline,photoReviewStatus}=req.body||{}
    for(const [key,value] of Object.entries({isActive,isApproved,isOnline}))if(value!==undefined&&typeof value!=='boolean')return res.status(400).json({message:`${key} must be boolean.`})
    if(photoReviewStatus!==undefined&&!['approved','rejected','pending'].includes(photoReviewStatus))return res.status(400).json({message:'Invalid photo review status.'})
    if(photoReviewStatus==='approved'&&!rider.photoUrl)return res.status(409).json({message:'Cannot approve without an uploaded photograph.'})
    if(photoReviewStatus!==undefined){rider.photoReviewStatus=photoReviewStatus;rider.photoReviewedAt=new Date()}
    if(isApproved===true&&(!rider.photoUrl||rider.photoReviewStatus!=='approved'))return res.status(409).json({message:'Approve the photograph before approving rider.'})
    if(isApproved!==undefined)rider.isApproved=isApproved
    if(isActive!==undefined)rider.isActive=isActive
    if(isOnline===true&&(!rider.isApproved||!rider.isActive||rider.photoReviewStatus!=='approved'))return res.status(409).json({message:'Rider must be active and fully approved before going online.'})
    if(isOnline!==undefined)rider.isOnline=isOnline
    if(!rider.isApproved||!rider.isActive||rider.photoReviewStatus!=='approved')rider.isOnline=false
    await rider.save();return res.json({message:'Rider review updated.',rider:{id:rider.id,name:rider.name,isActive:rider.isActive,isApproved:rider.isApproved,isOnline:rider.isOnline,photoUrl:rider.photoUrl,photoReviewStatus:rider.photoReviewStatus}})
  }catch(err){console.error(err);return res.status(500).json({message:'Unable to update rider.'})}
})
export default router

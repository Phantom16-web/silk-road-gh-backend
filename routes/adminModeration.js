import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Listing from "../models/Listing.js";
import Order from "../models/Order.js";
import Delivery from "../models/Delivery.js";
import PayoutIntent from "../models/PayoutIntent.js";
import ModerationRemoval from "../models/ModerationRemoval.js";
import {requireAdminAuth,logAction} from "../middleware/adminAuth.js";

const router=express.Router();
router.use(requireAdminAuth);
const permitted=(req,kind)=>req.adminUser.isOwner || (req.adminUser.tier==="super_admin" && req.adminUser.permissions?.includes(kind)) || req.adminUser.permissions?.includes(kind);
const valid=id=>mongoose.isValidObjectId(id);
const explain=req=>typeof req.body?.reason==="string"?req.body.reason.trim():"";
const reject=(res)=>res.status(403).json({message:"Explicit moderation permission required."});

router.get("/removed",async(req,res)=>{
  if(!permitted(req,"view_activity_logs")&&!permitted(req,"remove_listings")&&!permitted(req,"manage_users"))return reject(res);
  const kind=["user","listing"].includes(req.query.kind)?req.query.kind:undefined;
  const page=Math.min(10000,Math.max(1,Number(req.query.page)||1));
  const q={state:"removed",...(kind?{kind}:{})};
  const [records,total]=await Promise.all([ModerationRemoval.find(q).sort({removedAt:-1}).skip((page-1)*20).limit(20).lean(),ModerationRemoval.countDocuments(q)]);
  res.json({records,total,page,pages:Math.ceil(total/20)});
});
router.post("/listings/:id/remove",async(req,res)=>{
  if(!permitted(req,"remove_listings"))return reject(res);
  if(!valid(req.params.id)||explain(req).length<10)return res.status(400).json({message:"Valid listing and reason of at least 10 characters required."});
  const listing=await Listing.findById(req.params.id);
  if(!listing)return res.status(404).json({message:"Listing not found."});
  if(listing.status==="Removed")return res.status(409).json({message:"Already removed."});
  const record=await ModerationRemoval.create({kind:"listing",target:listing._id,reason:explain(req),actor:req.adminUser.email,priorStatus:listing.status});
  listing.status="Removed";await listing.save();
  await logAction(req,"listing_removed","listing",String(listing._id),{reason:explain(req),removalId:String(record._id)});
  res.json({message:"Listing removed from public view.",record});
});
router.post("/users/:id/remove",async(req,res)=>{
  if(!permitted(req,"manage_users")||!permitted(req,"remove_users"))return reject(res);
  if(!valid(req.params.id)||explain(req).length<10)return res.status(400).json({message:"Valid user and reason of at least 10 characters required."});
  const user=await User.findById(req.params.id);
  if(!user)return res.status(404).json({message:"User not found."});
  if(user.role!=="user")return res.status(403).json({message:"Privileged accounts cannot be removed here."});
  if(await ModerationRemoval.exists({kind:"user",target:user._id,state:"removed"}))return res.status(409).json({message:"Already removed."});
  const active=await Order.countDocuments({$or:[{buyer:user._id},{seller:user._id}],paymentStatus:{$in:["pending","escrow_held","release_pending","refund_pending","disputed"]}});
  if(active)return res.status(409).json({message:"Account has unresolved orders or financial obligations. Resolve them before removal.",unresolvedOrders:active});
  // A settled order may still have an unfinished rider handoff or transfer.
  const outstandingDeliveries=await Delivery.countDocuments({$or:[{buyer:user._id},{seller:user._id}],status:{$nin:["completed","cancelled","declined","failed"]}});
  if(outstandingDeliveries)return res.status(409).json({message:"Account has outstanding deliveries. Resolve them before removal.",outstandingDeliveries});
  const outstandingPayouts=await PayoutIntent.countDocuments({beneficiary:user._id,state:{$nin:["succeeded","cancelled"]}});
  if(outstandingPayouts)return res.status(409).json({message:"Account has outstanding payout or reconciliation obligations.",outstandingPayouts});
  const listings=await Listing.find({seller:user._id,status:{$ne:"Removed"}}).select("_id status").lean();
  const ids=listings.map(l=>l._id);
  const priorStatus=user.status;
  // Preserve the user and order documents for reconciliation; disable account and withdraw listings.
  user.status="Suspended";await user.save();
  // Disconnect sessions already connected to this server (and across nodes
  // when the Socket.IO adapter supports distributed rooms).
  const io=req.app.get("io");
  if(io){
    try {
      const sockets=await io.in(`user:${String(user._id)}`).fetchSockets();
      await Promise.all(sockets.map(async socket=>{
        socket.emit("account_access_revoked",{message:"Account removed by moderation."});
        socket.disconnect(true);
      }));
    }catch(err){
      console.error("Socket revocation failed; account-status checks remain active:",err);
    }
  }
  await Listing.updateMany({_id:{$in:ids}},{$set:{status:"Removed"}});
  const record=await ModerationRemoval.create({kind:"user",target:user._id,reason:explain(req),actor:req.adminUser.email,priorStatus,listingIds:ids});
  await logAction(req,"user_removed","user",String(user._id),{reason:explain(req),withdrawnListings:ids.length,removalId:String(record._id)});
  res.json({message:"Account disabled and active listings withdrawn. Financial history retained.",withdrawnListings:ids.length,record});
});
router.post("/removed/:id/restore",async(req,res)=>{
  if(!req.adminUser.isOwner)return res.status(403).json({message:"Owner approval required for restoration."});
  if(!valid(req.params.id))return res.status(400).json({message:"Invalid record ID."});
  const record=await ModerationRemoval.findOne({_id:req.params.id,state:"removed"});
  if(!record)return res.status(404).json({message:"Active removal record not found."});
  if(record.kind==="listing"){
    const listing=await Listing.findById(record.target);
    if(!listing)return res.status(409).json({message:"Listing no longer exists."});
    const seller=await User.findById(listing.seller);
    if(!seller||seller.status!=="Active"||await ModerationRemoval.exists({kind:"user",target:seller._id,state:"removed"}))return res.status(409).json({message:"Seller account is not active."});
    listing.status=record.priorStatus==="Flagged"?"Flagged":"Active";await listing.save();
  }else{
    const user=await User.findById(record.target);
    if(!user)return res.status(409).json({message:"User no longer exists."});
    user.status=record.priorStatus==="Suspended"?"Suspended":"Active";await user.save();
    // Do not reactivate listings with an independent outstanding removal record.
    const individuallyRemoved=await ModerationRemoval.find({kind:"listing",target:{$in:record.listingIds},state:"removed"}).distinct("target");
    const blocked=new Set(individuallyRemoved.map(String));
    const restoreIds=record.listingIds.filter(id=>!blocked.has(String(id)));
    if(user.status==="Active") await Listing.updateMany({_id:{$in:restoreIds},seller:user._id,status:"Removed"},{$set:{status:"Active"}});
  }
  record.state="restored";record.restoredAt=new Date();record.restoredBy=req.adminUser.email;await record.save();
  await logAction(req,"moderation_restored",record.kind,String(record.target),{removalId:String(record._id)});
  res.json({message:"Restored",record});
});
export default router;

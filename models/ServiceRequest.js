import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  listing:{type:mongoose.Schema.Types.ObjectId,ref:'Listing',required:true},
  buyer:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  provider:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  description:{type:String,required:true,maxlength:2000},
  scheduledFor:{type:Date,required:true},
  location:{type:String,default:'',maxlength:300},
  contact:{type:String,required:true,maxlength:200},
  quotedPrice:{type:Number,required:true,min:0},
  status:{type:String,enum:['requested','accepted','declined','cancelled','expired','payment_pending','paid','in_progress','provider_completed','completed','disputed'],default:'requested'},
  respondedAt:{type:Date},expiresAt:{type:Date,required:true},
  paymentOrder:{type:mongoose.Schema.Types.ObjectId,ref:'Order',default:null}
},{timestamps:true});
schema.index({provider:1,status:1,createdAt:-1});
schema.index({buyer:1,createdAt:-1});
schema.index({listing:1,scheduledFor:1});
export default mongoose.model('ServiceRequest',schema);

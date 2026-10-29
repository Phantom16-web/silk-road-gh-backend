import mongoose from "mongoose"
const location = new mongoose.Schema({lat:{type:Number,required:true,min:-90,max:90},lng:{type:Number,required:true,min:-180,max:180},address:{type:String,default:""}},{_id:false})
const schema=new mongoose.Schema({
 order:{type:mongoose.Schema.Types.ObjectId,ref:"Order",default:null,index:true},localOrderId:{type:String,default:null,index:true},
 seller:{type:mongoose.Schema.Types.ObjectId,ref:"User",required:true,index:true},buyer:{type:mongoose.Schema.Types.ObjectId,ref:"User",default:null,index:true},
 rider:{type:mongoose.Schema.Types.ObjectId,ref:"Rider",default:null,index:true},pickupLocation:{type:location,required:true},dropLocation:{type:location,required:true},
 sellerContact:{type:String,default:""},buyerContact:{type:String,default:""},distanceKm:{type:Number,required:true,min:0},deliveryFee:{type:Number,required:true,min:0},
 otp:{type:String,default:null},otpExpiresAt:{type:Date,default:null},otpVerified:{type:Boolean,default:false},otpAttempts:{type:Number,default:0},otpLocked:{type:Boolean,default:false},
 status:{type:String,enum:["pending","accepted","picked_up","delivered","completed","declined","cancelled"],default:"pending",index:true},
 acceptedAt:{type:Date,default:null},pickedUpAt:{type:Date,default:null},deliveredAt:{type:Date,default:null},completedAt:{type:Date,default:null},
 deliveryType:{type:String,enum:["rider","self"],default:"rider"},itemTitle:{type:String,default:""},itemImage:{type:String,default:""},notes:{type:String,default:""},
 sellerIdentityVerifiedAt:{type:Date,default:null},sellerIdentityVerifiedBy:{type:mongoose.Schema.Types.ObjectId,ref:"User",default:null},
 riderPhotoAtAssignment:{type:String,default:null},identityMismatchReportedAt:{type:Date,default:null},identityMismatchReason:{type:String,default:null,maxlength:1000}
},{timestamps:true})
schema.index({seller:1,status:1});schema.index({rider:1,status:1});schema.index({localOrderId:1});
export default mongoose.models.Delivery||mongoose.model("Delivery",schema)

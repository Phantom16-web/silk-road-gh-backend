import mongoose from "mongoose"
// Application append-only ledger. DB administrators can still alter records;
// external tamper-evident exports are required for production-grade audit.
const schema = new mongoose.Schema({
  checkoutId: {type:String,required:true,index:true},
  action: {type:String,enum:["dispute_opened","dispute_resolved"],required:true},
  actorType: {type:String,enum:["buyer_claim","admin"],required:true},
  actorId: {type:String,required:true},
  previousStatus: {type:String,required:true},
  nextStatus: {type:String,required:true},
  details: {type:mongoose.Schema.Types.Mixed,default:{}},
},{timestamps:{createdAt:true,updatedAt:false},versionKey:false})
schema.pre("updateOne",function(){throw new Error("Audit events cannot be modified")})
schema.pre("findOneAndUpdate",function(){throw new Error("Audit events cannot be modified")})
schema.pre("deleteOne",function(){throw new Error("Audit events cannot be deleted")})
schema.pre("findOneAndDelete",function(){throw new Error("Audit events cannot be deleted")})
export default mongoose.models.GroupAuditEvent || mongoose.model("GroupAuditEvent",schema)

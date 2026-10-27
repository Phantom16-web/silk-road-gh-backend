import mongoose from "mongoose";
const schema = new mongoose.Schema({
  kind:{type:String,enum:["user","listing"],required:true},
  target:{type:mongoose.Schema.Types.ObjectId,required:true},
  state:{type:String,enum:["removed","restored"],default:"removed"},
  reason:{type:String,required:true},
  actor:{type:String,required:true},
  removedAt:{type:Date,default:Date.now},restoredAt:Date,restoredBy:String,
  listingIds:[mongoose.Schema.Types.ObjectId],
  priorStatus:String,
},{timestamps:true});
schema.index({kind:1,target:1,state:1});
export default mongoose.model("ModerationRemoval",schema);

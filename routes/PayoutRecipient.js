import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  beneficiary: {type:mongoose.Schema.Types.ObjectId,required:true},
  role: {type:String,enum:['seller','rider'],required:true},
  environment: {type:String,enum:['test','live'],required:true},
  accountName: {type:String,required:true,maxlength:120},
  accountNumber: {type:String,required:true,maxlength:30,select:false},
  bankCode: {type:String,required:true,maxlength:30},
  type: {type:String,enum:['mobile_money','ghipss'],required:true},
  recipientCode: {type:String,default:null},
  status: {type:String,enum:['pending_review','approved','rejected'],default:'pending_review'},
  reviewedBy: {type:String,default:null},
  reviewedAt: {type:Date,default:null},
  reviewEvidence: {type:String,default:null,maxlength:500},
}, {timestamps:true})
schema.index({beneficiary:1,role:1,environment:1},{unique:true})
export default mongoose.models.PayoutRecipient || mongoose.model('PayoutRecipient',schema)

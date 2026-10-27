import PaystackTransferWebhookInbox from '../models/PaystackTransferWebhookInbox.js'
import { reconcilePayout } from './payoutExecutor.js'

export async function processPaystackTransferInboxBatch({ limit=10 }={}) {
  const results=[]
  for (let i=0;i<limit;i++) {
    const now=new Date()
    const job=await PaystackTransferWebhookInbox.findOneAndUpdate({
      state:{ $in:['pending','retry','processing'] }, nextAttemptAt:{ $lte:now },
      $or:[{lockedUntil:null},{lockedUntil:{$lte:now}}],
    }, { $set:{state:'processing',lockedUntil:new Date(Date.now()+120000)}, $inc:{attempts:1} }, {new:true,sort:{createdAt:1}})
    if (!job) break
    try {
      // Never trust the event's status alone; re-query Paystack by reference.
      await reconcilePayout(job.reference)
      await PaystackTransferWebhookInbox.updateOne({_id:job.id,state:'processing'},{$set:{state:'completed',completedAt:new Date(),lockedUntil:null,lastError:null}})
      results.push({id:job.id,state:'completed'})
    } catch (err) {
      const delay=Math.min(3600000,30000*2**Math.min(job.attempts,7))
      await PaystackTransferWebhookInbox.updateOne({_id:job.id,state:'processing'},{$set:{state:'retry',lockedUntil:null,nextAttemptAt:new Date(Date.now()+delay),lastError:String(err.message).slice(0,500)}})
      results.push({id:job.id,state:'retry'})
    }
  }
  return results
}
export function startPaystackTransferInboxWorker({intervalMs=30000}={}) {
  let active=false
  const timer=setInterval(async()=>{if(active)return;active=true;try{await processPaystackTransferInboxBatch()}catch(err){console.error('Transfer inbox worker:',err)}finally{active=false}},intervalMs)
  timer.unref?.()
  return ()=>clearInterval(timer)
}

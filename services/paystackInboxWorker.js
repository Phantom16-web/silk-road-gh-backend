import PaystackWebhookInbox from '../models/PaystackWebhookInbox.js'
import { reconcilePaystackGroup } from '../routes/checkoutPaystack.js'
export async function processPaystackInboxBatch({limit=10}={}) {
  const results=[]
  for(let i=0;i<limit;i++) {
    const now=new Date()
    const job=await PaystackWebhookInbox.findOneAndUpdate({
      state:{ $in:['pending','retry','processing'] }, nextAttemptAt:{ $lte:now },
      $or:[{ lockedUntil:null },{ lockedUntil:{ $lte:now } }],
    },{ $set:{ state:'processing', lockedUntil:new Date(Date.now()+120000) },$inc:{ attempts:1 } },{ new:true,sort:{receivedAt:1} })
    if(!job) break
    try {
      const outcome=await reconcilePaystackGroup(job.reference)
      if(!outcome.verified) throw new Error(`Paystack has not verified charge: ${outcome.providerStatus || 'unknown'}`)
      await PaystackWebhookInbox.updateOne({ _id:job.id,state:'processing' },{ $set:{ state:'completed',completedAt:new Date(),lockedUntil:null,lastError:null } })
      results.push({ id:job.id, state:'completed' })
    } catch(err) {
      // Recheck failures instead of losing a signed event. Manual investigation required for persistent errors.
      const delay=Math.min(3600000,30000*2**Math.min(job.attempts,7))
      await PaystackWebhookInbox.updateOne({ _id:job.id,state:'processing' },{ $set:{ state:'retry',lockedUntil:null,nextAttemptAt:new Date(Date.now()+delay),lastError:String(err.message).slice(0,500) } })
      results.push({ id:job.id,state:'retry' })
    }
  }
  return results
}
export function startPaystackInboxWorker({intervalMs=30000}={}) {
  let active=false
  const timer=setInterval(async()=>{
    if(active) return
    active=true
    try { await processPaystackInboxBatch() } catch(err) { console.error('Paystack inbox worker error',err) }
    finally { active=false }
  },intervalMs)
  timer.unref?.()
  return ()=>clearInterval(timer)
}

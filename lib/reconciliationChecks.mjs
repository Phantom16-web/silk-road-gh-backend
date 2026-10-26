export const cents = value => Math.round(Number(value) * 100)
export function checkGroup({group,orders,payments,transfers}) {
  const issues=[]
  const byOrder = new Map(orders.map(o=>[String(o._id),o]))
  const byPayment = new Map()
  for (const p of payments) {const key=String(p.order);byPayment.set(key,[...(byPayment.get(key)||[]),p])}
  const outgoing = transfers.filter(t=>String(t.checkoutId)===String(group._id))
  const items=group.orderIds.map(id=>byOrder.get(String(id)))
  if(items.some(o=>!o))issues.push("MISSING_SELLER_ORDER")
  if(cents(items.reduce((n,o)=>n+(o?.amount||0),0))!==cents(group.amount))issues.push("GROUP_AMOUNT_MISMATCH")
  for(const o of items.filter(Boolean)){
    const records=byPayment.get(String(o._id))||[]
    const payouts=outgoing.filter(t=>t.direction==="seller_payout"&&String(t.order)===String(o._id))
    if(records.filter(p=>p.status==="verified").length>1)issues.push("DUPLICATE_VERIFIED_PAYMENT")
    if(["escrow_held","release_pending","released"].includes(o.paymentStatus)&&!records.some(p=>["verified","refunded"].includes(p.status)))issues.push("MISSING_VERIFIED_PAYMENT")
    if(o.paymentStatus==="released"&&(payouts.length!==1||cents(payouts[0]?.amount)!==cents(o.sellerAmount)))issues.push("RELEASE_WITHOUT_MATCHING_PAYOUT")
    if(o.paymentStatus!=="released"&&payouts.length)issues.push("PAYOUT_WITHOUT_RELEASE_STATE")
    if(o.paymentStatus==="refund_pending"&&! ["refund_pending","disputed"].includes(group.status))issues.push("REFUND_STATE_MISMATCH")
  }
  const refunds=outgoing.filter(t=>t.direction==="buyer_refund")
  if(group.status==="refunded"&&(refunds.length!==1||cents(refunds[0]?.amount)!==cents(group.amount)))issues.push("REFUND_WITHOUT_MATCHING_RECORD")
  if(group.status!=="refunded"&&refunds.length)issues.push("REFUND_RECORD_STATE_MISMATCH")
  return [...new Set(issues)]
}

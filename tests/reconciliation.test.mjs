import test from "node:test"
import assert from "node:assert/strict"
import {checkGroup} from "../lib/reconciliationChecks.mjs"
const oid=x=>({toString:()=>x}) // distinct object instances model MongoDB ObjectIds
const group={_id:oid("group1"),status:"verified",amount:100,orderIds:[oid("order1")]}
const order={_id:oid("order1"),amount:100,sellerAmount:92,paymentStatus:"released"}
const payment={order:oid("order1"),amount:100,status:"verified"}
const transfer={checkoutId:oid("group1"),order:oid("order1"),direction:"seller_payout",amount:92}
test("matches transfer despite distinct ObjectId instances",()=>{
 assert.deepEqual(checkGroup({group,orders:[order],payments:[payment],transfers:[transfer]}),[])
})
test("detects missing payout",()=>{
 assert.ok(checkGroup({group,orders:[order],payments:[payment],transfers:[]}).includes("RELEASE_WITHOUT_MATCHING_PAYOUT"))
})
test("detects amount mismatch",()=>{
 assert.ok(checkGroup({group,orders:[{...order,amount:90}],payments:[payment],transfers:[transfer]}).includes("GROUP_AMOUNT_MISMATCH"))
})
test("detects refund without evidence",()=>{
 assert.ok(checkGroup({group:{...group,status:"refunded"},orders:[order],payments:[payment],transfers:[transfer]}).includes("REFUND_WITHOUT_MATCHING_RECORD"))
})
test("detects duplicate verified payments",()=>{
 assert.ok(checkGroup({group,orders:[order],payments:[payment,payment],transfers:[transfer]}).includes("DUPLICATE_VERIFIED_PAYMENT"))
})

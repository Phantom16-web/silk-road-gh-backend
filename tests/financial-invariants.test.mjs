import test from 'node:test'
import assert from 'node:assert/strict'
import { checkGroup } from '../lib/reconciliationChecks.mjs'
const oid = value => ({toString:()=>value})
const order = (id, amount, state='escrow_held') => ({_id:oid(id),amount,sellerAmount:amount*.92,paymentStatus:state})
const pay = id => ({order:oid(id),amount:50,status:'verified'})
const transfer = (id,amount) => ({checkoutId:oid('G'),order:oid(id),direction:'seller_payout',amount})
const group = (status='verified') => ({_id:oid('G'),orderIds:[oid('A'),oid('B')],amount:100,status})
const issues = (g,orders,payments,transfers) => checkGroup({group:g,orders,payments,transfers})
test('healthy two-seller verified checkout',()=>assert.deepEqual(issues(group(),[order('A',50),order('B',50)],[pay('A'),pay('B')],[]),[]))
test('missing second seller order is detected',()=>assert.ok(issues(group(),[order('A',50)],[pay('A')],[]).includes('MISSING_SELLER_ORDER')))
test('seller order sum must match group',()=>assert.ok(issues(group(),[order('A',50),order('B',49)],[pay('A'),pay('B')],[]).includes('GROUP_AMOUNT_MISMATCH')))
test('missing payment on one seller is detected',()=>assert.ok(issues(group(),[order('A',50),order('B',50)],[pay('A')],[]).includes('MISSING_VERIFIED_PAYMENT')))
test('payout without released state is detected',()=>assert.ok(issues(group(),[order('A',50),order('B',50)],[pay('A'),pay('B')],[transfer('A',46)]).includes('PAYOUT_WITHOUT_RELEASE_STATE')))
test('released seller with correct payout passes',()=>assert.deepEqual(issues(group(),[order('A',50,'released'),order('B',50)],[pay('A'),pay('B')],[transfer('A',46)]),[]))
test('released seller with wrong payout is detected',()=>assert.ok(issues(group(),[order('A',50,'released'),order('B',50)],[pay('A'),pay('B')],[transfer('A',45)]).includes('RELEASE_WITHOUT_MATCHING_PAYOUT')))
test('refund state without group review is detected',()=>assert.ok(issues(group(),[order('A',50,'refund_pending'),order('B',50)],[pay('A'),pay('B')],[]).includes('REFUND_STATE_MISMATCH')))
test('refund transfer before refund status is detected',()=>assert.ok(issues(group(),[order('A',50),order('B',50)],[pay('A'),pay('B')],[{checkoutId:oid('G'),direction:'buyer_refund',amount:100}]).includes('REFUND_RECORD_STATE_MISMATCH')))
test('refunded group requires exact full refund evidence',()=>assert.ok(issues(group('refunded'),[order('A',50),order('B',50)],[pay('A'),pay('B')],[{checkoutId:oid('G'),direction:'buyer_refund',amount:99}]).includes('REFUND_WITHOUT_MATCHING_RECORD')))

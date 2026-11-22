import test from "node:test"
import assert from "node:assert/strict"
import { normalizeGhPhone, momoProvider, maskPhone } from "../services/ghPhone.js"
import { isValidReceiptEmail } from "../models/PaymentSettings.js"

test("Ghana numbers normalise from every common format", () => {
  for (const input of ["024 123 4567", "0241234567", "+233 24 123 4567", "233241234567", "(024) 123-4567"])
    assert.equal(normalizeGhPhone(input).local, "0241234567")
  assert.equal(normalizeGhPhone("12345").ok, false)
  assert.equal(normalizeGhPhone("").ok, false)
})

test("network is guessed from the prefix and mapped to Paystack provider codes", () => {
  assert.equal(momoProvider("0551234567"), "mtn")
  assert.equal(momoProvider("0241234567"), "mtn")
  assert.equal(momoProvider("0201234567"), "vod")
  assert.equal(momoProvider("0501234567"), "vod")
  assert.equal(momoProvider("0271234567"), "atl")
  assert.equal(momoProvider("0571234567"), "atl")
  assert.equal(momoProvider("0991234567"), null)
})

test("phone is masked for display", () => {
  assert.equal(maskPhone("0551234987"), "055 ••• 4987")
})

test("receipt email validation", () => {
  assert.equal(isValidReceiptEmail("pay@silkroad.com"), true)
  assert.equal(isValidReceiptEmail("not an email"), false)
  assert.equal(isValidReceiptEmail(""), false)
  assert.equal(isValidReceiptEmail(undefined), false)
})

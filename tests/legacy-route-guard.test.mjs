import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
const code = readFileSync(new URL("../lib/legacyRouteGuard.js", import.meta.url), "utf8")
// Static boundary checks (do not substitute for MongoDB integration tests).
test("all five legacy route families are covered", () => {
  for (const path of ["/api/orders", "/api/payments", "/api/admin", "/api/deliveries", "/api/testing-payments"]) assert.ok(code.includes(path))
})
test("payment IDs and delivery IDs are resolved to underlying orders", () => {
  assert.match(code, /Payment\.find/); assert.match(code, /Delivery\.find/); assert.match(code, /record\.order/)
})
test("errors block mutation rather than allowing through", () => {
  assert.match(code, /status\(503\)/); assert.match(code, /GROUP_SAFETY_CHECK_UNAVAILABLE/)
})

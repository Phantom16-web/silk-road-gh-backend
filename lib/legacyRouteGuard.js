import mongoose from "mongoose"
import CheckoutGroup from "../models/CheckoutGroup.js"
import Payment from "../models/Payment.js"
import Delivery from "../models/Delivery.js"

const ID = /^[a-f0-9]{24}$/i
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const SCOPES = ["/api/orders", "/api/payments", "/api/admin", "/api/deliveries", "/api/testing-payments"]

export function classifyLegacyMutation(method, url) {
  if (!MUTATIONS.has(method)) return false
  const path = String(url || "").split("?")[0]
  return SCOPES.some(prefix => path === prefix || path.startsWith(prefix + "/"))
}

function gatherIds(value, ids, depth = 0) {
  if (depth > 3 || ids.size > 100 || value == null) return
  if (typeof value === "string") { if (ID.test(value)) ids.add(value.toLowerCase()); return }
  if (Array.isArray(value)) { for (const item of value.slice(0, 100)) gatherIds(item, ids, depth + 1); return }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value).slice(0, 100)) {
      if (/^(?:id|_id|order|orderId|paymentId|deliveryId|orders|payments|deliveries)$/i.test(key)) gatherIds(v, ids, depth + 1)
    }
  }
}

// This guard is a defense-in-depth boundary. It does not replace route-level
// authorization, MongoDB transactions, or reconciliation. Fail closed on errors.
export async function guardLegacyGroupedMutation(req, res, next) {
  if (!classifyLegacyMutation(req.method, req.originalUrl)) return next()
  try {
    const ids = new Set()
    for (const segment of req.originalUrl.split("?")[0].split("/")) gatherIds(segment, ids)
    gatherIds(req.body, ids)
    const candidates = [...ids]
    if (!candidates.length) return next()
    const objectIds = candidates.map(id => new mongoose.Types.ObjectId(id))
    const [payments, deliveries] = await Promise.all([
      Payment.find({ _id: { $in: objectIds } }).select("order").lean(),
      Delivery.find({ _id: { $in: objectIds } }).select("order").lean(),
    ])
    for (const record of [...payments, ...deliveries]) if (record.order) gatherIds(String(record.order), ids)
    const group = await CheckoutGroup.exists({ orderIds: { $in: [...ids].map(id => new mongoose.Types.ObjectId(id)) } })
    if (group) return res.status(409).json({
      code: "GROUP_LEGACY_MUTATION_BLOCKED",
      message: "Grouped orders must use their authenticated checkout-group lifecycle endpoints.",
    })
    return next()
  } catch (error) {
    console.error("Legacy grouped-order safety check failed:", error)
    return res.status(503).json({ code: "GROUP_SAFETY_CHECK_UNAVAILABLE", message: "Financial safety check unavailable. Action blocked." })
  }
}

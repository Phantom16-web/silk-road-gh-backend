import Order from "../models/Order.js"
import { notify } from "./notify.js"

const cedi = n => `GH\u20B5${Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const safe = fn => fn().catch(err => console.error("orderEvents:", err.message))

// Payment verified (real, or auto-approved in Testing Mode): tell every seller and the buyer. Idempotent.
export const notifyOrdersPaid = (orderIds, checkoutId) => safe(async () => {
  const orders = await Order.find({ _id: { $in: orderIds } }).select("seller buyer amount sellerAmount payerName environment listing").populate("listing", "title").lean()
  const test = orders.some(o => o.environment === "testing")
  await Promise.all(orders.map(o => notify(null, {
    recipient: o.seller, type: "new_order", title: "New paid order",
    message: `${o.payerName || "A buyer"} paid ${cedi(o.amount)} for ${o.listing?.title || "an item"}. Deliver it yourself or call a rider.${test ? " (Test order)" : ""}`,
    orderId: o._id, data: { orderId: String(o._id), checkoutId: String(checkoutId || "") }, dedupeKey: `new_order:${o._id}`,
  })))
  const buyer = orders.find(o => o.buyer)?.buyer
  if (buyer) await notify(null, {
    recipient: buyer, type: "payment_received", title: "Payment received",
    message: `Your payment of ${cedi(orders.reduce((s, o) => s + Number(o.amount || 0), 0))} is held safely until you confirm delivery.${test ? " (Test payment, no real money moved.)" : ""}`,
    data: { checkoutId: String(checkoutId || "") }, dedupeKey: `payment_received:${checkoutId}`,
  })
})

// The buyer generated their delivery code: the seller (or rider) should now ask for it at handover.
export const notifyDeliveryCode = orderId => safe(async () => {
  const o = await Order.findById(orderId).select("seller payerName listing").populate("listing", "title").lean()
  if (!o) return
  await notify(null, { recipient: o.seller, type: "delivery_code_generated", title: "Buyer is ready to confirm",
    message: `${o.payerName || "Your buyer"} has their delivery code for ${o.listing?.title || "the order"}. Ask for it at handover.`,
    orderId: o._id, data: { orderId: String(o._id) } })
})

// The code was entered: everyone involved hears about it.
export const notifyDeliveryConfirmed = (orderId, riderId = null) => safe(async () => {
  const o = await Order.findById(orderId).select("seller buyer sellerAmount listing environment").populate("listing", "title").lean()
  if (!o) return
  const title = o.listing?.title || "your order"
  await notify(null, { recipient: o.seller, type: "sale_completed", title: "Delivery confirmed",
    message: `${title} was delivered and confirmed. Your ${cedi(o.sellerAmount)} is being released to you.`,
    orderId: o._id, data: { orderId: String(o._id) }, dedupeKey: `sale_completed:${o._id}` })
  if (o.buyer) await notify(null, { recipient: o.buyer, type: "delivery_completed", title: "Delivery confirmed",
    message: `You confirmed delivery of ${title}. Thank you for shopping on Silk Road.`,
    orderId: o._id, data: { orderId: String(o._id) }, dedupeKey: `delivery_completed:${o._id}` })
  if (riderId) await notify(null, { recipient: riderId, recipientModel: "Rider", type: "delivery_completed", title: "Delivery confirmed",
    message: "The buyer confirmed delivery. Thank you!", orderId: o._id, data: { orderId: String(o._id) }, dedupeKey: `delivery_completed:${o._id}` })
})

export const notifySeller = (sellerId, type, title, message, orderId, dedupeKey) => safe(async () => {
  await notify(null, { recipient: sellerId, type, title, message, orderId, data: orderId ? { orderId: String(orderId) } : {}, dedupeKey })
})

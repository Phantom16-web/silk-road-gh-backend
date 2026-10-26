import express from "express"
import mongoose from "mongoose"
import crypto from "crypto"
import jwt from "jsonwebtoken"
import Listing from "../models/Listing.js"
import Order from "../models/Order.js"
import CheckoutGroup from "../models/CheckoutGroup.js"
import { getEnvironmentMode } from "../models/Environment.js"
import { getPaymentMode } from "../models/PaymentSettings.js"

const router = express.Router()
const money = n => Math.round(n * 100) / 100
const mongoId = x => mongoose.isValidObjectId(x) && String(x).length === 24
function buyerId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    return mongoId(payload.id) ? payload.id : null
  } catch { return null }
}

router.post("/", async (req, res) => {
  const { items, localOrderId, location, landmark, extraInfo, contactInfo,
    payerName, payerPhone, promoCode, deliveryMethod = "pickup" } = req.body || {}
  if (!Array.isArray(items) || items.length < 1 || items.length > 50 ||
      items.some(i => !mongoId(i.listingId) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 100)) {
    return res.status(400).json({ message: "Cart must contain 1–50 valid listings with quantities from 1 to 100." })
  }
  if (!localOrderId || !/^[\w-]{6,90}$/.test(localOrderId)) return res.status(400).json({ message: "Invalid checkout reference." })
  if (!["pickup", "rider"].includes(deliveryMethod)) return res.status(400).json({ message: "Invalid delivery method." })
  if (!payerName?.trim() || !payerPhone?.trim()) return res.status(400).json({ message: "Name and phone are required." })
  if (promoCode) return res.status(409).json({ message: "Promo checkout is temporarily disabled until discounts are validated and allocated on the server. Remove the promo code and retry." })
  const buyer = buyerId(req)
  // Prevent replay even for anonymous buyers using a unique server-issued checkout ID.
  const checkoutId = `SC-${crypto.randomUUID()}`
  try {
    const paymentMode = await getPaymentMode()
    if (paymentMode !== "manual") return res.status(503).json({ message: "The selected payment provider is not available for checkout." })
    const environment = await getEnvironmentMode()
    const uniqueIds = [...new Set(items.map(i => String(i.listingId)))]
    if (uniqueIds.length !== items.length) return res.status(400).json({ message: "Merge duplicate listings in your cart before checkout." })
    const listings = await Listing.find({ _id: { $in: uniqueIds }, status: "Active", type: "product" }).lean()
    if (listings.length !== uniqueIds.length) return res.status(409).json({ message: "A product is no longer available." })
    const byId = new Map(listings.map(l => [String(l._id), l]))
    const lines = items.map(i => {
      const listing = byId.get(String(i.listingId))
      const price = Number(listing.price)
      if (!Number.isFinite(price) || price <= 0 || !mongoId(listing.seller)) throw new Error("Invalid product price or seller.")
      return { listing, quantity: i.quantity, unitPrice: money(price), lineTotal: money(price * i.quantity) }
    })
    const subtotal = money(lines.reduce((s, i) => s + i.lineTotal, 0))
    // No delivery fee charged here: seller-specific delivery charges need their own authoritative quote.
    // The buyer must explicitly see the server-confirmed total before transferring funds.
    if (deliveryMethod === "rider") return res.status(409).json({ message: "Multi-seller rider delivery requires a server-side delivery quote. Choose pickup for now." })
    const total = subtotal
    const paymentReference = `SR-MANUAL-${crypto.randomBytes(9).toString("hex").toUpperCase()}`
    const groupItems = []
    // Transactions require MongoDB replica set (Atlas supports this). No partial groups.
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        for (const line of lines) {
          const amount = line.lineTotal
          const platformFee = money(amount * 0.08)
          const [order] = await Order.create([{
            buyer: buyer || null, seller: line.listing.seller, listing: line.listing._id,
            localOrderId, type: "product", environment, amount,
            platformFee, sellerAmount: money(amount - platformFee),
            discount: 0, paymentMethod: "manual_momo", paymentStatus: "pending",
            fulfillmentStatus: "pending_payment", status: "Pending Confirmation",
            location: location || null, landmark: landmark || null, extraInfo: extraInfo || null,
            contactInfo: contactInfo || null, payerName: payerName.trim(), payerPhone: payerPhone.trim(),
            deliveryMethod,
          }], { session })
          groupItems.push({ orderId: String(order._id), listingId: String(line.listing._id),
            sellerId: String(line.listing.seller), title: line.listing.title,
            quantity: line.quantity, unitPrice: line.unitPrice, amount })
        }
        await CheckoutGroup.create([{
          _id: checkoutId, localOrderId, buyer: buyer || null,
          orderIds: groupItems.map(i => i.orderId), amount: total,
          paymentMethod: "manual_momo", paymentReference, environment,
        }], { session })
      })
    } finally { await session.endSession() }
    return res.status(201).json({ checkoutId, total, subtotal, deliveryFee: 0,
      paymentReference, paymentMethod: "manual_momo", paymentStatus: "pending",
      orders: groupItems, environment,
      message: "Seller orders created. Payment has not been verified. Do not treat this response as payment confirmation." })
  } catch (err) {
    console.error("Multi-item checkout failed:", err)
    return res.status(503).json({ message: "Checkout could not be committed. No payment was verified. Retry only after checking order history." })
  }
})
export default router

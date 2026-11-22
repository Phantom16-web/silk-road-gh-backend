import serviceRequestRoutes from "./routes/serviceRequests.js"
import authSafetyRoutes from "./routes/authSafety.js"
import adminLegacySafety from "./routes/adminLegacySafety.js"
import adminPermissionStudioRoutes from "./routes/adminPermissionStudio.js"
import adminModerationRoutes from "./routes/adminModeration.js"
import payoutRoutes from "./routes/payouts.js"
import payoutRecipientRoutes from "./routes/payoutRecipients.js"
import { startPaystackInboxWorker } from './services/paystackInboxWorker.js'
import { startPaystackTransferInboxWorker } from './services/paystackTransferInboxWorker.js'
import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import dotenv from "dotenv"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import mongoSanitize from "express-mongo-sanitize"
import { createServer } from "http"
import { Server } from "socket.io"
import jwt from "jsonwebtoken"
import sellerNotificationRoutes from "./routes/sellerNotifications.js"
import checkoutPaystackRoutes from "./routes/checkoutPaystack.js"
import paystackWebhookRoutes from "./routes/paystackWebhook.js"
import checkoutPaystackSafety from "./routes/checkoutPaystackSafety.js"
import authRoutes from "./routes/auth.js"
import listingRoutes from "./routes/listings.js"
import searchRoutes from "./routes/search.js"
import { initSearch, analyticsRouter as searchAnalyticsRoutes } from "./services/searchIndex.js"
import orderRoutes from "./routes/orders.js"
import rentalRoutes from "./routes/rentals.js"
import checkoutGroupRoutes from "./routes/checkoutGroups.js"
import checkoutPaymentRoutes from "./routes/checkoutPayments.js"
import groupLifecycleRoutes from "./routes/groupLifecycle.js"
import paymentRoutes from "./routes/payments.js"
import adminRoutes from "./routes/admin.js"
import adminAuthRoutes from "./routes/adminAuth.js"
import settingsRoutes from "./routes/settings.js"
import commissionRoutes from "./routes/commission.js"
import { startCommissionNoticeWorker } from "./services/commissionNoticeWorker.js"
import promoRoutes from "./routes/promos.js"
import riderAuthRoutes from "./routes/riderAuth.js"
import deliveryRoutes from "./routes/deliveries.js"
import { userNotificationRoutes, riderNotificationRoutes } from "./routes/notifications.js"
import { riderRoom, ONLINE_RIDERS_ROOM, ONLINE_TEST_RIDERS_ROOM } from "./services/notify.js"
import environmentRoutes from "./routes/environment.js"
import testingPaymentRoutes from "./routes/testingPayments.js"

dotenv.config()
const app = express()
// Render (and any host) puts a reverse proxy in front of this server. Without this, every visitor
// shares the proxy's IP and the rate limiters below would throttle the WHOLE site as one user.
// Open /api/diagnostics/ip to verify; set TRUST_PROXY on Render if the hop count differs.
const trustProxyEnv = process.env.TRUST_PROXY
app.set("trust proxy", trustProxyEnv === undefined || trustProxyEnv === "" ? 1 : /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv === "false" ? false : trustProxyEnv)
const httpServer = createServer(app)
// Exact origins only. To add a domain (Cloudflare Pages, custom domain) set FRONTEND_ORIGINS on the
// server to a comma-separated list, e.g. https://silk-road-gh.pages.dev,https://silkroadgh.com
const allowedOrigins = [...new Set(["http://localhost:5173", "https://silk-road-gh.vercel.app", ...(process.env.FRONTEND_ORIGINS || "").split(",").map(origin => origin.trim().replace(/\/+$/, "")).filter(Boolean)])]
const io = new Server(httpServer, { cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }, pingTimeout: 60000, pingInterval: 25000 })
const sellerSockets = new Map()
function registerSeller(socket, sellerId) {
  const id = String(socket.data.userId || "")
  if (!id || String(sellerId) !== id) return socket.emit("seller_registration_error", { message: "Not authorized for this seller" })
  if (!sellerSockets.has(id)) sellerSockets.set(id, new Set())
  sellerSockets.get(id).add(socket.id)
  socket.data.sellerId = id
  socket.emit("seller_registered", { sellerId: id, socketId: socket.id })
}
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token
  if (!token) { socket.data.userId = null; return next() }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (!decoded?.id || !mongoose.isValidObjectId(decoded.id)) return next(new Error("Invalid socket token"))
    if (decoded.role === "rider") {
      const rider = await (await import("./models/Rider.js")).default.findById(decoded.id).select("_id isActive isApproved isOnline isTestRider photoReviewStatus").lean()
      if (!rider || !rider.isActive) return next(new Error("Account unavailable"))
      socket.data.userId = null
      socket.data.riderId = String(rider._id)
      socket.data.riderOnline = !!(rider.isOnline && rider.isApproved && rider.photoReviewStatus === "approved")
      socket.data.riderTest = !!rider.isTestRider
      return next()
    }
    const user = await (await import("./models/User.js")).default.findById(decoded.id).select("_id status")
    if (!user || user.status !== "Active") return next(new Error("Account unavailable"))
    socket.data.userId = String(decoded.id)
    next()
  } catch { next(new Error("Invalid socket token")) }
})
io.on("connection", socket => {
  // Keep an authenticated socket in a per-account room so moderation can
  // revoke existing connections, not just block future handshakes.
  if (socket.data.userId) socket.join(`user:${socket.data.userId}`)
  // Riders get their own room, plus the online-riders room that new delivery jobs are sent to.
  if (socket.data.riderId) {
    socket.join(riderRoom(socket.data.riderId))
    if (socket.data.riderOnline) socket.join(socket.data.riderTest ? ONLINE_TEST_RIDERS_ROOM : ONLINE_RIDERS_ROOM)
  }
  // Every incoming authenticated event rechecks current account status.
  // Fail closed if the database is unavailable. No unverified event is handled.
  socket.use(async (_packet, next) => {
    if (socket.data.riderId) {
      try {
        const rider = await (await import("./models/Rider.js")).default.findById(socket.data.riderId).select("isActive").lean()
        if (rider?.isActive) return next()
      } catch {}
      socket.emit("account_access_revoked", { message: "Account access revoked." })
      socket.disconnect(true)
      return next(new Error("Account access revoked"))
    }
    if (!socket.data.userId) return next()
    try {
      const User = (await import("./models/User.js")).default
      const user = await User.findById(socket.data.userId).select("status").lean()
      if (!user || user.status !== "Active") {
        socket.emit("account_access_revoked", { message: "Account access revoked." })
        socket.disconnect(true)
        return next(new Error("Account access revoked"))
      }
      next()
    } catch {
      socket.disconnect(true)
      next(new Error("Account status verification unavailable"))
    }
  })
  socket.on("register_seller", id => registerSeller(socket, id))
  // Riders are identified by their token, not by an id they send. A mismatch is rejected.
  socket.on("register_rider", id => {
    if (!socket.data.riderId || String(id) !== socket.data.riderId)
      return socket.emit("rider_registration_error", { message: "Rider login required for live updates" })
    socket.emit("rider_registered", { riderId: socket.data.riderId, socketId: socket.id })
  })
  socket.on("disconnect", () => {
    const id = socket.data.sellerId
    if (id && sellerSockets.has(id)) {
      sellerSockets.get(id).delete(socket.id)
      if (!sellerSockets.get(id).size) sellerSockets.delete(id)
    }
  })
})
app.set("io", io)
app.set("sellerSockets", sellerSockets)
app.use(helmet())
app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use("/api/paystack/webhook", paystackWebhookRoutes)
app.use(express.json())
app.use(mongoSanitize())
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { message: "Too many requests. Please try again later." } })
app.use("/api/auth", authLimiter)
app.use("/api/rider-auth", authLimiter)
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { message: "Too many requests. Please try again later." }, skip: req => req.path === "/search" || req.path.startsWith("/search/") })
app.use("/api", generalLimiter)
// Search fires on every pause while typing, and a whole campus can share one Wi-Fi IP, so it gets its own roomier limit.
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, message: { message: "Too many searches. Please slow down for a moment." } })
app.use("/api/search", searchLimiter)
app.use("/api/admin-moderation", adminModerationRoutes)
app.use("/api/admin-permissions", adminPermissionStudioRoutes)
app.use("/api/owner/payouts", payoutRoutes)
app.use("/api/payout-recipients", payoutRecipientRoutes)
app.use("/api/environment", environmentRoutes)
app.use("/api/testing-payments", testingPaymentRoutes)
app.use("/api/checkout-paystack", checkoutPaystackRoutes)
app.use("/api/auth", authSafetyRoutes)
app.use("/api/auth", authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/search", searchRoutes)
app.use("/api/search-analytics", searchAnalyticsRoutes)
app.use("/api/service-requests", serviceRequestRoutes)
app.use("/api/orders/checkout", checkoutGroupRoutes)
app.use("/api/checkout-payments", checkoutPaystackSafety)
app.use("/api/checkout-payments", checkoutPaymentRoutes)
app.use("/api/seller-notifications", sellerNotificationRoutes)
app.use("/api/notifications", userNotificationRoutes)
app.use("/api/rider-notifications", riderNotificationRoutes)
app.use("/api/group-lifecycle", groupLifecycleRoutes)
app.use("/api/orders", async (req, res, next) => {
  const match = req.path.match(/^\/([0-9a-f]{24})\/cancel$/i)
  if (req.method !== "PUT" || !match) return next()
  try {
    const CheckoutGroup = (await import("./models/CheckoutGroup.js")).default
    if (await CheckoutGroup.exists({ orderIds: new mongoose.Types.ObjectId(match[1]) }))
      return res.status(409).json({ message: "Grouped orders require group-level cancellation and refund processing.", code: "GROUP_CANCELLATION_REQUIRED" })
    next()
  } catch (err) { console.error("Group cancellation guard failed", err); res.status(503).json({ message: "Cancellation safety check unavailable." }) }
})
app.use("/api/orders", orderRoutes)
app.use("/api/rentals", rentalRoutes)
app.use("/api/payments", async (req, res, next) => {
  const match = req.path.match(/^\/(?:manual|paystack)\/([0-9a-f]{24})(?:\/verify)?$/i)
  if (!match || !["POST", "PUT", "PATCH"].includes(req.method)) return next()
  try {
    const CheckoutGroup = (await import("./models/CheckoutGroup.js")).default
    const group = await CheckoutGroup.exists({ orderIds: new mongoose.Types.ObjectId(match[1]) })
    if (group) return res.status(409).json({ message: "Grouped checkout payments must be verified through the checkout-group payment workflow.", code: "GROUP_PAYMENT_REQUIRED" })
    return next()
  } catch (err) { console.error("Group payment guard failed", err); return res.status(503).json({ message: "Payment safety check unavailable. Retry later." }) }
})
app.use("/api/payments", paymentRoutes)
app.use(["/api/admin", "/api/deliveries"], async (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next()
  try {
    const CheckoutGroup = (await import("./models/CheckoutGroup.js")).default
    const Delivery = (await import("./models/Delivery.js")).default
    const values = [req.params?.id, req.body?.orderId, req.body?.order, req.body?.deliveryId, ...req.path.split("/")].filter(x => typeof x === "string" && /^[a-f0-9]{24}$/i.test(x))
    const orderIds = new Set(values)
    if (req.baseUrl === "/api/deliveries" || req.originalUrl.startsWith("/api/deliveries")) {
      const deliveries = await Delivery.find({ _id: { $in: values } }).select("order").lean()
      for (const delivery of deliveries) if (delivery.order) orderIds.add(String(delivery.order))
    }
    // Only reviewed funded rider transitions bypass the legacy grouped-order lock.
    const riderPath = req.originalUrl.split("?")[0]
    const riderMatch = riderPath.match(/^\/api\/deliveries\/([a-f0-9]{24})\/(accept|picked-up|delivered|cancel-by-rider)$/i)
    if (riderMatch && req.method === "PUT") {
      const RiderFundingChoice = (await import("./models/RiderFundingChoice.js")).default
      const delivery = await Delivery.findById(riderMatch[1]).select("order status rider").lean()
      if (delivery?.order) {
        const funded = await RiderFundingChoice.exists({ order: delivery.order, deliveryId: delivery._id, status: "dispatched" })
        if (funded) return next()
      }
    }
    if (orderIds.size && await CheckoutGroup.exists({ orderIds: { $in: [...orderIds].map(id => new mongoose.Types.ObjectId(id)) } }))
      return res.status(409).json({ code: "GROUP_LIFECYCLE_LOCKED", message: "Grouped order mutation requires the group-specific lifecycle. Legacy settlement, refund and delivery actions are disabled." })
    next()
  } catch (err) { console.error("Group lifecycle guard error", err); res.status(503).json({ message: "Group safety check unavailable; action blocked." }) }
})
app.use("/api/admin", adminLegacySafety)
app.use("/api/admin", adminRoutes)
app.use("/api/admin-auth", adminLegacySafety)
app.use("/api/admin-auth", adminAuthRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/commission", commissionRoutes)
app.use("/api/promos", promoRoutes)
app.use("/api/rider-auth", riderAuthRoutes)
app.use("/api/deliveries", deliveryRoutes)
app.get("/", (req, res) => res.json({ status: "ok", service: "Silk Road GH API", ts: Date.now() }))
// Shows how the server sees YOUR request, to confirm the proxy setting is right (ip should be your own public IP).
app.get("/api/diagnostics/ip", (req, res) => res.json({ ip: req.ip, forwardedFor: req.headers["x-forwarded-for"] || null, trustProxy: app.get("trust proxy") }))
app.use((req, res) => res.status(404).json({ message: "Route not found" }))
const PORT = process.env.PORT || 5000
mongoose.connect(process.env.MONGODB_URI).then(() => {
  console.log("✅ MongoDB Connected")
  startPaystackInboxWorker()
  startPaystackTransferInboxWorker()
  startCommissionNoticeWorker()
  initSearch(app)
  httpServer.listen(PORT, () => console.log(`🚀 Silk Road GH running on port ${PORT} — Socket.io active`))
}).catch(err => { console.error("❌ MongoDB error:", err.message); process.exit(1) })

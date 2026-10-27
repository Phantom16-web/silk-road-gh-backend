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
import paystackSandboxRoutes from "./routes/paystackSandbox.js"
import authRoutes from "./routes/auth.js"
import listingRoutes from "./routes/listings.js"
import orderRoutes from "./routes/orders.js"
import checkoutGroupRoutes from "./routes/checkoutGroups.js"
import checkoutPaymentRoutes from "./routes/checkoutPayments.js"
import groupLifecycleRoutes from "./routes/groupLifecycle.js"
import paymentRoutes from "./routes/payments.js"
import adminRoutes from "./routes/admin.js"
import adminAuthRoutes from "./routes/adminAuth.js"
import settingsRoutes from "./routes/settings.js"
import promoRoutes from "./routes/promos.js"
import riderAuthRoutes from "./routes/riderAuth.js"
import deliveryRoutes from "./routes/deliveries.js"
import environmentRoutes from "./routes/environment.js"
import testingPaymentRoutes from "./routes/testingPayments.js"

dotenv.config()
const app = express()
const httpServer = createServer(app)
const allowedOrigins = ["http://localhost:5173", "https://silk-road-gh.vercel.app", /\.vercel\.app$/]
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
io.use((socket, next) => {
  const token = socket.handshake.auth?.token
  if (!token) { socket.data.userId = null; return next() }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (!decoded?.id || !mongoose.isValidObjectId(decoded.id)) return next(new Error("Invalid socket token"))
    socket.data.userId = String(decoded.id)
    next()
  } catch { next(new Error("Invalid socket token")) }
})
io.on("connection", socket => {
  socket.on("register_seller", id => registerSeller(socket, id))
  socket.on("register_rider", id => socket.emit("rider_registered", { riderId: String(id), socketId: socket.id }))
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
app.use(express.json())
app.use(mongoSanitize())
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { message: "Too many requests. Please try again later." } })
app.use("/api/auth", authLimiter)
app.use("/api/rider-auth", authLimiter)
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { message: "Too many requests. Please try again later." } })
app.use("/api", generalLimiter)
app.use("/api/environment", environmentRoutes)
app.use("/api/testing-payments", testingPaymentRoutes)
app.use("/api/paystack-sandbox", paystackSandboxRoutes)
app.use("/api/auth", authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/orders/checkout", checkoutGroupRoutes)
app.use("/api/checkout-payments", checkoutPaymentRoutes)
app.use("/api/seller-notifications", sellerNotificationRoutes)
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
app.use("/api/admin", adminRoutes)
app.use("/api/admin-auth", adminAuthRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/promos", promoRoutes)
app.use("/api/rider-auth", riderAuthRoutes)
app.use("/api/deliveries", deliveryRoutes)
app.get("/", (req, res) => res.json({ status: "ok", service: "Silk Road GH API", ts: Date.now() }))
app.use((req, res) => res.status(404).json({ message: "Route not found" }))
const PORT = process.env.PORT || 5000
mongoose.connect(process.env.MONGODB_URI).then(() => {
  console.log("✅ MongoDB Connected")
  httpServer.listen(PORT, () => console.log(`🚀 Silk Road GH running on port ${PORT} — Socket.io active`))
}).catch(err => { console.error("❌ MongoDB error:", err.message); process.exit(1) })

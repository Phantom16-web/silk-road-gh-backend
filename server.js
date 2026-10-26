import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import dotenv from "dotenv"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import mongoSanitize from "express-mongo-sanitize"
import { createServer } from "http"
import { Server } from "socket.io"

import authRoutes from "./routes/auth.js"
import listingRoutes from "./routes/listings.js"
import orderRoutes from "./routes/orders.js"
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

const allowedOrigins = [
  "http://localhost:5173",
  "https://silk-road-gh.vercel.app",
  /\.vercel\.app$/,
]

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Preserve the existing Socket.IO registration and offline notifications.
// These events are compatibility mechanisms, not authenticated identity.
const sellerSockets = new Map()
const pendingNotifications = new Map()
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000

export function queueNotification(sellerId, event, data) {
  const id = String(sellerId)
  if (!pendingNotifications.has(id)) pendingNotifications.set(id, [])
  pendingNotifications.get(id).push({ event, data, ts: Date.now() })
  console.log(`📬 Queued "${event}" for seller ${id} (offline)`)
}

function flushPendingNotifications(sellerId, socketId) {
  const id = String(sellerId)
  const queue = pendingNotifications.get(id)
  if (!queue?.length) return
  const now = Date.now()
  const fresh = queue.filter((notification) => now - notification.ts < MAX_QUEUE_AGE_MS)
  for (const notification of fresh) {
    io.to(socketId).emit(notification.event, { ...notification.data, queued: true })
  }
  pendingNotifications.delete(id)
}

function registerSocket(socket, idValue, type) {
  if (!idValue) return
  const id = String(idValue)
  for (const [sid, sockets] of sellerSockets) {
    sockets.delete(socket.id)
    if (!sockets.size) sellerSockets.delete(sid)
  }
  if (!sellerSockets.has(id)) sellerSockets.set(id, new Set())
  sellerSockets.get(id).add(socket.id)
  socket.sellerId = id
  socket.emit(type === "rider" ? "rider_registered" : "seller_registered", {
    [type === "rider" ? "riderId" : "sellerId"]: id,
    socketId: socket.id,
  })
  flushPendingNotifications(id, socket.id)
}

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`)
  socket.on("register_seller", (sellerId) => registerSocket(socket, sellerId, "seller"))
  socket.on("register_rider", (riderId) => registerSocket(socket, riderId, "rider"))
  socket.on("disconnect", (reason) => {
    const id = socket.sellerId
    if (id && sellerSockets.has(id)) {
      sellerSockets.get(id).delete(socket.id)
      if (!sellerSockets.get(id).size) sellerSockets.delete(id)
    }
    console.log(`🔌 Socket ${socket.id} disconnected (${reason})`)
  })
})

app.set("io", io)
app.set("sellerSockets", sellerSockets)
app.set("queueNotification", queueNotification)

app.use(helmet())
app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(express.json())
app.use(mongoSanitize())

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: "Too many requests. Please try again later." },
})
app.use("/api/auth", authLimiter)
app.use("/api/rider-auth", authLimiter)

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { message: "Too many requests. Please try again later." },
})
app.use("/api", generalLimiter)

// Environment controls and simulation are deliberately gated inside their
// route handlers. Do not enable the environment switch until settlement and
// delivery safeguards have been implemented and tested.
app.use("/api/environment", environmentRoutes)
app.use("/api/testing-payments", testingPaymentRoutes)

app.use("/api/auth", authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/orders", orderRoutes)
app.use("/api/payments", paymentRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/admin-auth", adminAuthRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/promos", promoRoutes)
app.use("/api/rider-auth", riderAuthRoutes)
app.use("/api/deliveries", deliveryRoutes)

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Silk Road GH API", ts: Date.now() })
})

app.use((req, res) => res.status(404).json({ message: "Route not found" }))

const PORT = process.env.PORT || 5000
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected")
    httpServer.listen(PORT, () => {
      console.log(`🚀 Silk Road GH running on port ${PORT} — Socket.io active`)
    })
  })
  .catch((err) => {
    console.error("❌ MongoDB error:", err.message)
    process.exit(1)
  })

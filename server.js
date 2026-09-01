import express       from "express"
import mongoose      from "mongoose"
import cors          from "cors"
import dotenv        from "dotenv"
import helmet        from "helmet"
import rateLimit     from "express-rate-limit"
import mongoSanitize from "express-mongo-sanitize"
import { createServer } from "http"
import { Server }    from "socket.io"

import authRoutes      from "./routes/auth.js"
import listingRoutes   from "./routes/listings.js"
import orderRoutes     from "./routes/orders.js"
import adminRoutes     from "./routes/admin.js"
import settingsRoutes  from "./routes/settings.js"
import promoRoutes     from "./routes/promos.js"
import riderAuthRoutes from "./routes/riderAuth.js"
import deliveryRoutes  from "./routes/deliveries.js"

dotenv.config()

const app        = express()
const httpServer = createServer(app)

// ── Socket.io ──────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://silk-road-gh.vercel.app",
      /\.vercel\.app$/,
    ],
    methods:     ["GET", "POST"],
    credentials: true,
  },
  pingTimeout:  60000,
  pingInterval: 25000,
})

// userId → Set<socketId>
const sellerSockets = new Map()

// ── Pending notification queue ─────────────────────────────────────────────────
// If a seller is offline when an order comes in, we queue the notification.
// When they connect and register, we flush the queue to them immediately.
// userId → Array<{ event, data, ts }>
const pendingNotifications = new Map()

const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours — older ones are dropped

export function queueNotification(sellerId, event, data) {
  const id = String(sellerId)
  if (!pendingNotifications.has(id)) pendingNotifications.set(id, [])
  pendingNotifications.get(id).push({ event, data, ts: Date.now() })
  console.log(`📬 Queued "${event}" for seller ${id} (offline)`)
}

function flushPendingNotifications(sellerId, socketId) {
  const id = String(sellerId)
  const queue = pendingNotifications.get(id)
  if (!queue || queue.length === 0) return

  const now = Date.now()
  const fresh = queue.filter(n => now - n.ts < MAX_QUEUE_AGE_MS)

  if (fresh.length > 0) {
    console.log(`📨 Flushing ${fresh.length} queued notification(s) to seller ${id}`)
    fresh.forEach(n => io.to(socketId).emit(n.event, { ...n.data, queued: true }))
  }

  pendingNotifications.delete(id)
}

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`)

  // ── Seller/Buyer registration ──────────────────────────────────────────────
  socket.on("register_seller", (sellerId) => {
    if (!sellerId) return
    const id = String(sellerId)

    // Remove this socket from any previous seller mapping
    sellerSockets.forEach((sockets, sid) => {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id)
        if (sockets.size === 0) sellerSockets.delete(sid)
      }
    })

    if (!sellerSockets.has(id)) sellerSockets.set(id, new Set())
    sellerSockets.get(id).add(socket.id)
    socket.sellerId = id

    const count = sellerSockets.get(id).size
    console.log(`✅ Seller/Buyer ${id} registered — socket ${socket.id} (${count} connection${count !== 1 ? "s" : ""})`)

    socket.emit("seller_registered", { sellerId: id, socketId: socket.id })

    // ── Flush any queued notifications they missed while offline ──────────────
    flushPendingNotifications(id, socket.id)
  })

  // ── Rider registration ─────────────────────────────────────────────────────
  socket.on("register_rider", (riderId) => {
    if (!riderId) return
    const id = String(riderId)

    sellerSockets.forEach((sockets, sid) => {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id)
        if (sockets.size === 0) sellerSockets.delete(sid)
      }
    })

    if (!sellerSockets.has(id)) sellerSockets.set(id, new Set())
    sellerSockets.get(id).add(socket.id)
    socket.sellerId = id

    const count = sellerSockets.get(id).size
    console.log(`✅ Rider ${id} registered — socket ${socket.id} (${count} connection${count !== 1 ? "s" : ""})`)

    socket.emit("rider_registered", { riderId: id, socketId: socket.id })
  })

  socket.on("disconnect", (reason) => {
    const id = socket.sellerId
    if (id && sellerSockets.has(id)) {
      sellerSockets.get(id).delete(socket.id)
      if (sellerSockets.get(id).size === 0) sellerSockets.delete(id)
      console.log(`🔌 ${id} disconnected (${reason})`)
    } else {
      console.log(`🔌 Socket ${socket.id} disconnected (${reason})`)
    }
  })
})

app.set("io", io)
app.set("sellerSockets", sellerSockets)
app.set("queueNotification", queueNotification)

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet())

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://silk-road-gh.vercel.app",
    /\.vercel\.app$/,
  ],
  credentials: true,
}))

app.use(express.json())
app.use(mongoSanitize())

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { message: "Too many requests. Please try again later." },
})
app.use("/api/auth",       authLimiter)
app.use("/api/rider-auth", authLimiter)

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      500,
  message:  { message: "Too many requests. Please try again later." },
})
app.use("/api", generalLimiter)

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/api/auth",       authRoutes)
app.use("/api/listings",   listingRoutes)
app.use("/api/orders",     orderRoutes)
app.use("/api/admin",      adminRoutes)
app.use("/api/settings",   settingsRoutes)
app.use("/api/promos",     promoRoutes)
app.use("/api/rider-auth", riderAuthRoutes)
app.use("/api/deliveries", deliveryRoutes)

app.get("/", (req, res) => res.json({
  status:  "ok",
  service: "Silk Road GH API",
  ts:      Date.now(),
}))

app.use((req, res) => res.status(404).json({ message: "Route not found" }))

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected")
    httpServer.listen(PORT, () =>
      console.log(`🚀 Silk Road GH running on port ${PORT} — Socket.io active`)
    )
  })
  .catch(err => {
    console.error("❌ MongoDB error:", err.message)
    process.exit(1)
  })

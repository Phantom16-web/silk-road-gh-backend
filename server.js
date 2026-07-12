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

// Shared socket map — used by sellers, buyers AND riders
// userId/riderId → Set of socket IDs
const sellerSockets = new Map()

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`)

  // ── Seller/Buyer registration ──────────────────────────────────────────────
  socket.on("register_seller", (sellerId) => {
    if (!sellerId) return
    const id = String(sellerId)

    // Clean up stale mapping for this socket
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
  })

  // ── Rider registration ─────────────────────────────────────────────────────
  // Riders use the same map so we can push delivery jobs to them
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

// Attach to app so routes can use them
app.set("io", io)
app.set("sellerSockets", sellerSockets)

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

// Auth rate limit — 100 req per 15 mins per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { message: "Too many requests. Please try again later." },
})
app.use("/api/auth",       authLimiter)
app.use("/api/rider-auth", authLimiter)

// General rate limit — 500 req per 15 mins per IP
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

// Health check — also set this as Health Check Path in Render dashboard
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

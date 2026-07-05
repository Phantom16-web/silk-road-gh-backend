import express       from "express"
import mongoose      from "mongoose"
import cors          from "cors"
import dotenv        from "dotenv"
import helmet        from "helmet"
import rateLimit     from "express-rate-limit"
import mongoSanitize from "express-mongo-sanitize"
import { createServer } from "http"
import { Server }    from "socket.io"

import authRoutes     from "./routes/auth.js"
import listingRoutes  from "./routes/listings.js"
import orderRoutes    from "./routes/orders.js"
import riderRoutes    from "./routes/riders.js"
import adminRoutes    from "./routes/admin.js"
import settingsRoutes from "./routes/settings.js"
import promoRoutes    from "./routes/promos.js"

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
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout:  60000,
  pingInterval: 25000,
})

// sellerId → Set of socket IDs
// Every device the seller has open gets its own socket ID stored here.
// When an order comes in, we emit to ALL of them simultaneously.
const sellerSockets = new Map()

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`)

  socket.on("register_seller", (sellerId) => {
    if (!sellerId) return
    const id = String(sellerId)

    // Clean up any stale mapping for this socket first
    // (handles re-registration after Render wakeup or network switch)
    sellerSockets.forEach((sockets, sid) => {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id)
        if (sockets.size === 0) sellerSockets.delete(sid)
      }
    })

    // Register under the correct seller ID
    if (!sellerSockets.has(id)) sellerSockets.set(id, new Set())
    sellerSockets.get(id).add(socket.id)
    socket.sellerId = id

    const count = sellerSockets.get(id).size
    console.log(`✅ Seller ${id} registered — socket ${socket.id} (${count} active connection${count !== 1 ? "s" : ""})`)

    // Confirm back to client so it knows registration succeeded
    socket.emit("seller_registered", { sellerId: id, socketId: socket.id })
  })

  socket.on("disconnect", (reason) => {
    const id = socket.sellerId
    if (id && sellerSockets.has(id)) {
      sellerSockets.get(id).delete(socket.id)
      if (sellerSockets.get(id).size === 0) sellerSockets.delete(id)
      console.log(`🔌 Seller ${id} socket ${socket.id} disconnected (${reason})`)
    } else {
      console.log(`🔌 Socket ${socket.id} disconnected (${reason}) — no seller`)
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

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { message: "Too many requests. Try again later." } })
app.use("/api/auth", authLimiter)

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 })
app.use("/api", generalLimiter)

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/api/auth",     authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/orders",   orderRoutes)
app.use("/api/riders",   riderRoutes)
app.use("/api/admin",    adminRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/promos",   promoRoutes)

// Health check — Render pings this to keep the server awake
// Also set this as your Health Check Path in Render dashboard
app.get("/", (req, res) => res.json({ status: "ok", service: "Silk Road GH API", ts: Date.now() }))

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
    console.error("❌ MongoDB connection error:", err.message)
    process.exit(1)
  })

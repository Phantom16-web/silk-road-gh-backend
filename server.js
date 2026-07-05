import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import dotenv from "dotenv"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import mongoSanitize from "express-mongo-sanitize"
import { createServer } from "http"
import { Server } from "socket.io"

import authRoutes     from "./routes/auth.js"
import listingRoutes  from "./routes/listings.js"
import orderRoutes    from "./routes/orders.js"
import riderRoutes    from "./routes/riders.js"
import adminRoutes    from "./routes/admin.js"
import settingsRoutes from "./routes/settings.js"
import promoRoutes    from "./routes/promos.js"

dotenv.config()

const app    = express()
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
  // Render free tier sleeps — reconnection handles wakeup
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Map sellerId -> Set of socket IDs
// When a seller logs in from any device/tab, their socket is stored here.
// When an order is placed, we emit to ALL their connected sockets.
const sellerSockets = new Map()

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`)

  // Seller registers their userId when they log in
  socket.on("register_seller", (sellerId) => {
    if (!sellerId) return
    const id = String(sellerId)
    if (!sellerSockets.has(id)) sellerSockets.set(id, new Set())
    sellerSockets.get(id).add(socket.id)
    socket.sellerId = id
    console.log(`✅ Seller ${id} registered (${sellerSockets.get(id).size} connections)`)
  })

  socket.on("disconnect", () => {
    const id = socket.sellerId
    if (id && sellerSockets.has(id)) {
      sellerSockets.get(id).delete(socket.id)
      if (sellerSockets.get(id).size === 0) sellerSockets.delete(id)
    }
    console.log(`🔌 Socket disconnected: ${socket.id}`)
  })
})

// Attach io to app so routes can use it
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: "Too many requests. Please try again later." },
})
app.use("/api/auth", authLimiter)

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
})
app.use("/api", generalLimiter)

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/api/auth",     authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/orders",   orderRoutes)
app.use("/api/riders",   riderRoutes)
app.use("/api/admin",    adminRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/promos",   promoRoutes)

app.get("/", (req, res) => res.send("🕸 Silk Road GH API is running"))

app.use((req, res) => res.status(404).json({ message: "Route not found" }))

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected")
    httpServer.listen(PORT, () =>
      console.log(`🚀 Silk Road GH Server + Socket.io running on port ${PORT}`)
    )
  })
  .catch(err => console.error("❌ MongoDB error:", err.message))

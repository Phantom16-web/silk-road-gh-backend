import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import dotenv from "dotenv"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import mongoSanitize from "express-mongo-sanitize"

import authRoutes from "./routes/auth.js"
import listingRoutes from "./routes/listings.js"
import orderRoutes from "./routes/orders.js"
import riderRoutes from "./routes/riders.js"
import paymentRoutes from "./routes/payments.js"
import adminRoutes from "./routes/admin.js"
import promoRoutes from "./routes/promos.js"


dotenv.config()

const app = express()

// Security headers
app.use(helmet())

// CORS
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://silk-road-gh.vercel.app",
    /\.vercel\.app$/,
  ],
  credentials: true,
}))

app.use(express.json())

// Sanitize against NoSQL injection
app.use(mongoSanitize())

// Rate limit auth routes — 100 requests per 15 mins per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: "Too many requests. Please try again later." },
})
app.use("/api/auth", authLimiter)

// General rate limit — 300 requests per 15 mins per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { message: "Too many requests. Please try again later." },
})
app.use("/api", generalLimiter)

// Routes
app.use("/api/auth", authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/orders", orderRoutes)
app.use("/api/riders", riderRoutes)
app.use("/api/payments", paymentRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/promos", promoRoutes)


app.get("/", (req, res) => {
  res.send("🕸 Silk Road GH API is running")
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" })
})

const PORT = process.env.PORT || 5000

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected")
    app.listen(PORT, () => console.log(`🚀 Silk Road GH Server running on port ${PORT}`))
  })
  .catch(err => console.error("❌ MongoDB connection error:", err.message))

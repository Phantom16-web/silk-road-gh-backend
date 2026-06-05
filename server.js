import express from "express"
import dotenv from "dotenv"
import cors from "cors"
import connectDB from "./config/db.js"
import authRoutes from "./routes/auth.js"
import listingRoutes from "./routes/listings.js"
import orderRoutes from "./routes/orders.js"
import riderRoutes from "./routes/riders.js"
import paymentRoutes from "./routes/payments.js"

dotenv.config()
connectDB()

const app = express()

app.use(cors({
  origin: ["http://localhost:5173", "https://silk-road.vercel.app", "https://silk-road-gh.vercel.app"],
  credentials: true,
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Routes
app.use("/api/auth", authRoutes)
app.use("/api/listings", listingRoutes)
app.use("/api/orders", orderRoutes)
app.use("/api/riders", riderRoutes)
app.use("/api/payments", paymentRoutes)

// Health check
app.get("/", (req, res) => {
  res.json({ message: "🕸 Silk Road GH API is running" })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" })
})

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ message: "Something went wrong on our end." })
})

const PORT = process.env.PORT || 5000
app.listen(PORT, () => {
  console.log(`🚀 Silk Road GH Server running on port ${PORT}`)
})
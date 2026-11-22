import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import Rider from "../models/Rider.js"

// Rider equivalent of middleware/auth.js. Sets req.rider = { id }.
const protectRider = async (req, res, next) => {
  const header = req.headers.authorization || ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : null
  if (!token) return res.status(401).json({ message: "Not authorized" })
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (decoded?.role !== "rider" || !mongoose.isValidObjectId(decoded.id))
      return res.status(401).json({ message: "Invalid token" })
    const rider = await Rider.findById(decoded.id).select("_id isActive").lean()
    if (!rider || !rider.isActive) return res.status(403).json({ message: "Rider unavailable." })
    req.rider = { id: String(rider._id) }
    next()
  } catch (error) {
    if (["TokenExpiredError", "JsonWebTokenError", "NotBeforeError"].includes(error.name))
      return res.status(401).json({ message: "Invalid or expired token" })
    console.error("Rider authentication check failed:", error)
    return res.status(503).json({ message: "Authentication temporarily unavailable." })
  }
}
export default protectRider

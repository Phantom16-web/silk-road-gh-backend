import express from "express"
import jwt     from "jsonwebtoken"
import Rider   from "../models/Rider.js"

const router = express.Router()

const generateToken = (id) =>
  jwt.sign({ id, role: "rider" }, process.env.JWT_SECRET, { expiresIn: "30d" })

function getRiderId(req) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return null
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET)
    return decoded.id || null
  } catch { return null }
}

// @route POST /api/rider-auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, phone, email, password, university, vehicle } = req.body
    if (!name || !phone || !email || !password)
      return res.status(400).json({ message: "Name, phone, email and password are required." })
    if (password.length < 6)
      return res.status(400).json({ message: "Password must be at least 6 characters." })
    if (await Rider.findOne({ email: email.toLowerCase() }))
      return res.status(400).json({ message: "An account with this email already exists." })
    if (await Rider.findOne({ phone }))
      return res.status(400).json({ message: "An account with this phone number already exists." })

    const rider = await Rider.create({
      name: name.trim(), phone: phone.trim(),
      email: email.toLowerCase().trim(), password,
      university: university || "", vehicle: vehicle || "motorbike",
      isOnline: false, isApproved: true,
    })

    res.status(201).json({
      _id: rider._id, name: rider.name, phone: rider.phone,
      email: rider.email, university: rider.university,
      vehicle: rider.vehicle, isOnline: rider.isOnline,
      totalEarned: rider.totalEarned, totalDeliveries: rider.totalDeliveries,
      token: generateToken(rider._id),
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/rider-auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required." })
    const rider = await Rider.findOne({ email: email.toLowerCase() })
    if (!rider)
      return res.status(401).json({ message: "No rider account found with this email." })
    if (!rider.isActive)
      return res.status(403).json({ message: "Your rider account has been deactivated." })
    if (!await rider.matchPassword(password))
      return res.status(401).json({ message: "Incorrect password." })

    res.json({
      _id: rider._id, name: rider.name, phone: rider.phone,
      email: rider.email, university: rider.university,
      vehicle: rider.vehicle, isOnline: rider.isOnline,
      totalEarned: rider.totalEarned, totalDeliveries: rider.totalDeliveries,
      rating: rider.rating, token: generateToken(rider._id),
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/rider-auth/me
router.get("/me", async (req, res) => {
  try {
    const id = getRiderId(req)
    if (!id) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(id).select("-password")
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    res.json(rider)
  } catch (err) {
    res.status(401).json({ message: "Token invalid or expired." })
  }
})

// @route PUT /api/rider-auth/toggle-online
router.put("/toggle-online", async (req, res) => {
  try {
    const id = getRiderId(req)
    if (!id) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(id)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    rider.isOnline = !rider.isOnline
    await rider.save()
    res.json({ isOnline: rider.isOnline })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/rider-auth/location
router.put("/location", async (req, res) => {
  try {
    const id = getRiderId(req)
    if (!id) return res.status(401).json({ message: "Not authorized." })
    const { lat, lng } = req.body
    await Rider.findByIdAndUpdate(id, {
      currentLocation: { lat, lng, updatedAt: new Date() }
    })
    res.json({ message: "Location updated." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route DELETE /api/rider-auth/delete-account
// Rider deletes their own account
router.delete("/delete-account", async (req, res) => {
  try {
    const id = getRiderId(req)
    if (!id) return res.status(401).json({ message: "Not authorized." })
    const rider = await Rider.findById(id)
    if (!rider) return res.status(404).json({ message: "Rider not found." })
    await rider.deleteOne()
    res.json({ message: "Rider account deleted successfully." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

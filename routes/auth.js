import express from "express"
import jwt from "jsonwebtoken"
import User from "../models/User.js"
import protect from "../middleware/auth.js"

const router = express.Router()

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" })

// @route POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, university, phone } = req.body
    const exists = await User.findOne({ email })
    if (exists) return res.status(400).json({ message: "Email already registered." })
    const user = await User.create({ name, email, password, university, phone })
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      university: user.university,
      phone: user.phone,
      role: user.role,
      token: generateToken(user._id),
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await User.findOne({ email })
    if (!user) return res.status(400).json({ message: "Invalid email or password." })
    if (user.status === "Suspended") return res.status(403).json({ message: "Your account has been suspended." })
    const match = await user.matchPassword(password)
    if (!match) return res.status(400).json({ message: "Invalid email or password." })
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      university: user.university,
      phone: user.phone,
      role: user.role,
      token: generateToken(user._id),
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/auth/me
router.get("/me", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1]
    if (!token) return res.status(401).json({ message: "Not authorized" })
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.id).select("-password")
    if (!user) return res.status(404).json({ message: "User not found" })
    res.json(user)
  } catch (err) {
    res.status(401).json({ message: "Invalid token" })
  }
})

// @route PUT /api/auth/update
router.put("/update", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ message: "User not found" })
    const { name, university, phone } = req.body
    if (name) user.name = name
    if (university) user.university = university
    if (phone) user.phone = phone
    await user.save()
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      university: user.university,
      phone: user.phone,
      role: user.role,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/auth/change-password
router.put("/change-password", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ message: "User not found" })
    const { newPassword } = req.body
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." })
    user.password = newPassword
    await user.save()
    res.json({ message: "Password updated successfully." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route DELETE /api/auth/delete
router.delete("/delete", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ message: "User not found" })
    await user.deleteOne()
    res.json({ message: "Account deleted successfully." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router
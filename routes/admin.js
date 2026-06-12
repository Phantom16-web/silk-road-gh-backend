import express from "express"
import jwt from "jsonwebtoken"
import User from "../models/User.js"

const router = express.Router()

const OWNER_KEY = process.env.OWNER_KEY
const MASTER_KEY = process.env.MASTER_KEY

const ROLE_PERMISSIONS = {
  support:    ["handle_complaints"],
  admin:      ["manage_listings", "manage_users", "manage_orders", "manage_riders", "handle_complaints"],
  superadmin: ["manage_listings", "manage_users", "manage_orders", "manage_riders", "view_revenue", "manage_promos", "handle_complaints"],
  owner:      ["manage_listings", "manage_users", "manage_orders", "manage_riders", "view_revenue", "manage_promos", "handle_complaints"],
}

// @route POST /api/admin/login
// Verifies admin key or admin email and returns a short-lived admin token
router.post("/login", async (req, res) => {
  try {
    const { key } = req.body
    if (!key) return res.status(400).json({ message: "Key required" })

    // Owner key
    if (OWNER_KEY && key === OWNER_KEY) {
      const token = jwt.sign({ role: "owner" }, process.env.JWT_SECRET, { expiresIn: "12h" })
      return res.json({ role: "owner", permissions: ROLE_PERMISSIONS.owner, token })
    }

    // Master key
    if (MASTER_KEY && key === MASTER_KEY) {
      const token = jwt.sign({ role: "superadmin" }, process.env.JWT_SECRET, { expiresIn: "12h" })
      return res.json({ role: "superadmin", permissions: ROLE_PERMISSIONS.superadmin, token })
    }

    // Email-based admin login (must already have admin role in DB)
    const user = await User.findOne({ email: key })
    if (user && ["support", "admin", "superadmin", "owner"].includes(user.role)) {
      const token = jwt.sign({ role: user.role, id: user._id }, process.env.JWT_SECRET, { expiresIn: "12h" })
      return res.json({ role: user.role, permissions: ROLE_PERMISSIONS[user.role] || [], token })
    }

    return res.status(401).json({ message: "Invalid credentials. Access denied." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/admin/verify-master
// Used for the Admin Management tab — verifies master/owner key for non-owners
router.post("/verify-master", async (req, res) => {
  try {
    const { key } = req.body
    if ((MASTER_KEY && key === MASTER_KEY) || (OWNER_KEY && key === OWNER_KEY)) {
      return res.json({ valid: true })
    }
    return res.json({ valid: false })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

import express from "express"
import jwt from "jsonwebtoken"

const router = express.Router()

// In-memory settings store — survives until server restart
// For full persistence this would move to a MongoDB Settings collection
let SITE_SETTINGS = {
  contactPhone:    "054 388 3608",
  contactWhatsApp: "233543883608",
  aboutText:       "Silk Road GH is Ghana's premier student marketplace — built by students, for students. Whether you're buying textbooks, renting equipment, requesting services, or making extra income, Silk Road GH is your go-to campus platform.",
  privacyText:     "We collect your name, contact information, location data (only during checkout), and transaction history to facilitate buying, selling, and delivery on the platform.",
  footerTagline:   "Ghana's student marketplace. Buy, sell, rent, and request services — all secured by escrow and powered by MTN MoMo.",
  deliveryFee:     10,
  paymentMode:     "manual", // "manual" or "automated"
}

const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ message: "No token provided." })
  const token = authHeader.split(" ")[1]
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (!["owner", "superadmin"].includes(decoded.role)) {
      return res.status(403).json({ message: "Only owner or superadmin can change payment mode." })
    }
    req.adminRole = decoded.role
    next()
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." })
  }
}

// @route GET /api/settings — public, anyone can read site settings
router.get("/", (req, res) => {
  res.json(SITE_SETTINGS)
})

// @route PUT /api/settings — owner/superadmin only
router.put("/", verifyAdminToken, (req, res) => {
  try {
    const allowedFields = ["contactPhone", "contactWhatsApp", "aboutText", "privacyText", "footerTagline", "deliveryFee", "paymentMode"]
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) SITE_SETTINGS[field] = req.body[field]
    }
    res.json(SITE_SETTINGS)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/settings/payment-mode — owner/superadmin only, dedicated toggle endpoint
router.put("/payment-mode", verifyAdminToken, (req, res) => {
  try {
    const { mode } = req.body
    if (!["manual", "automated"].includes(mode)) {
      return res.status(400).json({ message: "Mode must be 'manual' or 'automated'." })
    }
    SITE_SETTINGS.paymentMode = mode
    res.json({ paymentMode: SITE_SETTINGS.paymentMode, message: `Payment mode switched to ${mode}.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

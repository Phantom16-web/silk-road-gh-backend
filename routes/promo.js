import express from "express"

const router = express.Router()

// In-memory promo store — in production this would be a MongoDB collection
// For now it mirrors what the AdminPanel creates
const PROMOS = [
  { code: "WELCOME10", type: "percentage", value: 10, target: "all", active: true, uses: 0 },
  { code: "KNUST20",   type: "percentage", value: 20, target: "university", uni: "KNUST", active: true, uses: 0 },
  { code: "FREESHIP",  type: "free_delivery", value: 0, target: "all", active: true, uses: 0 },
]

// @route POST /api/promos/validate
router.post("/validate", (req, res) => {
  try {
    const { code } = req.body
    if (!code) return res.status(400).json({ valid: false, message: "Code required." })

    const promo = PROMOS.find(p => p.code === code.toUpperCase().trim() && p.active)

    if (!promo) return res.json({ valid: false, message: "Invalid or expired promo code." })

    return res.json({ valid: true, promo })
  } catch (err) {
    res.status(500).json({ valid: false, message: err.message })
  }
})

// @route GET /api/promos (admin use)
router.get("/", (req, res) => {
  res.json(PROMOS)
})

export default router

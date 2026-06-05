import express from "express"
import Rider from "../models/Rider.js"
import protect from "../middleware/auth.js"
import upload from "../middleware/upload.js"

const router = express.Router()

// @route POST /api/riders
router.post("/", upload.single("photo"), async (req, res) => {
  try {
    const { name, phone, baseArea, vehicle, zones, availFrom, availTo } = req.body
    const rider = await Rider.create({
      name,
      phone,
      baseArea,
      vehicle,
      zones: JSON.parse(zones),
      availFrom,
      availTo,
      photo: req.file?.path || null,
      status: "Active",
    })
    res.status(201).json(rider)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/riders
router.get("/", async (req, res) => {
  try {
    const riders = await Rider.find().sort({ createdAt: -1 })
    res.json(riders)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/riders/:id/status
router.put("/:id/status", protect, async (req, res) => {
  try {
    const rider = await Rider.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    )
    res.json(rider)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router
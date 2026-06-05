import express from "express"
import Listing from "../models/Listing.js"
import protect from "../middleware/auth.js"
import upload from "../middleware/upload.js"

const router = express.Router()

// @route GET /api/listings
router.get("/", async (req, res) => {
  try {
    const { type, category, status } = req.query
    const filter = { status: status || "Active" }
    if (type) filter.type = type
    if (category) filter.category = category
    const listings = await Listing.find(filter)
      .populate("seller", "name university")
      .sort({ createdAt: -1 })
    res.json(listings)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/listings/:id
router.get("/:id", async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id).populate("seller", "name university phone")
    if (!listing) return res.status(404).json({ message: "Listing not found" })
    res.json(listing)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route POST /api/listings
router.post("/", protect, upload.single("image"), async (req, res) => {
  try {
    const data = JSON.parse(req.body.data)
    const listing = await Listing.create({
      ...data,
      seller: req.user.id,
      image: req.file.path,
      imagePublicId: req.file.filename,
    })
    res.status(201).json(listing)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/listings/:id
router.put("/:id", protect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found" })
    if (listing.seller.toString() !== req.user.id) return res.status(403).json({ message: "Not authorized" })
    const updated = await Listing.findByIdAndUpdate(req.params.id, req.body, { new: true })
    res.json(updated)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route DELETE /api/listings/:id
router.delete("/:id", protect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found" })
    if (listing.seller.toString() !== req.user.id) return res.status(403).json({ message: "Not authorized" })
    await listing.deleteOne()
    res.json({ message: "Listing removed" })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router
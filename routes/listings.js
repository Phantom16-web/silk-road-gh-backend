import express from "express"
import Listing from "../models/Listing.js"
import protect from "../middleware/auth.js"
import upload from "../middleware/upload.js"

const router = express.Router()

// @route GET /api/listings — public marketplace (ALL active listings, paginated)
router.get("/", async (req, res) => {
  try {
    const { type, category, status, page = 1, limit = 16, search, seller } = req.query
    const filter = { status: status || "Active" }
    if (type) filter.type = type
    if (category) filter.category = category
    if (seller) filter.seller = seller
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { desc: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ]
    }
    const skip = (Number(page) - 1) * Number(limit)
    const listings = await Listing.find(filter)
      .populate("seller", "name university phone")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
    res.json(listings)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route GET /api/listings/my — ONLY this seller's listings (private)
router.get("/my", protect, async (req, res) => {
  try {
    const listings = await Listing.find({ seller: req.user.id }).sort({ createdAt: -1 })
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

// @route POST /api/listings — create listing (seller only)
router.post("/", protect, upload.single("image"), async (req, res) => {
  try {
    const data = JSON.parse(req.body.data)
    const listing = await Listing.create({
      ...data,
      seller: req.user.id,
      image: req.file?.path || "",
      imagePublicId: req.file?.filename || "",
    })
    const populated = await listing.populate("seller", "name university")
    res.status(201).json(populated)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route PUT /api/listings/:id — edit (owner only, protected fields)
router.put("/:id", protect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found" })
    if (listing.seller.toString() !== req.user.id)
      return res.status(403).json({ message: "Not authorized" })

    const allowed = ["title", "desc", "category"]
    if (listing.type === "rent") allowed.push("dailyRate", "maxDays")
    if (listing.type === "product") allowed.push("price", "condition")
    if (listing.type === "service") allowed.push("price", "contactDetail", "contactNote")
    const incoming = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}
    const fields = Object.keys(incoming)
    if (!fields.length) return res.status(400).json({ message: "No changes supplied" })
    const disallowed = fields.filter(key => !allowed.includes(key))
    if (disallowed.length) return res.status(400).json({ message: "Fields cannot be edited: " + disallowed.join(", ") })

    for (const key of fields) {
      const value = incoming[key]
      if (["title", "desc", "category"].includes(key)) {
        if (typeof value !== "string" || !value.trim())
          return res.status(400).json({ message: key + " is required" })
        listing[key] = value.trim()
      } else if (["price", "dailyRate", "maxDays"].includes(key)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (key === "maxDays" && !Number.isInteger(value)))
          return res.status(400).json({ message: key + " must be a positive number" })
        listing[key] = value
      } else {
        if (typeof value !== "string")
          return res.status(400).json({ message: key + " must be text" })
        listing[key] = value
      }
    }
    const updated = await listing.save()
    res.json(updated)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// @route DELETE /api/listings/:id — delete (owner only)
router.delete("/:id", protect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found" })
    if (listing.seller.toString() !== req.user.id)
      return res.status(403).json({ message: "Not authorized" })
    await listing.deleteOne()
    res.json({ message: "Listing removed" })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

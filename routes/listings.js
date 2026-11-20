import express from "express"
import mongoose from "mongoose"
import Listing from "../models/Listing.js"
import User from "../models/User.js"
import protect from "../middleware/auth.js"
import upload from "../middleware/upload.js"
import cloudinary from "../config/cloudinary.js"
import { universityKey } from "../utils/university.js"

const router = express.Router()

const TYPES = new Set(["product", "rent", "service"])
// Never sent on public endpoints: a provider's contact details would let buyers bypass
// the platform (and its commission), and the Cloudinary id is internal.
const PRIVATE_FIELDS = "-contactMethod -contactDetail -contactNote -imagePublicId"
const PUBLIC_SELLER_FIELDS = "name university"

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const clampInt = (value, fallback, min, max) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}
const isPositiveNumber = value => typeof value === "number" && Number.isFinite(value) && value > 0
const isText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
const destroyImage = async publicId => {
  if (!publicId) return
  try { await cloudinary.uploader.destroy(publicId) } catch (err) { console.error("Cloudinary cleanup failed:", err.message) }
}

// Fields a client may set when creating a listing. Everything else (status, rating,
// reviews, seller, universityKey, image ids) is decided by the server, never the client.
const COMMON_FIELDS = ["type", "title", "desc", "category"]
const TYPE_FIELDS = {
  product: ["price", "condition", "delivery"],
  rent: ["dailyRate", "maxDays", "condition", "accountability", "accountabilityPct"],
  service: ["price", "serviceDelivery", "liveSession", "contactMethod", "contactDetail", "contactNote"],
}

// Returns { clean } or { error }.
function validateNewListing(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "Invalid listing data" }
  if (!TYPES.has(data.type)) return { error: "Invalid listing type" }
  const clean = {}
  for (const key of [...COMMON_FIELDS, ...TYPE_FIELDS[data.type]]) if (data[key] !== undefined) clean[key] = data[key]

  if (!isText(clean.title, 120)) return { error: "Title is required (max 120 characters)" }
  if (!isText(clean.desc, 3000)) return { error: "Description is required (max 3000 characters)" }
  if (!isText(clean.category, 80)) return { error: "Category is required" }
  clean.title = clean.title.trim(); clean.desc = clean.desc.trim(); clean.category = clean.category.trim()

  if (clean.condition !== undefined) {
    if (typeof clean.condition !== "string" || clean.condition.length > 40) return { error: "Invalid condition" }
    clean.condition = clean.condition.trim()
  }
  if (data.type === "product") {
    if (!isPositiveNumber(clean.price)) return { error: "Price must be a positive number" }
    if (clean.delivery !== undefined) {
      const list = typeof clean.delivery === "string" ? [clean.delivery] : clean.delivery
      if (!Array.isArray(list) || list.length > 8 || list.some(d => typeof d !== "string" || !d.trim() || d.length > 40)) return { error: "Invalid delivery options" }
      clean.delivery = list.map(d => d.trim())
    }
  }
  if (data.type === "rent") {
    if (!isPositiveNumber(clean.dailyRate)) return { error: "Daily rate must be a positive number" }
    if (!isPositiveNumber(clean.maxDays) || !Number.isInteger(clean.maxDays) || clean.maxDays > 365) return { error: "Maximum days must be a whole number up to 365" }
    clean.accountability = clean.accountability === true
    if (clean.accountability) {
      if (typeof clean.accountabilityPct !== "number" || !Number.isFinite(clean.accountabilityPct) || clean.accountabilityPct < 0 || clean.accountabilityPct > 1000) return { error: "Invalid accountability value" }
    } else clean.accountabilityPct = 0
  }
  if (data.type === "service") {
    if (!isPositiveNumber(clean.price)) return { error: "Price must be a positive number" }
    if (!["online", "in-person"].includes(clean.serviceDelivery)) return { error: "Service delivery must be online or in-person" }
    clean.liveSession = clean.liveSession === true
    if (!isText(clean.contactMethod, 40)) return { error: "Contact method is required" }
    if (!isText(clean.contactDetail, 200)) return { error: "Contact detail is required" }
    clean.contactMethod = clean.contactMethod.trim(); clean.contactDetail = clean.contactDetail.trim()
    if (clean.contactNote !== undefined) {
      if (typeof clean.contactNote !== "string" || clean.contactNote.length > 300) return { error: "Contact note is too long" }
      clean.contactNote = clean.contactNote.trim()
    }
  }
  return { clean }
}

// @route GET /api/listings — public marketplace (ACTIVE listings only, paginated)
router.get("/", async (req, res) => {
  try {
    const { type, category, search, seller } = req.query
    const filter = { status: "Active" } // the public API never serves Flagged or Removed listings
    if (type !== undefined && type !== "") {
      if (!TYPES.has(String(type))) return res.status(400).json({ message: "Invalid listing type" })
      filter.type = String(type)
    }
    if (category) filter.category = String(category).slice(0, 80)
    if (seller) {
      if (!mongoose.isValidObjectId(String(seller))) return res.status(400).json({ message: "Invalid seller" })
      filter.seller = String(seller)
    }
    if (search) {
      const text = escapeRegex(String(search).trim().slice(0, 100))
      if (text) filter.$or = [
        { title: { $regex: text, $options: "i" } },
        { desc: { $regex: text, $options: "i" } },
        { category: { $regex: text, $options: "i" } },
      ]
    }
    const page = clampInt(req.query.page, 1, 1, 1000)
    const limit = clampInt(req.query.limit, 16, 1, 100)
    const listings = await Listing.find(filter)
      .select(PRIVATE_FIELDS)
      .populate("seller", PUBLIC_SELLER_FIELDS)
      .sort({ createdAt: -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
    res.json(listings)
  } catch (err) {
    console.error("Listings fetch failed:", err)
    res.status(500).json({ message: "Could not load listings" })
  }
})

// @route GET /api/listings/my — ONLY this seller's listings (private, includes contact details)
router.get("/my", protect, async (req, res) => {
  try {
    const listings = await Listing.find({ seller: req.user.id }).sort({ createdAt: -1 })
    res.json(listings)
  } catch (err) {
    console.error("My listings fetch failed:", err)
    res.status(500).json({ message: "Could not load your listings" })
  }
})

// @route GET /api/listings/:id — open a single listing (public: ACTIVE listings only)
router.get("/:id", async (req, res) => {
  try {
    const unavailable = () => res.status(404).json({ message: "Listing not found", code: "LISTING_UNAVAILABLE" })
    if (!mongoose.isValidObjectId(req.params.id)) return unavailable()
    const listing = await Listing.findOne({ _id: req.params.id, status: "Active" })
      .select(PRIVATE_FIELDS)
      .populate("seller", PUBLIC_SELLER_FIELDS)
      .lean()
    if (!listing) return unavailable()
    res.json(listing)
  } catch (err) {
    console.error("Listing fetch failed:", err)
    res.status(500).json({ message: "Could not load listing" })
  }
})

// @route POST /api/listings — create listing (seller only)
router.post("/", protect, upload.single("image"), async (req, res) => {
  const reject = async (status, message) => { await destroyImage(req.file?.filename); return res.status(status).json({ message }) }
  try {
    let data
    try { data = JSON.parse(req.body?.data) } catch { return reject(400, "Invalid listing data") }
    const { clean, error } = validateNewListing(data)
    if (error) return reject(400, error)
    if (!req.file?.path) return reject(400, "A listing photo is required")

    const seller = await User.findById(req.user.id).select("university").lean()
    const listing = await Listing.create({
      ...clean,
      seller: req.user.id,
      image: req.file.path,
      imagePublicId: req.file.filename || "",
      universityKey: universityKey(seller?.university),
    })
    const populated = await listing.populate("seller", PUBLIC_SELLER_FIELDS)
    res.status(201).json(populated)
  } catch (err) {
    console.error("Listing creation failed:", err)
    await destroyImage(req.file?.filename)
    res.status(500).json({ message: "Could not create listing" })
  }
})

// @route PUT /api/listings/:id — edit (owner only, protected fields)
router.put("/:id", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Listing not found" })
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

    const maxLength = { title: 120, desc: 3000, category: 80, condition: 40, contactDetail: 200, contactNote: 300 }
    for (const key of fields) {
      const value = incoming[key]
      if (["title", "desc", "category"].includes(key)) {
        if (typeof value !== "string" || !value.trim())
          return res.status(400).json({ message: key + " is required" })
        if (value.trim().length > maxLength[key]) return res.status(400).json({ message: key + " is too long" })
        listing[key] = value.trim()
      } else if (["price", "dailyRate", "maxDays"].includes(key)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (key === "maxDays" && (!Number.isInteger(value) || value > 365)))
          return res.status(400).json({ message: key + " must be a positive number" })
        listing[key] = value
      } else {
        if (typeof value !== "string")
          return res.status(400).json({ message: key + " must be text" })
        if (value.length > maxLength[key]) return res.status(400).json({ message: key + " is too long" })
        listing[key] = value
      }
    }
    const updated = await listing.save()
    res.json(updated)
  } catch (err) {
    console.error("Listing update failed:", err)
    res.status(500).json({ message: "Could not update listing" })
  }
})

// @route DELETE /api/listings/:id — delete (owner only)
router.delete("/:id", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Listing not found" })
    const listing = await Listing.findById(req.params.id)
    if (!listing) return res.status(404).json({ message: "Listing not found" })
    if (listing.seller.toString() !== req.user.id)
      return res.status(403).json({ message: "Not authorized" })
    const imagePublicId = listing.imagePublicId
    await listing.deleteOne()
    await destroyImage(imagePublicId) // free Cloudinary storage; failure never blocks the delete
    res.json({ message: "Listing removed" })
  } catch (err) {
    console.error("Listing delete failed:", err)
    res.status(500).json({ message: "Could not remove listing" })
  }
})

export { validateNewListing }
export default router

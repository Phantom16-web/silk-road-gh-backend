
import express from "express"
import Rider from "../models/Rider.js"
import protect from "../middleware/auth.js"
import upload from "../middleware/upload.js"
import {
  requireAdminAuth,
  requirePermission,
} from "../middleware/adminAuth.js"

const router = express.Router()

// Public rider directory.
// Never return password hashes, precise live locations, earnings,
// internal delivery assignments, or other private operational fields.
router.get("/", async (req, res) => {
  try {
    const riders = await Rider.find({
      isApproved: true,
      isActive: true,
    })
      .select(
        "name vehicle rating ratingCount isOnline university createdAt"
      )
      .sort({ createdAt: -1 })
      .lean()

    return res.json(riders)
  } catch (err) {
    console.error("Public rider directory error:", err.message)
    return res.status(500).json({
      message: "Unable to retrieve riders.",
    })
  }
})

// Rider application/registration.
// The Rider model requires email and password. Validate these explicitly
// rather than returning an unhandled Mongoose validation error.
router.post("/", upload.single("photo"), async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      password,
      university,
      vehicle,
    } = req.body

    if (
      !name?.trim() ||
      !phone?.trim() ||
      !email?.trim() ||
      !password
    ) {
      return res.status(400).json({
        message: "Name, phone, email and password are required.",
      })
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters.",
      })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const normalizedPhone = phone.trim()

    const existing = await Rider.findOne({
      $or: [
        { email: normalizedEmail },
        { phone: normalizedPhone },
      ],
    }).select("_id")

    if (existing) {
      return res.status(409).json({
        message: "A rider account with that email or phone already exists.",
      })
    }

    const allowedVehicles = ["motorbike", "bicycle", "walking"]
    const selectedVehicle = vehicle || "motorbike"

    if (!allowedVehicles.includes(selectedVehicle)) {
      return res.status(400).json({
        message: "Unsupported vehicle type.",
      })
    }

    const rider = await Rider.create({
      name: name.trim(),
      phone: normalizedPhone,
      email: normalizedEmail,
      password,
      university: university?.trim() || "",
      vehicle: selectedVehicle,
      // New applications must not become approved merely by registering.
      isApproved: false,
      isActive: true,
      isOnline: false,
    })

    // Return only safe, necessary account details.
    return res.status(201).json({
      message: "Rider application received and awaiting approval.",
      rider: {
        id: rider._id,
        name: rider.name,
        phone: rider.phone,
        email: rider.email,
        university: rider.university,
        vehicle: rider.vehicle,
        isApproved: rider.isApproved,
        isActive: rider.isActive,
      },
    })
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "A rider account with that email or phone already exists.",
      })
    }

    if (err?.name === "ValidationError") {
      return res.status(400).json({
        message: "Rider registration details are invalid.",
      })
    }

    console.error("Rider registration error:", err.message)
    return res.status(500).json({
      message: "Unable to register rider.",
    })
  }
})

// Administrative status changes.
// A regular user token alone must not authorize rider management.
router.put(
  "/:id/status",
  requireAdminAuth,
  requirePermission("manage_riders"),
  async (req, res) => {
    try {
      const allowedFields = ["isActive", "isApproved", "isOnline"]
      const updates = {}

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          if (typeof req.body[field] !== "boolean") {
            return res.status(400).json({
              message: `${field} must be true or false.`,
            })
          }

          updates[field] = req.body[field]
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          message: "Provide at least one valid rider status field.",
        })
      }

      const rider = await Rider.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        {
          new: true,
          runValidators: true,
        }
      ).select(
        "name phone email university vehicle isActive isApproved isOnline rating ratingCount"
      )

      if (!rider) {
        return res.status(404).json({
          message: "Rider not found.",
        })
      }

      return res.json({
        message: "Rider status updated.",
        rider,
      })
    } catch (err) {
      console.error("Rider status update error:", err.message)
      return res.status(500).json({
        message: "Unable to update rider status.",
      })
    }
  }
)

export default router

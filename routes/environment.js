import express from "express"

import Environment, { getEnvironmentMode } from "../models/Environment.js"
import {
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  logAction,
} from "../middleware/adminAuth.js"

const router = express.Router()

// This flag controls the Owner's ability to change environments.
// Keep it disabled until payment, delivery, and settlement paths are tested.
const switchingEnabled = () => process.env.ENABLE_ENVIRONMENT_SWITCH === "true"

router.get("/", async (req, res) => {
  try {
    const mode = await getEnvironmentMode()
    return res.json({
      mode,
      isTesting: mode === "testing",
      // Describes the environment, not a guarantee that payment providers are configured.
      realPaymentsEnabled: mode === "live",
    })
  } catch (error) {
    console.error("Environment status error:", error)
    return res.status(503).json({ message: "Unable to retrieve environment status." })
  }
})

router.get("/owner", requireAdminAuth, requireOwner, async (req, res) => {
  try {
    const environment = await Environment.findById("global")
    return res.json({
      mode: environment?.mode || "live",
      changedBy: environment?.changedBy || null,
      changedAt: environment?.changedAt || null,
      switchingEnabled: switchingEnabled(),
    })
  } catch (error) {
    console.error("Owner environment lookup error:", error)
    return res.status(503).json({ message: "Unable to retrieve environment configuration." })
  }
})

router.put(
  "/mode",
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  async (req, res) => {
    try {
      // Check before even reporting a no-op. Disabled means no mode changes.
      if (!switchingEnabled()) {
        return res.status(503).json({
          message: "Environment switching is not activated. Complete and verify the payment and settlement safeguards first.",
          code: "ENVIRONMENT_SWITCH_NOT_READY",
        })
      }

      const { mode } = req.body || {}
      if (mode !== "testing" && mode !== "live") {
        return res.status(400).json({ message: "Mode must be either 'testing' or 'live'." })
      }

      // Read the actual persisted document so a missing record cannot be
      // confused with an existing 'live' record during compare-and-swap.
      let current = await Environment.findById("global")
      if (!current) {
        // Initialize to live, never directly to testing. Concurrent initializers
        // are harmless; only one can insert the unique global document.
        try {
          current = await Environment.create({
            _id: "global",
            mode: "live",
            changedBy: req.adminUser.email,
            changedAt: new Date(),
          })
        } catch (error) {
          if (error.code !== 11000) throw error
          current = await Environment.findById("global")
          if (!current) {
            return res.status(503).json({ message: "Environment initialization failed." })
          }
        }
      }

      const previousMode = current.mode
      if (previousMode === mode) {
        return res.json({ mode, changed: false, message: `The platform is already in ${mode} mode.` })
      }

      const now = new Date()
      const updated = await Environment.findOneAndUpdate(
        { _id: "global", mode: previousMode },
        { $set: { mode, changedBy: req.adminUser.email, changedAt: now } },
        { new: true, runValidators: true }
      )
      if (!updated) {
        return res.status(409).json({
          message: "Environment configuration changed concurrently. Refresh and try again.",
        })
      }

      await logAction(req, "environment_mode_changed", "environment", "global", {
        previousMode,
        newMode: mode,
        changedAt: now.toISOString(),
      })

      return res.json({
        mode: updated.mode,
        changed: true,
        changedAt: updated.changedAt,
        message: `Environment switched to ${updated.mode}.`,
      })
    } catch (error) {
      console.error("Environment switch error:", error)
      return res.status(500).json({ message: "Unable to change platform environment." })
    }
  }
)

export default router

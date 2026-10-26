
import express from "express"

import Environment, {
  getEnvironmentMode,
} from "../models/Environment.js"

import {
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  logAction,
} from "../middleware/adminAuth.js"

const router = express.Router()

// -----------------------------------------------------------------------------
// GET /api/environment
//
// Public read-only status.
// Never expose Owner credentials or authentication details.
// -----------------------------------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const mode = await getEnvironmentMode()

    return res.json({
      mode,
      isTesting: mode === "testing",
      realPaymentsEnabled: mode === "live",
    })
  } catch (error) {
    console.error("Environment status error:", error)

    return res.status(503).json({
      message: "Unable to retrieve environment status.",
    })
  }
})

// -----------------------------------------------------------------------------
// GET /api/environment/owner
//
// Owner-only environment details.
// -----------------------------------------------------------------------------

router.get(
  "/owner",
  requireAdminAuth,
  requireOwner,
  async (req, res) => {
    try {
      const environment = await Environment.findById("global")

      return res.json({
        mode: environment?.mode || "live",
        changedBy: environment?.changedBy || null,
        changedAt: environment?.changedAt || null,
      })
    } catch (error) {
      console.error("Owner environment lookup error:", error)

      return res.status(503).json({
        message: "Unable to retrieve environment configuration.",
      })
    }
  }
)

// -----------------------------------------------------------------------------
// PUT /api/environment/mode
//
// Owner-only.
// Requires a valid Owner login and a fresh re-authentication token.
//
// Request body:
// {
//   "mode": "testing"
// }
//
// Headers:
// Authorization: Bearer <owner-token>
// x-reauth-token: <fresh-reauth-token>
// -----------------------------------------------------------------------------

router.put(
  "/mode",
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  async (req, res) => {
    try {
      const { mode } = req.body || {}

      if (!["testing", "live"].includes(mode)) {
        return res.status(400).json({
          message: "Mode must be either 'testing' or 'live'.",
        })
      }

      const previousMode = await getEnvironmentMode()

      if (previousMode === mode) {
        return res.json({
          mode,
          changed: false,
          message: `The platform is already in ${mode} mode.`,
        })
      }

      // Environment switching remains disabled until the payment,
      // order, delivery and settlement integrations are installed
      // and verified together.
      //
      // This is a deliberate fail-closed deployment safeguard.
      if (process.env.ENABLE_ENVIRONMENT_SWITCH !== "true") {
        return res.status(503).json({
          message:
            "Environment switching is not activated. Complete and verify the payment and settlement safeguards first.",
          code: "ENVIRONMENT_SWITCH_NOT_READY",
        })
      }

      const now = new Date()

      // Compare-and-swap: reject conflicting concurrent switches.
      const updated = await Environment.findOneAndUpdate(
        {
          _id: "global",
          mode: previousMode,
        },
        {
          $set: {
            mode,
            changedBy: req.adminUser.email,
            changedAt: now,
          },
        },
        {
          new: true,
        }
      )

      // The initial document may not exist yet.
      // Only allow initialization into Live Mode.
      if (!updated && previousMode === "live") {
        const existing = await Environment.findById("global")

        if (!existing) {
          try {
            await Environment.create({
              _id: "global",
              mode: "live",
              changedBy: req.adminUser.email,
              changedAt: now,
            })
          } catch (error) {
            if (error.code !== 11000) throw error
          }
        }
      }

      if (!updated) {
        return res.status(409).json({
          message:
            "Environment configuration changed or requires initialization. Refresh and try again.",
        })
      }

      await logAction(
        req,
        "environment_mode_changed",
        "environment",
        "global",
        {
          previousMode,
          newMode: mode,
          changedAt: now.toISOString(),
        }
      )

      return res.json({
        mode: updated.mode,
        changed: true,
        changedAt: updated.changedAt,
        message: `Environment switched to ${updated.mode}.`,
      })
    } catch (error) {
      console.error("Environment switch error:", error)

      return res.status(500).json({
        message: "Unable to change platform environment.",
      })
    }
  }
)

export default router

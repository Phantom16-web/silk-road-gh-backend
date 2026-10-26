import express from "express"
import Environment, { getEnvironmentMode } from "../models/Environment.js"
import Order from "../models/Order.js"
import Delivery from "../models/Delivery.js"
import Payment from "../models/Payment.js"
import {
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  logAction,
} from "../middleware/adminAuth.js"

const router = express.Router()
const switchingEnabled = () => process.env.ENABLE_ENVIRONMENT_SWITCH === "true"

// This is a conservative preflight, NOT an atomic guarantee against new orders.
// Keep the switch disabled until the creation/verification routes are coordinated.
async function switchBlockers(targetMode) {
  const leaving = targetMode === "testing" ? "live" : "testing"
  const envFilter = leaving === "live"
    ? { environment: { $ne: "testing" }, isSimulatedPayment: { $ne: true } }
    : { environment: "testing" }

  const activeOrders = await Order.find({
    ...envFilter,
    cancelled: { $ne: true },
    paymentStatus: { $in: ["escrow_held", "release_pending", "refund_pending", "disputed"] },
  }).select("_id localOrderId").limit(1).lean()

  const activeDeliveryOrders = await Order.find(envFilter).select("_id").lean()
  const ids = activeDeliveryOrders.map((o) => o._id)
  const activeDeliveries = ids.length
    ? await Delivery.exists({ order: { $in: ids }, status: { $in: ["accepted", "picked_up", "delivered"] } })
    : null

  // A pending Paystack or submitted manual payment can still become real money.
  const openPayment = leaving === "live" && ids.length
    ? await Payment.exists({
        order: { $in: ids },
        status: { $in: ["pending", "submitted", "under_review"] },
      })
    : null

  return {
    unsettledOrders: Boolean(activeOrders.length),
    activeDeliveries: Boolean(activeDeliveries),
    openPayments: Boolean(openPayment),
  }
}

router.get("/", async (req, res) => {
  try {
    const mode = await getEnvironmentMode()
    return res.json({ mode, isTesting: mode === "testing", realPaymentsEnabled: mode === "live" })
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

router.put("/mode", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  try {
    if (!switchingEnabled()) {
      return res.status(503).json({
        message: "Environment switching is not activated. Complete and verify the payment and settlement safeguards first.",
        code: "ENVIRONMENT_SWITCH_NOT_READY",
      })
    }
    const { mode } = req.body || {}
    if (!["testing", "live"].includes(mode)) {
      return res.status(400).json({ message: "Mode must be either 'testing' or 'live'." })
    }
    let current = await Environment.findById("global")
    if (!current) {
      try {
        current = await Environment.create({
          _id: "global", mode: "live", changedBy: req.adminUser.email, changedAt: new Date(),
        })
      } catch (error) {
        if (error.code !== 11000) throw error
        current = await Environment.findById("global")
        if (!current) return res.status(503).json({ message: "Environment initialization failed." })
      }
    }
    const previousMode = current.mode
    if (previousMode === mode) {
      return res.json({ mode, changed: false, message: `The platform is already in ${mode} mode.` })
    }

    const blockers = await switchBlockers(mode)
    if (Object.values(blockers).some(Boolean)) {
      return res.status(409).json({
        message: "Cannot switch environments while transactions or deliveries in the current environment remain active.",
        code: "ENVIRONMENT_ACTIVE_TRANSACTIONS",
        blockers,
      })
    }

    const now = new Date()
    const updated = await Environment.findOneAndUpdate(
      { _id: "global", mode: previousMode },
      { $set: { mode, changedBy: req.adminUser.email, changedAt: now } },
      { new: true, runValidators: true }
    )
    if (!updated) {
      return res.status(409).json({ message: "Environment configuration changed concurrently. Refresh and try again." })
    }
    await logAction(req, "environment_mode_changed", "environment", "global", {
      previousMode, newMode: mode, changedAt: now.toISOString(),
    })
    return res.json({
      mode: updated.mode, changed: true, changedAt: updated.changedAt,
      message: `Environment switched to ${updated.mode}.`,
    })
  } catch (error) {
    console.error("Environment switch error:", error)
    return res.status(500).json({ message: "Unable to change platform environment." })
  }
})

export default router

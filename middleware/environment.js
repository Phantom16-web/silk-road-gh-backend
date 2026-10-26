
import { getEnvironmentMode } from "../models/Environment.js"

// Read the platform's current operating mode from MongoDB.
export async function attachEnvironment(req, res, next) {
  try {
    req.environmentMode = await getEnvironmentMode()
    next()
  } catch (error) {
    console.error("Environment lookup failed:", error)

    return res.status(503).json({
      message: "Platform environment is temporarily unavailable.",
      code: "ENVIRONMENT_UNAVAILABLE",
    })
  }
}

// Only permit an operation when the platform is in Testing Mode.
export async function requireTestingMode(req, res, next) {
  try {
    const mode = await getEnvironmentMode()

    if (mode !== "testing") {
      return res.status(403).json({
        message: "This operation is only available in Testing Mode.",
        code: "TESTING_MODE_REQUIRED",
      })
    }

    req.environmentMode = mode
    next()
  } catch (error) {
    console.error("Testing Mode check failed:", error)

    return res.status(503).json({
      message: "Unable to verify the platform environment.",
      code: "ENVIRONMENT_UNAVAILABLE",
    })
  }
}

// Prevent live-money operations while Testing Mode is active.
// This must be applied to every real payment entry point.
export async function requireLiveMode(req, res, next) {
  try {
    const mode = await getEnvironmentMode()

    if (mode !== "live") {
      return res.status(403).json({
        message: "Real payment operations are disabled in Testing Mode.",
        code: "LIVE_MODE_REQUIRED",
      })
    }

    req.environmentMode = mode
    next()
  } catch (error) {
    console.error("Live Mode check failed:", error)

    return res.status(503).json({
      message: "Unable to verify the platform environment.",
      code: "ENVIRONMENT_UNAVAILABLE",
    })
  }
}

// Check the immutable environment assigned to an order.
//
// Older orders have no environment field. They must always be
// treated as LIVE orders, never silently converted into tests.
export function isTestOrder(order) {
  return order?.environment === "testing"
}

export function isLiveOrder(order) {
  return !isTestOrder(order)
}

// Use this before any real settlement or external payout.
// Simulated orders can never be settled as real money.
export function requireRealOrder(req, res, next) {
  const order = req.order

  if (!order) {
    return res.status(500).json({
      message: "Order was not loaded before settlement validation.",
      code: "ORDER_NOT_LOADED",
    })
  }

  if (isTestOrder(order)) {
    return res.status(403).json({
      message: "Simulated orders cannot trigger real financial settlement.",
      code: "TEST_ORDER_SETTLEMENT_BLOCKED",
    })
  }

  next()
}

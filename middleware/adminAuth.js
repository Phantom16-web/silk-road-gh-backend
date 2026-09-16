import jwt   from "jsonwebtoken"
import Admin from "../models/Admin.js"
import Owner from "../models/Owner.js"

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET

// ── Issue JWT for admin/super_admin ───────────────────────────────────────────
export function issueAdminToken(admin) {
  return jwt.sign(
    {
      id:          admin._id.toString(),
      email:       admin.email,
      tier:        admin.tier,
      role:        admin.role        || null,
      permissions: admin.permissions || [],
      type:        "admin",
    },
    ADMIN_JWT_SECRET,
    { expiresIn: "8h" }
  )
}

// ── Issue JWT for owner ───────────────────────────────────────────────────────
export function issueOwnerToken(owner) {
  return jwt.sign(
    {
      id:    owner._id.toString(),
      email: owner.email,
      tier:  "owner",
      type:  "admin",
    },
    ADMIN_JWT_SECRET,
    { expiresIn: "4h" }
  )
}

// ── Decode and attach admin/owner to req ──────────────────────────────────────
export async function requireAdminAuth(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No admin token provided." })
    }

    const token   = header.split(" ")[1]
    let   decoded

    try {
      decoded = jwt.verify(token, ADMIN_JWT_SECRET)
    } catch (err) {
      if (err.name === "TokenExpiredError")
        return res.status(401).json({ message: "Admin session expired. Please log in again.", expired: true })
      return res.status(401).json({ message: "Invalid admin token." })
    }

    if (decoded.type !== "admin") {
      return res.status(401).json({ message: "Invalid token type." })
    }

    // ── Owner ─────────────────────────────────────────────────────────────────
    if (decoded.tier === "owner") {
      const owner = await Owner.findById(decoded.id).select("-recoveryCodes -emergencyKeys")
      if (!owner) return res.status(401).json({ message: "Owner account not found." })
      req.adminUser = {
        _id:   owner._id.toString(),
        email: owner.email,
        tier:  "owner",
        role:  "owner",
        isOwner: true,
      }
      req.ownerDoc = owner
      return next()
    }

    // ── Admin / Super Admin ───────────────────────────────────────────────────
    const admin = await Admin.findById(decoded.id)
    if (!admin)          return res.status(401).json({ message: "Admin account not found." })
    if (!admin.isActive) return res.status(403).json({ message: "Admin account is suspended." })

    req.adminUser = {
      _id:         admin._id.toString(),
      email:       admin.email,
      name:        admin.name,
      tier:        admin.tier,
      role:        admin.role,
      permissions: admin.permissions,
      isOwner:     false,
      isSuperAdmin: admin.tier === "super_admin",
    }
    req.adminDoc = admin

    next()
  } catch (err) {
    console.error("adminAuth error:", err.message)
    res.status(500).json({ message: "Auth error." })
  }
}

// ── Require specific tier ─────────────────────────────────────────────────────
export function requireOwner(req, res, next) {
  if (!req.adminUser?.isOwner) {
    return res.status(403).json({ message: "Owner access required." })
  }
  next()
}

export function requireSuperAdmin(req, res, next) {
  if (!req.adminUser?.isOwner && req.adminUser?.tier !== "super_admin") {
    return res.status(403).json({ message: "Super Admin access required." })
  }
  next()
}

export function requireOwnerOrSuperAdmin(req, res, next) {
  if (!req.adminUser?.isOwner && req.adminUser?.tier !== "super_admin") {
    return res.status(403).json({ message: "Super Admin or Owner access required." })
  }
  next()
}

// ── Require specific permission ───────────────────────────────────────────────
export function requirePermission(perm) {
  return (req, res, next) => {
    if (req.adminUser?.isOwner) return next() // Owner has all permissions
    if (req.adminUser?.isSuperAdmin) return next() // Super Admin has all permissions
    if (req.adminUser?.permissions?.includes(perm)) return next()
    return res.status(403).json({
      message: `Permission denied. Required: ${perm}`,
    })
  }
}

export function requireAnyPermission(...perms) {
  return (req, res, next) => {
    if (req.adminUser?.isOwner)     return next()
    if (req.adminUser?.isSuperAdmin) return next()
    const has = perms.some(p => req.adminUser?.permissions?.includes(p))
    if (has) return next()
    return res.status(403).json({
      message: `Permission denied. Required one of: ${perms.join(", ")}`,
    })
  }
}

// ── Re-auth gate — critical Owner actions ────────────────────────────────────
// Owner must have passed re-authentication within the last 5 minutes
// to perform sensitive operations (create/revoke super admins, delete admins, etc.)
// Usage: router.delete("/admins/:id", requireAdminAuth, requireOwner, requireReAuth, handler)
export function requireReAuth(req, res, next) {
  if (!req.adminUser?.isOwner) {
    // Non-owners don't need re-auth — they use normal permission gates
    return next()
  }

  const token = req.headers["x-reauth-token"]
  if (!token) {
    return res.status(403).json({
      message:       "Re-authentication required for this action.",
      requiresReAuth: true,
    })
  }

  const owner = req.ownerDoc
  if (!owner) {
    return res.status(403).json({ message: "Owner session invalid." })
  }

  if (!owner.verifyReAuthToken(token)) {
    return res.status(403).json({
      message:       "Re-auth token expired or invalid. Please re-authenticate.",
      requiresReAuth: true,
    })
  }

  next()
}

// ── Log admin action helper (used in route handlers) ─────────────────────────
export async function logAction(req, action, entity = null, entityId = null, meta = {}) {
  try {
    if (req.adminUser?.isOwner && req.ownerDoc) {
      await req.ownerDoc.log(action, meta, req)
    } else if (req.adminDoc) {
      await req.adminDoc.log(action, entity, entityId, meta, req)
    }
  } catch (err) {
    console.warn("logAction failed:", err.message)
  }
}

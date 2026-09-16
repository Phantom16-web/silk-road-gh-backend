import express from "express"
import bcrypt  from "bcryptjs"
import crypto  from "crypto"
import Admin   from "../models/Admin.js"
import Owner   from "../models/Owner.js"
import {
  issueAdminToken,
  issueOwnerToken,
  requireAdminAuth,
  requireOwner,
  requireReAuth,
  logAction,
} from "../middleware/adminAuth.js"
import { ROLE_PERMISSIONS, SUPER_ADMIN_PERMISSIONS, ALL_ROLES } from "../models/Admin.js"

const router = express.Router()

// ── Rate limit helper (simple in-memory, per IP) ──────────────────────────────
const loginAttempts = new Map()

function checkRateLimit(ip, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now()
  const key = `login:${ip}`
  const rec = loginAttempts.get(key) || { count: 0, resetAt: now + windowMs }

  if (now > rec.resetAt) {
    rec.count   = 0
    rec.resetAt = now + windowMs
  }

  rec.count++
  loginAttempts.set(key, rec)

  if (rec.count > maxAttempts) {
    const waitSec = Math.ceil((rec.resetAt - now) / 1000)
    return { blocked: true, waitSec }
  }
  return { blocked: false }
}

function clearRateLimit(ip) {
  loginAttempts.delete(`login:${ip}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin-auth/owner/login
// Email + Password + Owner Secret Key → JWT
router.post("/owner/login", async (req, res) => {
  try {
    const ip = req.ip || "unknown"
    const rl = checkRateLimit(ip, 5, 15 * 60 * 1000)
    if (rl.blocked) {
      return res.status(429).json({
        message: `Too many login attempts. Try again in ${rl.waitSec} seconds.`
      })
    }

    const { email, password, secretKey } = req.body
    if (!email || !password || !secretKey) {
      return res.status(400).json({ message: "Email, password, and secret key are required." })
    }

    const owner = await Owner.findOne({ email: email.toLowerCase().trim() })
    if (!owner) {
      return res.status(401).json({ message: "Invalid credentials." })
    }

    // All three must pass — constant-time to prevent timing attacks
    const [passOk, keyOk] = await Promise.all([
      owner.verifyPassword(password),
      owner.verifySecretKey(secretKey),
    ])

    if (!passOk || !keyOk) {
      await owner.log("owner_login_failed", { ip, reason: "invalid_credentials" }, req)
      return res.status(401).json({ message: "Invalid credentials." })
    }

    // Clear rate limit on success
    clearRateLimit(ip)

    // Update last login
    owner.lastLogin   = new Date()
    owner.lastLoginIp = ip
    await owner.save()
    await owner.log("owner_login_success", { ip }, req)

    const token = issueOwnerToken(owner)

    res.json({
      token,
      tier:  "owner",
      email: owner.email,
      unusedRecoveryCodes: owner.unusedRecoveryCodeCount(),
    })
  } catch (err) {
    console.error("Owner login error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// POST /api/admin-auth/owner/reauth
// Owner re-enters password + secretKey to unlock critical actions for 5 minutes
router.post("/owner/reauth", requireAdminAuth, requireOwner, async (req, res) => {
  try {
    const { password, secretKey } = req.body
    if (!password || !secretKey) {
      return res.status(400).json({ message: "Password and secret key required." })
    }

    const owner = req.ownerDoc
    const [passOk, keyOk] = await Promise.all([
      owner.verifyPassword(password),
      owner.verifySecretKey(secretKey),
    ])

    if (!passOk || !keyOk) {
      await owner.log("owner_reauth_failed", { ip: req.ip }, req)
      return res.status(401).json({ message: "Invalid credentials." })
    }

    const reAuthToken = await owner.issueReAuthToken()
    await owner.log("owner_reauth_success", { ip: req.ip }, req)

    res.json({
      reAuthToken,
      expiresIn: 300, // 5 minutes
      message:   "Re-authentication successful. You have 5 minutes to complete the action.",
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// POST /api/admin-auth/owner/recover
// Use a one-time recovery code to get a token when locked out
router.post("/owner/recover", async (req, res) => {
  try {
    const ip = req.ip || "unknown"
    const rl = checkRateLimit(ip, 3, 60 * 60 * 1000) // stricter — 3 attempts per hour
    if (rl.blocked) {
      return res.status(429).json({
        message: `Too many recovery attempts. Try again in ${rl.waitSec} seconds.`
      })
    }

    const { email, recoveryCode } = req.body
    if (!email || !recoveryCode) {
      return res.status(400).json({ message: "Email and recovery code required." })
    }

    const owner = await Owner.findOne({ email: email.toLowerCase().trim() })
    if (!owner) {
      return res.status(401).json({ message: "Invalid credentials." })
    }

    const codeOk = await owner.verifyRecoveryCode(recoveryCode.trim().toUpperCase())
    if (!codeOk) {
      await owner.log("owner_recovery_failed", { ip, reason: "invalid_code" }, req)
      return res.status(401).json({ message: "Invalid or already used recovery code." })
    }

    clearRateLimit(ip)

    owner.lastLogin   = new Date()
    owner.lastLoginIp = ip
    await owner.save()
    await owner.log("owner_recovery_used", { ip }, req)

    const token = issueOwnerToken(owner)

    res.json({
      token,
      tier:                "owner",
      email:               owner.email,
      unusedRecoveryCodes: owner.unusedRecoveryCodeCount(),
      warning:             owner.unusedRecoveryCodeCount() <= 3
        ? `Only ${owner.unusedRecoveryCodeCount()} recovery codes remaining. Run the seed script with --reset to generate new ones.`
        : null,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// POST /api/admin-auth/owner/emergency
// Both emergency keys required simultaneously — one-time use, then burned
router.post("/owner/emergency", async (req, res) => {
  try {
    const ip = req.ip || "unknown"
    const rl = checkRateLimit(ip, 2, 60 * 60 * 1000) // very strict — 2 per hour
    if (rl.blocked) {
      return res.status(429).json({
        message: `Too many emergency attempts. Try again in ${rl.waitSec} seconds.`
      })
    }

    const { email, emergencyKey1, emergencyKey2 } = req.body
    if (!email || !emergencyKey1 || !emergencyKey2) {
      return res.status(400).json({ message: "Email and both emergency keys are required." })
    }

    const owner = await Owner.findOne({ email: email.toLowerCase().trim() })
    if (!owner) {
      return res.status(401).json({ message: "Invalid credentials." })
    }

    const keysOk = await owner.verifyEmergencyKeys(emergencyKey1, emergencyKey2)
    if (!keysOk) {
      await owner.log("owner_emergency_failed", { ip, reason: "invalid_keys" }, req)
      return res.status(401).json({ message: "Invalid emergency keys or keys already used." })
    }

    clearRateLimit(ip)

    owner.lastLogin   = new Date()
    owner.lastLoginIp = ip
    await owner.save()
    await owner.log("owner_emergency_access_used", { ip }, req)

    const token = issueOwnerToken(owner)

    res.json({
      token,
      tier:    "owner",
      email:   owner.email,
      warning: "Emergency keys have been burned. Run the seed script with --reset immediately to generate new ones.",
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// POST /api/admin-auth/owner/change-password
// Owner changes their own password — requires re-auth
router.post("/owner/change-password", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  try {
    const { newPassword } = req.body
    if (!newPassword || newPassword.length < 16) {
      return res.status(400).json({ message: "New password must be at least 16 characters." })
    }

    const owner = req.ownerDoc
    owner.passwordHash = await Owner.hashPassword(newPassword)
    await owner.clearReAuthToken()
    await owner.log("owner_password_changed", { ip: req.ip }, req)

    res.json({ message: "Password updated successfully." })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET /api/admin-auth/owner/audit-log
router.get("/owner/audit-log", requireAdminAuth, requireOwner, async (req, res) => {
  try {
    const owner = req.ownerDoc
    const full  = await Owner.findById(owner._id).select("auditLog")
    res.json({ auditLog: (full?.auditLog || []).slice().reverse() })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// SUPER ADMIN ROUTES — created and managed by Owner only
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin-auth/super-admin/create
// Owner creates a Super Admin — generates a secret key for them
router.post("/super-admin/create", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  try {
    const { name, email, password } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required." })
    }
    if (password.length < 12) {
      return res.status(400).json({ message: "Password must be at least 12 characters." })
    }

    const exists = await Admin.findOne({ email: email.toLowerCase().trim() })
    if (exists) {
      return res.status(400).json({ message: "An admin with that email already exists." })
    }

    // Generate a secret key for this Super Admin — shown once
    const secretKey    = crypto.randomBytes(40).toString("base64url")
    const passwordHash = await Admin.hashPassword(password)
    const secretKeyHash = await Admin.hashSecretKey(secretKey)

    const superAdmin = await Admin.create({
      name,
      email:        email.toLowerCase().trim(),
      passwordHash,
      secretKeyHash,
      tier:         "super_admin",
      role:         "super_admin",
      permissions:  SUPER_ADMIN_PERMISSIONS,
      createdBy:    req.adminUser.email,
    })

    await req.ownerDoc.log(
      "super_admin_created",
      { name, email: email.toLowerCase(), createdBy: req.adminUser.email },
      req
    )
    await req.ownerDoc.clearReAuthToken()

    res.status(201).json({
      message:   "Super Admin created successfully.",
      admin:     superAdmin.toPublic(),
      secretKey, // shown ONCE — Super Admin must save this
      warning:   "The secret key will not be shown again. The Super Admin must save it immediately.",
    })
  } catch (err) {
    console.error("Create super admin error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// POST /api/admin-auth/super-admin/login
// Email + Password + Secret Key → JWT
router.post("/super-admin/login", async (req, res) => {
  try {
    const ip = req.ip || "unknown"
    const rl = checkRateLimit(ip, 5, 15 * 60 * 1000)
    if (rl.blocked) {
      return res.status(429).json({
        message: `Too many login attempts. Try again in ${rl.waitSec} seconds.`
      })
    }

    const { email, password, secretKey } = req.body
    if (!email || !password || !secretKey) {
      return res.status(400).json({ message: "Email, password, and secret key are required." })
    }

    const admin = await Admin.findOne({
      email: email.toLowerCase().trim(),
      tier:  "super_admin",
    })

    if (!admin || !admin.isActive) {
      return res.status(401).json({ message: "Invalid credentials." })
    }

    const [passOk, keyOk] = await Promise.all([
      admin.verifyPassword(password),
      admin.verifySecretKey(secretKey),
    ])

    if (!passOk || !keyOk) {
      return res.status(401).json({ message: "Invalid credentials." })
    }

    clearRateLimit(ip)

    admin.lastLogin   = new Date()
    admin.lastLoginIp = ip
    await admin.save()
    await admin.log("super_admin_login", null, null, { ip }, req)

    const token = issueAdminToken(admin)

    res.json({
      token,
      admin: admin.toPublic(),
    })
  } catch (err) {
    console.error("Super admin login error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// DELETE /api/admin-auth/super-admin/:id/revoke
// Owner revokes a Super Admin's access — requires re-auth
router.delete("/super-admin/:id/revoke", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id)
    if (!admin || admin.tier !== "super_admin") {
      return res.status(404).json({ message: "Super Admin not found." })
    }

    admin.isActive    = false
    admin.suspendedAt = new Date()
    admin.suspendedBy = req.adminUser.email
    admin.suspendNote = req.body.reason || "Revoked by Owner"
    await admin.save()

    await req.ownerDoc.log(
      "super_admin_revoked",
      { revokedEmail: admin.email, reason: admin.suspendNote },
      req
    )
    await req.ownerDoc.clearReAuthToken()

    res.json({ message: `Super Admin ${admin.email} has been revoked.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — created and managed by Super Admin / Owner
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin-auth/admin/create
// Super Admin or Owner creates a regular admin with a specific role
router.post("/admin/create", requireAdminAuth, async (req, res) => {
  try {
    // Only Owner or Super Admin can create admins
    if (!req.adminUser.isOwner && req.adminUser.tier !== "super_admin") {
      return res.status(403).json({ message: "Super Admin or Owner access required." })
    }

    const { name, email, password, role, customPermissions } = req.body

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "Name, email, password, and role are required." })
    }
    if (!ALL_ROLES.includes(role)) {
      return res.status(400).json({ message: `Invalid role. Must be one of: ${ALL_ROLES.join(", ")}` })
    }
    if (password.length < 10) {
      return res.status(400).json({ message: "Password must be at least 10 characters." })
    }

    const exists = await Admin.findOne({ email: email.toLowerCase().trim() })
    if (exists) {
      return res.status(400).json({ message: "An admin with that email already exists." })
    }

    // Use role's default permissions, or custom set if provided
    const permissions = customPermissions?.length
      ? customPermissions.filter(p => ROLE_PERMISSIONS[role]?.includes(p))
      : ROLE_PERMISSIONS[role] || []

    const passwordHash = await Admin.hashPassword(password)

    const admin = await Admin.create({
      name,
      email:       email.toLowerCase().trim(),
      passwordHash,
      tier:        "admin",
      role,
      permissions,
      createdBy:   req.adminUser.email,
    })

    await logAction(req, "admin_created", "admin", admin._id.toString(), {
      name, email: admin.email, role,
    })

    res.status(201).json({
      message: "Admin created successfully.",
      admin:   admin.toPublic(),
    })
  } catch (err) {
    console.error("Create admin error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// POST /api/admin-auth/admin/login
// Email + Password → JWT
router.post("/admin/login", async (req, res) => {
  try {
    const ip = req.ip || "unknown"
    const rl = checkRateLimit(ip, 5, 15 * 60 * 1000)
    if (rl.blocked) {
      return res.status(429).json({
        message: `Too many login attempts. Try again in ${rl.waitSec} seconds.`
      })
    }

    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." })
    }

    const admin = await Admin.findOne({
      email: email.toLowerCase().trim(),
      tier:  "admin",
    })

    if (!admin || !admin.isActive) {
      return res.status(401).json({ message: "Invalid credentials or account suspended." })
    }

    const passOk = await admin.verifyPassword(password)
    if (!passOk) {
      return res.status(401).json({ message: "Invalid credentials." })
    }

    clearRateLimit(ip)

    admin.lastLogin   = new Date()
    admin.lastLoginIp = ip
    await admin.save()
    await admin.log("admin_login", null, null, { ip }, req)

    const token = issueAdminToken(admin)

    res.json({
      token,
      admin: admin.toPublic(),
    })
  } catch (err) {
    console.error("Admin login error:", err.message)
    res.status(500).json({ message: err.message })
  }
})

// PUT /api/admin-auth/admin/:id/suspend
// Owner or Super Admin suspends an admin
router.put("/admin/:id/suspend", requireAdminAuth, async (req, res) => {
  try {
    if (!req.adminUser.isOwner && req.adminUser.tier !== "super_admin") {
      return res.status(403).json({ message: "Super Admin or Owner access required." })
    }

    const admin = await Admin.findById(req.params.id)
    if (!admin || admin.tier !== "admin") {
      return res.status(404).json({ message: "Admin not found." })
    }

    admin.isActive    = false
    admin.suspendedAt = new Date()
    admin.suspendedBy = req.adminUser.email
    admin.suspendNote = req.body.reason || "Suspended by admin"
    await admin.save()

    await logAction(req, "admin_suspended", "admin", admin._id.toString(), {
      suspendedEmail: admin.email, reason: admin.suspendNote,
    })

    res.json({ message: `Admin ${admin.email} suspended.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// PUT /api/admin-auth/admin/:id/reinstate
router.put("/admin/:id/reinstate", requireAdminAuth, async (req, res) => {
  try {
    if (!req.adminUser.isOwner && req.adminUser.tier !== "super_admin") {
      return res.status(403).json({ message: "Super Admin or Owner access required." })
    }

    const admin = await Admin.findById(req.params.id)
    if (!admin || admin.tier !== "admin") {
      return res.status(404).json({ message: "Admin not found." })
    }

    admin.isActive    = true
    admin.suspendedAt = null
    admin.suspendedBy = null
    admin.suspendNote = null
    await admin.save()

    await logAction(req, "admin_reinstated", "admin", admin._id.toString(), {
      reinstatedEmail: admin.email,
    })

    res.json({ message: `Admin ${admin.email} reinstated.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// DELETE /api/admin-auth/admin/:id
// Owner only — requires re-auth
router.delete("/admin/:id", requireAdminAuth, requireOwner, requireReAuth, async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id)
    if (!admin) return res.status(404).json({ message: "Admin not found." })

    await Admin.findByIdAndDelete(req.params.id)

    await req.ownerDoc.log(
      "admin_deleted",
      { deletedEmail: admin.email, role: admin.role },
      req
    )
    await req.ownerDoc.clearReAuthToken()

    res.json({ message: `Admin ${admin.email} permanently deleted.` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// PUT /api/admin-auth/admin/:id/permissions
// Super Admin or Owner updates an admin's permissions
router.put("/admin/:id/permissions", requireAdminAuth, async (req, res) => {
  try {
    if (!req.adminUser.isOwner && req.adminUser.tier !== "super_admin") {
      return res.status(403).json({ message: "Super Admin or Owner access required." })
    }

    const { permissions } = req.body
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ message: "Permissions must be an array." })
    }

    const admin = await Admin.findById(req.params.id)
    if (!admin || admin.tier !== "admin") {
      return res.status(404).json({ message: "Admin not found." })
    }

    // Only allow permissions valid for the admin's role
    const validForRole   = ROLE_PERMISSIONS[admin.role] || []
    admin.permissions    = permissions.filter(p => validForRole.includes(p))
    await admin.save()

    await logAction(req, "admin_permissions_updated", "admin", admin._id.toString(), {
      updatedEmail: admin.email, permissions: admin.permissions,
    })

    res.json({ message: "Permissions updated.", admin: admin.toPublic() })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET /api/admin-auth/admins
// List all admins — Owner or Super Admin
router.get("/admins", requireAdminAuth, async (req, res) => {
  try {
    if (!req.adminUser.isOwner && req.adminUser.tier !== "super_admin") {
      return res.status(403).json({ message: "Super Admin or Owner access required." })
    }

    const admins = await Admin.find().sort({ createdAt: -1 })
    res.json({ admins: admins.map(a => a.toPublic()) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET /api/admin-auth/me
// Returns current admin/owner profile
router.get("/me", requireAdminAuth, async (req, res) => {
  try {
    if (req.adminUser.isOwner) {
      return res.json({
        tier:  "owner",
        email: req.adminUser.email,
        unusedRecoveryCodes: req.ownerDoc?.unusedRecoveryCodeCount() || 0,
      })
    }
    res.json({ admin: req.adminDoc.toPublic() })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

export default router

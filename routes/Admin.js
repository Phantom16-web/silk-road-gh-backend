import mongoose from "mongoose"
import bcrypt   from "bcryptjs"

// ── Permission sets per role ───────────────────────────────────────────────────
export const ROLE_PERMISSIONS = {
  operations:  [
    "view_orders", "manage_orders", "view_deliveries", "manage_deliveries",
    "view_cancellations", "manage_cancellations", "view_escalations", "manage_escalations",
  ],
  user_seller: [
    "view_users", "manage_users", "view_sellers", "manage_sellers",
    "view_listings", "manage_listings", "verify_accounts", "suspend_accounts",
  ],
  finance: [
    "view_payments", "manage_payments", "view_commissions", "manage_commissions",
    "view_refunds", "manage_refunds", "view_payouts", "manage_payouts",
    "view_financial_reports",
  ],
  dispute: [
    "view_disputes", "manage_disputes", "view_evidence", "manage_evidence",
    "resolve_disputes", "issue_refund_decisions",
  ],
  moderation: [
    "view_listings", "remove_listings", "view_reviews", "remove_reviews",
    "view_content", "remove_content", "flag_content",
  ],
  support: [
    "view_tickets", "manage_tickets", "view_accounts", "basic_account_help",
  ],
  delivery: [
    "view_riders", "manage_riders", "view_assignments", "manage_assignments",
    "view_delivery_status", "manage_delivery_status", "handle_failed_deliveries",
  ],
  security: [
    "view_activity_logs", "view_fraud_signals", "manage_fraud_signals",
    "view_auth_issues", "manage_suspicious_accounts", "view_security_incidents",
  ],
}

// Super Admin gets everything
export const SUPER_ADMIN_PERMISSIONS = Object.values(ROLE_PERMISSIONS).flat()

export const ALL_ROLES = Object.keys(ROLE_PERMISSIONS)

// ── Audit log entry ────────────────────────────────────────────────────────────
const auditEntrySchema = new mongoose.Schema({
  action:    { type: String, required: true },
  entity:    { type: String, default: null  }, // e.g. "user", "listing", "order"
  entityId:  { type: String, default: null  },
  by:        { type: String, default: null  }, // admin name/email who did it
  ip:        { type: String, default: null  },
  userAgent: { type: String, default: null  },
  at:        { type: Date,   default: Date.now },
  meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false })

// ── Admin schema ───────────────────────────────────────────────────────────────
const adminSchema = new mongoose.Schema({
  name:         { type: String,  required: true, trim: true },
  email:        { type: String,  required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String,  required: true },

  // "admin" | "super_admin"
  tier: {
    type:    String,
    enum:    ["admin", "super_admin"],
    default: "admin",
  },

  // Role — only applies to tier "admin"
  // Super Admins have all permissions implicitly
  role: {
    type: String,
    enum: [...ALL_ROLES, "super_admin", null],
    default: null,
  },

  // Explicit permission list — derived from role at creation
  // Can be customised per admin by Super Admin
  permissions: {
    type:    [String],
    default: [],
  },

  // Super Admin secret key — hashed, only applies to tier "super_admin"
  secretKeyHash: { type: String, default: null },

  // Who created this admin and when
  createdBy:  { type: String, default: null }, // email of creator
  createdAt:  { type: Date,   default: Date.now },

  // Account state
  isActive:    { type: Boolean, default: true  },
  suspendedAt: { type: Date,    default: null  },
  suspendedBy: { type: String,  default: null  },
  suspendNote: { type: String,  default: null  },

  // Session tracking
  lastLogin:   { type: Date,   default: null },
  lastLoginIp: { type: String, default: null },

  // Audit log — every write action by this admin
  auditLog: {
    type:    [auditEntrySchema],
    default: [],
  },
}, { timestamps: false })

// ── Indexes ───────────────────────────────────────────────────────────────────
adminSchema.index({ email: 1 })
adminSchema.index({ tier:  1 })
adminSchema.index({ role:  1 })

// ── Password ──────────────────────────────────────────────────────────────────
adminSchema.methods.verifyPassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash)
}

adminSchema.statics.hashPassword = async function (plain) {
  return bcrypt.hash(plain, 12)
}

// ── Secret Key (Super Admin only) ─────────────────────────────────────────────
adminSchema.methods.verifySecretKey = async function (plain) {
  if (!this.secretKeyHash) return false
  return bcrypt.compare(plain, this.secretKeyHash)
}

adminSchema.statics.hashSecretKey = async function (plain) {
  return bcrypt.hash(plain, 12)
}

// ── Permission check ──────────────────────────────────────────────────────────
adminSchema.methods.hasPermission = function (perm) {
  if (!this.isActive) return false
  if (this.tier === "super_admin") return true
  return this.permissions.includes(perm)
}

adminSchema.methods.hasAnyPermission = function (...perms) {
  return perms.some(p => this.hasPermission(p))
}

// ── Audit log ─────────────────────────────────────────────────────────────────
adminSchema.methods.log = async function (action, entity = null, entityId = null, meta = {}, req = null) {
  this.auditLog.push({
    action,
    entity,
    entityId,
    by:        this.email,
    ip:        req?.ip || null,
    userAgent: req?.headers?.["user-agent"] || null,
    at:        new Date(),
    meta,
  })
  // Keep last 1000 entries per admin
  if (this.auditLog.length > 1000) this.auditLog = this.auditLog.slice(-1000)
  await this.save()
}

// ── Safe public profile (never expose passwordHash, secretKeyHash) ────────────
adminSchema.methods.toPublic = function () {
  return {
    _id:         this._id.toString(),
    name:        this.name,
    email:       this.email,
    tier:        this.tier,
    role:        this.role,
    permissions: this.permissions,
    isActive:    this.isActive,
    createdBy:   this.createdBy,
    createdAt:   this.createdAt,
    lastLogin:   this.lastLogin,
    suspendedAt: this.suspendedAt,
    suspendedBy: this.suspendedBy,
  }
}

const Admin = mongoose.model("Admin", adminSchema)
export default Admin

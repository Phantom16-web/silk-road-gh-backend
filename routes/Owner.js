import mongoose from "mongoose"
import bcrypt   from "bcryptjs"

const ownerSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },

  // Owner Secret Key — hashed in DB, raw value shown only once at seed time
  secretKeyHash: { type: String, required: true },

  // Emergency keys — each can only be used once, then marked burned
  emergencyKeys: [{
    keyHash:  { type: String, required: true },
    burned:   { type: Boolean, default: false },
    burnedAt: { type: Date,    default: null  },
  }],

  // Recovery codes — 10 one-time codes for password recovery
  recoveryCodes: [{
    codeHash: { type: String, required: true },
    used:     { type: Boolean, default: false },
    usedAt:   { type: Date,    default: null  },
  }],

  // Re-auth token — short-lived, issued after critical action prompt
  reAuthToken:      { type: String,  default: null },
  reAuthTokenExpiry:{ type: Date,    default: null },

  // Audit log — every owner action recorded
  auditLog: [{
    action:    { type: String, required: true },
    ip:        { type: String, default: null  },
    userAgent: { type: String, default: null  },
    at:        { type: Date,   default: Date.now },
    meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
  }],

  lastLogin:   { type: Date,    default: null  },
  lastLoginIp: { type: String,  default: null  },
  createdAt:   { type: Date,    default: Date.now },
}, { timestamps: false })

// ── Password ──────────────────────────────────────────────────────────────────
ownerSchema.methods.verifyPassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash)
}

ownerSchema.statics.hashPassword = async function (plain) {
  return bcrypt.hash(plain, 14)
}

// ── Secret Key ────────────────────────────────────────────────────────────────
ownerSchema.methods.verifySecretKey = async function (plain) {
  return bcrypt.compare(plain, this.secretKeyHash)
}

ownerSchema.statics.hashSecretKey = async function (plain) {
  return bcrypt.hash(plain, 14)
}

// ── Emergency Keys ────────────────────────────────────────────────────────────
// Both keys must be provided simultaneously and both must be unburned
ownerSchema.methods.verifyEmergencyKeys = async function (key1, key2) {
  const unburned = this.emergencyKeys.filter(k => !k.burned)
  if (unburned.length < 2) return false

  // Try to match key1 and key2 against any two unburned slots
  let match1 = null
  let match2 = null

  for (const k of unburned) {
    if (!match1 && await bcrypt.compare(key1, k.keyHash)) { match1 = k; continue }
    if (!match2 && await bcrypt.compare(key2, k.keyHash)) { match2 = k; continue }
  }

  if (!match1 || !match2) return false

  // Burn both keys immediately — one-time use
  match1.burned   = true
  match1.burnedAt = new Date()
  match2.burned   = true
  match2.burnedAt = new Date()
  await this.save()

  return true
}

// ── Recovery codes ────────────────────────────────────────────────────────────
ownerSchema.methods.verifyRecoveryCode = async function (plain) {
  for (const rc of this.recoveryCodes) {
    if (rc.used) continue
    if (await bcrypt.compare(plain, rc.codeHash)) {
      rc.used   = true
      rc.usedAt = new Date()
      await this.save()
      return true
    }
  }
  return false
}

ownerSchema.methods.unusedRecoveryCodeCount = function () {
  return this.recoveryCodes.filter(rc => !rc.used).length
}

// ── Re-auth token ─────────────────────────────────────────────────────────────
ownerSchema.methods.issueReAuthToken = async function () {
  const { randomBytes } = await import("crypto")
  const token = randomBytes(32).toString("hex")
  this.reAuthToken       = token
  this.reAuthTokenExpiry = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
  await this.save()
  return token
}

ownerSchema.methods.verifyReAuthToken = function (token) {
  if (!this.reAuthToken || !this.reAuthTokenExpiry) return false
  if (new Date() > this.reAuthTokenExpiry) return false
  return this.reAuthToken === token
}

ownerSchema.methods.clearReAuthToken = async function () {
  this.reAuthToken       = null
  this.reAuthTokenExpiry = null
  await this.save()
}

// ── Audit log ─────────────────────────────────────────────────────────────────
ownerSchema.methods.log = async function (action, meta = {}, req = null) {
  this.auditLog.push({
    action,
    ip:        req?.ip || null,
    userAgent: req?.headers?.["user-agent"] || null,
    at:        new Date(),
    meta,
  })
  // Keep last 500 entries
  if (this.auditLog.length > 500) this.auditLog = this.auditLog.slice(-500)
  await this.save()
}

const Owner = mongoose.model("Owner", ownerSchema)
export default Owner

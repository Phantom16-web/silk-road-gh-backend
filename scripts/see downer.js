#!/usr/bin/env node
/**
 * Silk Road GH — Owner Seed Script
 *
 * Run this ONCE on your server to create the Owner account:
 *   node scripts/seedOwner.js
 *
 * It will:
 *   1. Generate a random Owner Secret Key
 *   2. Generate two Emergency Keys (one-time use each, both required together)
 *   3. Generate 10 Recovery Codes
 *   4. Create the Owner record in MongoDB
 *   5. Print everything to the console ONE TIME ONLY
 *
 * COPY AND STORE ALL OUTPUT SECURELY BEFORE CLOSING THE TERMINAL.
 * None of these values are recoverable after this script runs.
 *
 * To update the Owner password or rotate keys, run with --reset flag:
 *   node scripts/seedOwner.js --reset
 */

import mongoose  from "mongoose"
import bcrypt    from "bcryptjs"
import crypto    from "crypto"
import dotenv    from "dotenv"
import readline  from "readline"

dotenv.config()

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateKey(bytes = 48) {
  return crypto.randomBytes(bytes).toString("base64url")
}

function generateRecoveryCode() {
  // Format: XXXX-XXXX-XXXX (alphanumeric, easy to read and type)
  const seg = () => crypto.randomBytes(3).toString("hex").toUpperCase()
  return `${seg()}-${seg()}-${seg()}`
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

function printBox(lines) {
  const width  = Math.max(...lines.map(l => l.length)) + 4
  const border = "═".repeat(width)
  console.log(`\n╔${border}╗`)
  lines.forEach(l => {
    const pad = width - l.length - 2
    console.log(`║  ${l}${" ".repeat(pad)}║`)
  })
  console.log(`╚${border}╝\n`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const isReset = process.argv.includes("--reset")

  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not set in .env")
    process.exit(1)
  }

  if (!process.env.OWNER_EMAIL) {
    console.error("❌ OWNER_EMAIL not set in .env — add it first")
    process.exit(1)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log("\n🕸  Silk Road GH — Owner Initialization\n")

  // Prompt for password (not stored in env — entered interactively for security)
  const password = await ask(rl, "Enter Owner password (min 16 chars): ")
  if (password.length < 16) {
    console.error("❌ Password must be at least 16 characters.")
    rl.close(); process.exit(1)
  }

  const confirm = await ask(rl, "Confirm Owner password: ")
  if (password !== confirm) {
    console.error("❌ Passwords do not match.")
    rl.close(); process.exit(1)
  }

  rl.close()

  // Connect to MongoDB
  console.log("\n⏳ Connecting to MongoDB...")
  await mongoose.connect(process.env.MONGODB_URI)
  console.log("✅ Connected\n")

  // Dynamically import Owner model (ES module)
  const { default: Owner } = await import("../models/Owner.js")

  // Check for existing owner
  const existing = await Owner.findOne({ email: process.env.OWNER_EMAIL.toLowerCase() })
  if (existing && !isReset) {
    console.error("❌ Owner account already exists.")
    console.error("   Run with --reset to rotate credentials:")
    console.error("   node scripts/seedOwner.js --reset\n")
    await mongoose.disconnect(); process.exit(1)
  }

  // ── Generate all credentials ───────────────────────────────────────────────
  console.log("⏳ Generating credentials...\n")

  const ownerSecretKey  = generateKey(48)
  const emergencyKey1   = generateKey(48)
  const emergencyKey2   = generateKey(48)
  const recoveryCodes   = Array.from({ length: 10 }, generateRecoveryCode)

  // Hash everything
  const [
    passwordHash,
    secretKeyHash,
    ek1Hash,
    ek2Hash,
    ...rcHashes
  ] = await Promise.all([
    bcrypt.hash(password,      14),
    bcrypt.hash(ownerSecretKey, 14),
    bcrypt.hash(emergencyKey1,  14),
    bcrypt.hash(emergencyKey2,  14),
    ...recoveryCodes.map(c => bcrypt.hash(c, 12)),
  ])

  // ── Save or update Owner record ────────────────────────────────────────────
  if (existing && isReset) {
    existing.passwordHash  = passwordHash
    existing.secretKeyHash = secretKeyHash
    existing.emergencyKeys = [
      { keyHash: ek1Hash, burned: false, burnedAt: null },
      { keyHash: ek2Hash, burned: false, burnedAt: null },
    ]
    existing.recoveryCodes = rcHashes.map(h => ({ codeHash: h, used: false, usedAt: null }))
    existing.reAuthToken        = null
    existing.reAuthTokenExpiry  = null
    await existing.save()
    await existing.log("owner_credentials_reset", { via: "seed_script" })
    console.log("✅ Owner credentials rotated successfully.\n")
  } else {
    const owner = new Owner({
      email:        process.env.OWNER_EMAIL.toLowerCase(),
      passwordHash,
      secretKeyHash,
      emergencyKeys: [
        { keyHash: ek1Hash, burned: false, burnedAt: null },
        { keyHash: ek2Hash, burned: false, burnedAt: null },
      ],
      recoveryCodes: rcHashes.map(h => ({ codeHash: h, used: false, usedAt: null })),
    })
    await owner.save()
    await owner.log("owner_account_created", { via: "seed_script" })
    console.log("✅ Owner account created.\n")
  }

  // ── Print output — shown ONCE, must be saved immediately ──────────────────
  console.log("━".repeat(72))
  console.log("  ⚠️  COPY EVERYTHING BELOW AND STORE IT SECURELY")
  console.log("  ⚠️  THIS WILL NOT BE SHOWN AGAIN")
  console.log("━".repeat(72))

  printBox([
    "OWNER LOGIN CREDENTIALS",
    "",
    `Email:            ${process.env.OWNER_EMAIL.toLowerCase()}`,
    `Password:         (the one you just entered)`,
    `Owner Secret Key: ${ownerSecretKey}`,
  ])

  printBox([
    "EMERGENCY KEYS  —  Both required simultaneously, one-time use each",
    "Once used, run --reset to generate new ones",
    "",
    `Emergency Key 1:  ${emergencyKey1}`,
    `Emergency Key 2:  ${emergencyKey2}`,
  ])

  printBox([
    "RECOVERY CODES  —  One-time use each (10 total)",
    "Use one to regain access if locked out",
    "",
    ...recoveryCodes.map((c, i) => `  ${String(i + 1).padStart(2, "0")}.  ${c}`),
  ])

  console.log("━".repeat(72))
  console.log("  Store the Owner Secret Key and Emergency Keys in your")
  console.log("  password manager or secure vault. Add to Render env vars:")
  console.log("")
  console.log(`  OWNER_EMAIL=${process.env.OWNER_EMAIL.toLowerCase()}`)
  console.log("  (Password is NOT stored in env — entered interactively)")
  console.log("━".repeat(72))
  console.log("")

  await mongoose.disconnect()
  console.log("✅ Done. MongoDB disconnected.\n")
}

main().catch(err => {
  console.error("❌ Seed script failed:", err.message)
  process.exit(1)
})

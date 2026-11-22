// Ghana phone numbers and mobile money networks (server side).
// Accepts 024 123 4567, 0241234567, +233 24 123 4567, 233241234567.
export function normalizeGhPhone(input) {
  const digits = String(input ?? "").replace(/[\s\-().]/g, "")
  const match = /^(?:\+233|233|0)(\d{9})$/.exec(digits)
  if (!match) return { ok: false, local: "", intl: "" }
  return { ok: true, local: "0" + match[1], intl: "+233" + match[1] }
}

// Paystack provider codes: mtn, vod (Telecel), atl (AirtelTigo / AT).
const PREFIXES = {
  mtn: ["24", "25", "53", "54", "55", "59"],
  vod: ["20", "50"],
  atl: ["26", "27", "56", "57"],
}
export const MOMO_PROVIDERS = Object.keys(PREFIXES)

// A best guess from the number prefix. Numbers can be ported, so callers should let the buyer override it.
export function momoProvider(localPhone) {
  const prefix = String(localPhone || "").slice(1, 3)
  return MOMO_PROVIDERS.find(code => PREFIXES[code].includes(prefix)) || null
}

export const maskPhone = local => (local && local.length === 10 ? `${local.slice(0, 3)} ••• ${local.slice(6)}` : "your phone")

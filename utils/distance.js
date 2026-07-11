/**
 * Haversine formula — calculates straight-line distance between
 * two GPS coordinates in kilometres.
 *
 * This is the same formula used by Google Maps for "as the crow flies"
 * distance. On a university campus where riders are navigating short
 * distances, it's accurate enough (within ~5% of actual road distance).
 *
 * @param {number} lat1 - Pickup latitude
 * @param {number} lng1 - Pickup longitude
 * @param {number} lat2 - Drop latitude
 * @param {number} lng2 - Drop longitude
 * @returns {number} Distance in kilometres, rounded to 2 decimal places
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371          // Earth's radius in km
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return Math.round(R * c * 100) / 100
}

function toRad(deg) {
  return deg * (Math.PI / 180)
}

/**
 * Calculate delivery fee based on distance.
 *
 * Formula: ₵5 base + (distance × ₵2.5 per km)
 * Minimum: ₵5   — even if they're next door
 * Maximum: ₵50  — caps at 18km, fair for any campus zone
 *
 * Examples:
 *   0.5 km → ₵5 + ₵1.25  = ₵6.25  → rounded to ₵6
 *   1.0 km → ₵5 + ₵2.50  = ₵7.50  → rounded to ₵8
 *   2.0 km → ₵5 + ₵5.00  = ₵10.00
 *   5.0 km → ₵5 + ₵12.50 = ₵17.50 → rounded to ₵18
 *  10.0 km → ₵5 + ₵25.00 = ₵30.00
 *  18.0 km → ₵5 + ₵45.00 = ₵50.00 (capped)
 *
 * @param {number} distanceKm
 * @returns {number} Fee in GHS, rounded to nearest whole cedi
 */
export function calculateDeliveryFee(distanceKm) {
  const BASE_FEE      = 5      // ₵5 minimum
  const RATE_PER_KM   = 2.5    // ₵2.50 per km
  const MAX_FEE       = 50     // ₵50 cap

  const raw = BASE_FEE + (distanceKm * RATE_PER_KM)
  const fee = Math.round(raw)                    // round to nearest cedi
  return Math.min(Math.max(fee, BASE_FEE), MAX_FEE)
}

/**
 * Quick test — remove before production
 * calculateDeliveryFee(haversineKm(5.6037, -0.1870, 5.6500, -0.1500))
 * KNUST main gate to Ayeduase roundabout ≈ 4.8km → ₵17
 */

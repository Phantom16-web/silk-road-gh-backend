import RentalReservation from "../models/RentalReservation.js";

/** Only unclaimed, orderless holds are safe to reclaim without payment-provider evidence.
 * Payment-linked holds are intentionally excluded, even after the one-hour deadline.
 * Returns a count for monitoring; call from an authenticated admin job or a scheduled worker.
 */
export async function reclaimUnclaimedRentalHolds({ now = new Date(), batchSize = 100 } = {}) {
  const limit = Math.min(500, Math.max(1, Number(batchSize) || 100));
  const candidates = await RentalReservation.find({
    state: "reserved", order: null, expiresAt: { $lte: now }
  }).select("_id").sort({ expiresAt: 1 }).limit(limit).lean();
  let reclaimed = 0;
  for (const candidate of candidates) {
    const result = await RentalReservation.deleteOne({
      _id: candidate._id, state: "reserved", order: null, expiresAt: { $lte: now }
    });
    reclaimed += result.deletedCount;
  }
  return { examined: candidates.length, reclaimed, heldForReview: 0 };
}

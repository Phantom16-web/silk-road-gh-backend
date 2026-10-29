import RentalReservation from '../models/RentalReservation.js';

// An expired payment-linked hold must NOT be deleted or offered to another renter.
// Reclassifying it releases the renter-level unpaid-hold limit, but the unique
// listing reservation stays in place pending provider verification/refund.
export async function quarantineExpiredRentalPayments(renter, { now = new Date(), limit = 25 } = {}) {
  const candidates = await RentalReservation.find({
    renter, state: 'payment_pending', order: { $ne: null }, expiresAt: { $lte: now }
  }).select('_id').limit(limit).lean();
  let quarantined = 0;
  for (const candidate of candidates) {
    const result = await RentalReservation.updateOne({
      _id: candidate._id, renter, state: 'payment_pending',
      order: { $ne: null }, expiresAt: { $lte: now }
    }, { $set: { state: 'reconciliation_required' } });
    quarantined += result.modifiedCount;
  }
  return { quarantined };
}

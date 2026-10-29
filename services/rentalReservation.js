import RentalReservation from "../models/RentalReservation.js";
import RentalBooking from "../models/RentalBooking.js";
import RentalItemLock from "../models/RentalItemLock.js";

export async function reclaimExpiredReservation(listing, session = null) {
 const now = new Date();
 // Never clear a reservation after payment or activation, even if its timer expires.
 const query = RentalReservation.deleteOne({ listing, state: "reserved", order: null, expiresAt: { $lte: now } });
 if (session) query.session(session);
 await query;
}
export async function assertRentalReservationForOrder(order) {
 if (order?.type !== "rent") return;
 const reservation = await RentalReservation.findOne({ order: order._id });
 if (!reservation || !["payment_pending", "reconciliation_required", "paid", "activated"].includes(reservation.state) ||
  (reservation.state === "payment_pending" && reservation.expiresAt <= new Date()) ||
  String(reservation.listing) !== String(order.listing) || String(reservation.renter) !== String(order.buyer) ||
  reservation.environment !== order.environment) {
  const e = new Error("Rental reservation is missing, expired, or mismatched. Payment blocked."); e.status=409; throw e;
 }
}
export async function assertRentalSettlementNotDisputed(order) {
 if (order?.type !== "rent") return;
 const booking = await RentalBooking.findOne({order: order._id});
 if (!booking || booking.status !== "returned" || booking.disputeOpenedAt || await RentalItemLock.exists({booking:booking._id})) {
  const e = new Error("Rental has not been safely returned and cleared for settlement."); e.status=409; throw e;
 }
}

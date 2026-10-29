import RentalBooking from "../models/RentalBooking.js";
import RentalItemLock from "../models/RentalItemLock.js";
import RentalReservation from "../models/RentalReservation.js";

// Conservative, fail-closed payout gate. This does not replace refund or provider reconciliation.
export async function assertRentalSettlementReady(order, session = null) {
  if (order?.type !== "rent") return;
  const bookingQuery = RentalBooking.findOne({ order: order._id });
  const reservationQuery = RentalReservation.findOne({ order: order._id });
  if (session) { bookingQuery.session(session); reservationQuery.session(session); }
  const [booking, reservation] = await Promise.all([bookingQuery, reservationQuery]);
  let activeLock = true;
  if (booking) {
    const lockQuery = RentalItemLock.exists({ booking: booking._id });
    if (session) lockQuery.session(session);
    activeLock = Boolean(await lockQuery);
  }
  if (!booking || booking.status !== "returned" || booking.disputeOpenedAt || activeLock || reservation?.state === "activated") {
    const error = new Error("Rental return, inventory lock, or dispute is unresolved. Payout blocked.");
    error.status = 409;
    throw error;
  }
}

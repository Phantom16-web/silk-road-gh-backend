import RentalReservation from "../models/RentalReservation.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";

/** Read-only audit. Never free an order-bound reservation without checking the provider and all payment channels. */
export async function auditAbandonedRentalReservations({ now = new Date(), limit = 100 } = {}) {
  const reservations = await RentalReservation.find({ expiresAt: { $lte: now }, state: { $in: ["reserved", "payment_pending"] } })
    .sort({ expiresAt: 1 }).limit(Math.min(500, Math.max(1, Number(limit) || 100))).lean();
  const report = [];
  for (const reservation of reservations) {
    if (!reservation.order && reservation.state === "reserved") {
      report.push({ reservationId: String(reservation._id), action: "eligible_for_unclaimed_reclaim", environment: reservation.environment });
      continue;
    }
    if (!reservation.order) {
      report.push({ reservationId: String(reservation._id), action: "quarantine_missing_order_link" });
      continue;
    }
    const order = await Order.findById(reservation.order).select("paymentStatus cancelled environment paystackRef paymentMethod isSimulatedPayment").lean();
    const payments = await Payment.find({ order: reservation.order }).select("status provider providerReference method").lean();
    const hasAttempt = payments.length > 0 || Boolean(order?.paystackRef);
    const settled = Boolean(order && ["escrow_held", "release_pending", "released", "refund_pending", "disputed"].includes(order.paymentStatus));
    report.push({ reservationId: String(reservation._id), orderId: String(reservation.order), action: !order ? "quarantine_missing_order" : settled ? "retain_funds_or_dispute" : hasAttempt ? "verify_provider_before_any_release" : "review_unpaid_order_before_release", environment: reservation.environment, paymentStatus: order?.paymentStatus ?? "missing", attemptCount: payments.length });
  }
  return report;
}

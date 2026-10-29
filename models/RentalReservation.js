import mongoose from "mongoose";
// A unique listing lock is the authoritative reservation. TTL cleanup is NOT used for
// correctness: MongoDB TTL deletion is asynchronous and cannot free a unique index on time.
const schema = new mongoose.Schema({
 listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true, unique: true },
 renter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
 environment: { type: String, enum: ["testing", "live"], required: true },
 expiresAt: { type: Date, required: true },
 order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
 state: { type: String, enum: ["reserved", "payment_pending", "reconciliation_required", "paid", "activated"], default: "reserved" },
}, { timestamps: true });
schema.index({ expiresAt: 1 });
// Prevent a renter from blocking multiple listings with unpaid holds.
// Paid/activated bookings are excluded so completed transactions do not block new rentals.
schema.index({ renter: 1 }, {
  unique: true,
  name: "one_unpaid_rental_per_renter",
  partialFilterExpression: { state: { $in: ["reserved", "payment_pending"] } },
});
export default mongoose.models.RentalReservation || mongoose.model("RentalReservation", schema);

import mongoose from "mongoose";

// Rental handover/return ledger. This model NEVER executes or authorizes payouts.
const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
  renter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  rentalDays: { type: Number, required: true, min: 1 },
  rentalAmount: { type: Number, required: true, min: 0 },
  accountabilityAccepted: { type: Boolean, required: true },
  accountabilityAcceptedAt: { type: Date, required: true },
  accountabilityTermsVersion: { type: String, default: "v1" },
  status: { type: String, enum: ["awaiting_handover", "handed_over", "in_use", "return_requested", "returned", "disputed"], default: "awaiting_handover", index: true },
  handoverAt: Date, receivedAt: Date, dueAt: Date, returnRequestedAt: Date, returnedAt: Date,
  disputeReason: { type: String, default: "" }, disputeOpenedAt: Date,
  history: [{ action: String, actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, at: { type: Date, default: Date.now } }],
}, { timestamps: true });
schema.index({ listing: 1, status: 1 });
export default mongoose.models.RentalBooking || mongoose.model("RentalBooking", schema);

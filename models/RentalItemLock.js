import mongoose from "mongoose";

// One physical listing may have only one active rental. Unique index is essential.
const schema = new mongoose.Schema({
  listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true, unique: true },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: "RentalBooking", required: true, unique: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
}, { timestamps: true });
export default mongoose.models.RentalItemLock || mongoose.model("RentalItemLock", schema);

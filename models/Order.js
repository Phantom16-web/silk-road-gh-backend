import mongoose from "mongoose"

const orderSchema = new mongoose.Schema({
  buyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
  type: { type: String, enum: ["product", "rent", "service"], required: true },
  amount: { type: Number, required: true },
  platformFee: { type: Number, required: true },
  sellerAmount: { type: Number, required: true },
  paystackRef: { type: String },
  status: { type: String, enum: ["Pending", "In Escrow", "Completed", "Refunded", "Cancelled"], default: "Pending" },
  location: { type: String },
  landmark: { type: String },
  extraInfo: { type: String },
  contactInfo: { type: String },

  // Rent specific
  rentalDays: { type: Number },
  renterConfirmed: { type: Boolean, default: false },
  lenderConfirmed: { type: Boolean, default: false },
  damaged: { type: Boolean, default: false },

  // Service specific
  scheduledDate: { type: String },
  scheduledTime: { type: String },
  sessionStarted: { type: Boolean, default: false },
  sessionEnded: { type: Boolean, default: false },
  cancelled: { type: Boolean, default: false },
}, { timestamps: true })

export default mongoose.model("Order", orderSchema)
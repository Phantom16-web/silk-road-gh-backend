import mongoose from "mongoose"

const listingSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["product", "rent", "service"], required: true },
  title: { type: String, required: true },
  desc: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number },
  condition: { type: String },
  delivery: [{ type: String }],
  image: { type: String, required: true },
  imagePublicId: { type: String },

  // Rent specific
  dailyRate: { type: Number },
  maxDays: { type: Number },
  accountability: { type: Boolean, default: false },
  accountabilityPct: { type: Number },

  // Service specific
  serviceDelivery: { type: String, enum: ["online", "in-person"] },
  liveSession: { type: Boolean, default: false },
  contactMethod: { type: String },
  contactDetail: { type: String },
  contactNote: { type: String },

  status: { type: String, enum: ["Active", "Flagged", "Removed"], default: "Active" },
  rating: { type: Number, default: 0 },
  reviews: { type: Number, default: 0 },
}, { timestamps: true })

export default mongoose.model("Listing", listingSchema)
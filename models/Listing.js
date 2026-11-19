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

  // Search: normalized campus key of the seller (e.g. "ucc"), copied from the
  // seller's university when the listing is created and re-synced at startup.
  // Lets search filter and boost by campus without a $lookup on every query.
  // Always derived via utils/university.js, never typed by users.
  universityKey: { type: String, default: "", index: false },
}, { timestamps: true })

// Search Phase 3: indexes supporting public catalogue filters and stable pagination.
listingSchema.index({ status: 1, type: 1, createdAt: -1 });
listingSchema.index({ status: 1, type: 1, category: 1, createdAt: -1 });
listingSchema.index({ status: 1, type: 1, price: 1 });
listingSchema.index({ status: 1, type: 1, dailyRate: 1 });

// Search Phase 4: campus filter used by the regex fallback path.
listingSchema.index({ status: 1, universityKey: 1, createdAt: -1 });

export default mongoose.model("Listing", listingSchema)

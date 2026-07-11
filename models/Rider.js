import mongoose from "mongoose"
import bcrypt   from "bcryptjs"

const riderSchema = new mongoose.Schema({
  name:       { type: String, required: true, trim: true },
  phone:      { type: String, required: true, unique: true, trim: true },
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   { type: String, required: true },
  university: { type: String, default: "" },

  vehicle: {
    type: String,
    enum: ["motorbike", "bicycle", "walking"],
    default: "motorbike",
  },

  // Current location — updated by rider app periodically
  currentLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    updatedAt: { type: Date, default: null },
  },

  isOnline:    { type: Boolean, default: false },
  isApproved:  { type: Boolean, default: true }, // auto-approve for now
  isActive:    { type: Boolean, default: true },

  // Earnings
  totalEarned:    { type: Number, default: 0 },
  totalDeliveries:{ type: Number, default: 0 },
  rating:         { type: Number, default: 0 },
  ratingCount:    { type: Number, default: 0 },

  // Active delivery — only one at a time
  activeDelivery: { type: mongoose.Schema.Types.ObjectId, ref: "Delivery", default: null },

}, { timestamps: true })

// Hash password before save
riderSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next()
  this.password = await bcrypt.hash(this.password, 10)
  next()
})

riderSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password)
}

export default mongoose.model("Rider", riderSchema)

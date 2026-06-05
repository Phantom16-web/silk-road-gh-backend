import mongoose from "mongoose"

const riderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  baseArea: { type: String, required: true },
  vehicle: { type: String, required: true },
  zones: [{ type: String }],
  availFrom: { type: String },
  availTo: { type: String },
  photo: { type: String },
  status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
  deliveries: { type: Number, default: 0 },
}, { timestamps: true })

export default mongoose.model("Rider", riderSchema)
import mongoose from "mongoose"

const deliverySchema = new mongoose.Schema({
  order:           { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  seller:          { type: mongoose.Schema.Types.ObjectId, ref: "User",  required: true },
  buyer:           { type: mongoose.Schema.Types.ObjectId, ref: "User",  default: null },
  rider:           { type: mongoose.Schema.Types.ObjectId, ref: "Rider", default: null },

  // Locations
  pickupLocation:  {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: "" },
  },
  dropLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: "" },
  },

  // Contacts
  sellerContact:   { type: String, default: "" },
  buyerContact:    { type: String, default: "" },

  // Pricing
  distanceKm:      { type: Number, required: true },
  deliveryFee:     { type: Number, required: true },

  // OTP — generated when rider marks as delivered
  otp:             { type: String, default: null },
  otpExpiresAt:    { type: Date,   default: null },
  otpVerified:     { type: Boolean, default: false },

  // Status flow:
  // pending → accepted → picked_up → delivered → completed
  // pending → declined (rider declined, goes back to job board)
  // pending → cancelled (seller cancelled)
  status: {
    type: String,
    enum: ["pending", "accepted", "picked_up", "delivered", "completed", "declined", "cancelled"],
    default: "pending",
  },

  // Timestamps for each status change
  acceptedAt:      { type: Date, default: null },
  pickedUpAt:      { type: Date, default: null },
  deliveredAt:     { type: Date, default: null },
  completedAt:     { type: Date, default: null },

  // Who is delivering — rider or seller themselves
  deliveryType:    {
    type: String,
    enum: ["rider", "self"],
    default: "rider",
  },

  itemTitle:       { type: String, default: "" },
  itemImage:       { type: String, default: "" },
  notes:           { type: String, default: "" },

}, { timestamps: true })

export default mongoose.model("Delivery", deliverySchema)

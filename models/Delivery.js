import mongoose from "mongoose"

const deliverySchema = new mongoose.Schema({
  order: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "Order",
    required: false,   // guest buyers have no backend order ID
    default:  null,
  },
  seller: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "User",
    required: true,
  },
  buyer: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "User",
    default:  null,
  },
  rider: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     "Rider",
    default: null,
  },

  pickupLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: "" },
  },
  dropLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: "" },
  },

  sellerContact: { type: String, default: "" },
  buyerContact:  { type: String, default: "" },

  distanceKm:  { type: Number, required: true },
  deliveryFee: { type: Number, required: true },

  // OTP generated when rider/seller marks as delivered
  // Buyer sees this on their screen and reads it to the deliverer
  otp:          { type: String,  default: null },
  otpExpiresAt: { type: Date,    default: null },
  otpVerified:  { type: Boolean, default: false },

  // Status flow:
  // pending → accepted → picked_up → delivered → completed
  // pending → cancelled
  status: {
    type:    String,
    enum:    ["pending", "accepted", "picked_up", "delivered", "completed", "declined", "cancelled"],
    default: "pending",
  },

  acceptedAt:  { type: Date, default: null },
  pickedUpAt:  { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },

  deliveryType: {
    type:    String,
    enum:    ["rider", "self"],
    default: "rider",
  },

  itemTitle: { type: String, default: "" },
  itemImage: { type: String, default: "" },
  notes:     { type: String, default: "" },

  // Store the local SR- order ID for reference when no MongoDB order exists
  localOrderId: { type: String, default: null },

}, { timestamps: true })

export default mongoose.model("Delivery", deliverySchema)

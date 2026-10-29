import mongoose from "mongoose"

const locationSchema = new mongoose.Schema({
  lat: { type: Number, required: true, min: -90, max: 90 },
  lng: { type: Number, required: true, min: -180, max: 180 },
  address: { type: String, default: "", maxlength: 300 },
}, { _id: false })

const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
  checkoutId: { type: String, ref: "CheckoutGroup", required: true, index: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  fundingSource: { type: String, enum: ["earnings", "separate"], required: true },
  quotedFee: { type: Number, required: true, min: 0 },
  distanceKm: { type: Number, required: true, min: 0 },
  pickupLocation: { type: locationSchema, required: true },
  dropLocation: { type: locationSchema, required: true },
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: "Delivery", default: null },
  status: { type: String, enum: [
    "reserved", "awaiting_payment", "payment_submitted", "funded",
    "dispatched", "delivery_confirmed", "rider_paid", "cancelled",
  ], default: "reserved", index: true },
  paymentReference: { type: String, default: null },
}, { timestamps: true })

schema.index({ checkoutId: 1, seller: 1 })
schema.index({ deliveryId: 1 }, { unique: true, partialFilterExpression: { deliveryId: { $type: "objectId" } } })
export default mongoose.models.RiderFundingChoice || mongoose.model("RiderFundingChoice", schema)

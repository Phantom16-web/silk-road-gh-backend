import mongoose from "mongoose"

const orderSchema = new mongoose.Schema(
  {
    buyer:           { type: mongoose.Schema.Types.ObjectId, ref: "User",    default: null },
    seller:          { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true },
    listing:         { type: mongoose.Schema.Types.ObjectId, ref: "Listing", default: null },
    localOrderId:    { type: String,  default: null },
    type:            { type: String,  default: "product" },
    amount:          { type: Number,  required: true },
    platformFee:     { type: Number,  default: 0 },
    sellerAmount:    { type: Number,  default: 0 },
    paystackRef:     { type: String,  default: null },
    location:        { type: String,  default: null },
    landmark:        { type: String,  default: null },
    extraInfo:       { type: String,  default: null },
    contactInfo:     { type: String,  default: null },
    payerName:       { type: String,  default: null },
    payerPhone:      { type: String,  default: null },
    promoCode:       { type: String,  default: null },
    discount:        { type: Number,  default: 0 },
    deliveryMethod:  { type: String,  default: "pickup" },
    paymentMethod:   { type: String,  default: "manual_momo" },
    status:          { type: String,  default: "In Escrow" },
    cancelled:       { type: Boolean, default: false },
    renterConfirmed: { type: Boolean, default: false },
    lenderConfirmed: { type: Boolean, default: false },
    rentalDays:      { type: Number,  default: null },
  },
  { timestamps: true }
)

export default mongoose.models.Order || mongoose.model("Order", orderSchema)

import mongoose from "mongoose"

const orderSchema = new mongoose.Schema(
  {
    // ───────────────────────────────────────────────────────────────────────
    // PARTIES
    // ───────────────────────────────────────────────────────────────────────

    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
      default: null,
    },

    // Public/reference ID used by the frontend and customers.
    localOrderId: {
      type: String,
      default: null,
      index: true,
    },

    type: {
      type: String,
      default: "product",
    },

    // ───────────────────────────────────────────────────────────────────────
    // FINANCIAL AMOUNTS
    // ───────────────────────────────────────────────────────────────────────

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    platformFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    sellerAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    discount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ───────────────────────────────────────────────────────────────────────
    // PAYMENT
    // ───────────────────────────────────────────────────────────────────────
    //
    // IMPORTANT:
    //
    // paymentMethod tells us HOW the buyer intends to pay.
    //
    // paymentStatus tells us WHERE the money currently stands.
    //
    // These are deliberately separate.
    //
    // Paystack is therefore NOT the transaction engine.
    // It is simply one payment provider.
    // ───────────────────────────────────────────────────────────────────────

    paymentMethod: {
      type: String,
      enum: ["manual_momo", "paystack"],
      default: "manual_momo",
    },

    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "escrow_held",
        "release_pending",
        "released",
        "failed",
        "refund_pending",
        "refunded",
        "disputed",
      ],
      default: "pending",
      index: true,
    },

    /*
     * Paystack reference.
     *
     * Kept on Order for compatibility and convenient lookup.
     *
     * The Payment model is the more complete payment record.
     */
    paystackRef: {
      type: String,
      default: null,
    },

    /*
     * When Silk Road has independently verified that the payment
     * has actually been received/validated.
     */
    paymentVerifiedAt: {
      type: Date,
      default: null,
    },

    /*
     * When Silk Road's accounting/release process actually
     * releases funds.
     */
    releasedAt: {
      type: Date,
      default: null,
    },

    /*
     * When the order's refund is actually completed.
     */
    refundedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────────────────────────────────────────────────────────
    // FULFILLMENT
    // ───────────────────────────────────────────────────────────────────────
    //
    // This is deliberately independent of paymentStatus.
    //
    // Example:
    //
    // paymentStatus     = escrow_held
    // fulfillmentStatus = awaiting_delivery
    //
    // Later:
    //
    // paymentStatus     = release_pending
    // fulfillmentStatus = completed
    //
    // ───────────────────────────────────────────────────────────────────────

    fulfillmentStatus: {
      type: String,
      enum: [
        "pending_payment",
        "paid",
        "awaiting_delivery",
        "delivery_in_progress",
        "delivered_pending_otp",
        "completed",
        "cancelled",
        "disputed",
      ],
      default: "pending_payment",
      index: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    // ───────────────────────────────────────────────────────────────────────
    // DELIVERY / BUYER INFORMATION
    // ───────────────────────────────────────────────────────────────────────

    location: {
      type: String,
      default: null,
    },

    landmark: {
      type: String,
      default: null,
    },

    extraInfo: {
      type: String,
      default: null,
    },

    contactInfo: {
      type: String,
      default: null,
    },

    payerName: {
      type: String,
      default: null,
    },

    payerPhone: {
      type: String,
      default: null,
    },

    deliveryMethod: {
      type: String,
      default: "pickup",
    },

    // ───────────────────────────────────────────────────────────────────────
    // PROMOTIONS
    // ───────────────────────────────────────────────────────────────────────

    promoCode: {
      type: String,
      default: null,
    },

    // ───────────────────────────────────────────────────────────────────────
    // LEGACY COMPATIBILITY
    // ───────────────────────────────────────────────────────────────────────
    //
    // We are NOT deleting these yet.
    //
    // Existing routes/frontend code may still reference them.
    // We'll migrate those routes in the next stage and then remove
    // the legacy fields once nothing depends on them.
    // ───────────────────────────────────────────────────────────────────────

    status: {
      type: String,
      default: "Pending Confirmation",
    },

    cancelled: {
      type: Boolean,
      default: false,
    },

    renterConfirmed: {
      type: Boolean,
      default: false,
    },

    lenderConfirmed: {
      type: Boolean,
      default: false,
    },

    rentalDays: {
      type: Number,
      default: null,
    },
  },

  {
    timestamps: true,
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

orderSchema.index({
  buyer: 1,
  createdAt: -1,
})

orderSchema.index({
  seller: 1,
  createdAt: -1,
})

orderSchema.index({
  paymentStatus: 1,
  fulfillmentStatus: 1,
})

export default mongoose.models.Order ||
  mongoose.model("Order", orderSchema)


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
    // ENVIRONMENT — TESTING / LIVE
    // ───────────────────────────────────────────────────────────────────────
    //
    // Every new order must be assigned an environment by the backend
    // when the order is created.
    //
    // Never accept the environment directly from the buyer's request.
    //
    // Existing orders without this field are treated as Live orders.
    //
    // This field must never be changed after creation.
    // ───────────────────────────────────────────────────────────────────────

    environment: {
      type: String,
      enum: ["testing", "live"],
      default: "live",
      required: true,
      immutable: true,
      index: true,
    },

    // Identifies whether the payment is simulated.
    //
    // A simulated payment is not actual money held by Silk Road.
    //
    // This flag is informational. Financial operations must also
    // check the order's environment on the backend.
    isSimulatedPayment: {
      type: Boolean,
      default: false,
    },

    // When a simulated payment was confirmed.
    simulatedPaymentAt: {
      type: Date,
      default: null,
    },

    // Owner account responsible for simulating the payment.
    simulatedPaymentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Owner",
      default: null,
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
    // paymentMethod tells us HOW the buyer intends to pay.
    //
    // paymentStatus tells us WHERE the transaction stands.
    //
    // These are deliberately separate.
    //
    // Paystack is not the transaction engine.
    // It is one payment provider.
    //
    // For simulated orders, escrow_held is a TEST state only.
    // It must never be counted as actual escrow funds.
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
     *
     * This must remain null for simulated payments.
     */
    paymentVerifiedAt: {
      type: Date,
      default: null,
    },

    /*
     * When Silk Road's accounting/release process actually
     * releases funds.
     *
     * Simulated orders must never trigger real payouts.
     */
    releasedAt: {
      type: Date,
      default: null,
    },

    /*
     * When the order's refund is actually completed.
     *
     * Simulated refunds must never trigger real transfers.
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
    // These fields are preserved because existing routes and
    // frontend code may still reference them.
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

// Efficiently separate real and simulated transactions.
orderSchema.index({
  environment: 1,
  paymentStatus: 1,
  createdAt: -1,
})

// Prevent accidentally changing an order's environment through save().
orderSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified("environment")) {
    return next(
      new Error(
        "An order's environment cannot be changed after creation."
      )
    )
  }

  next()
})

export default mongoose.models.Order ||
  mongoose.model("Order", orderSchema)

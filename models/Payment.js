import mongoose from "mongoose"

const paymentSchema = new mongoose.Schema(
  {
    // ─────────────────────────────────────────────────────────────────────────
    // ORDER
    // ─────────────────────────────────────────────────────────────────────────

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },

    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // PAYMENT ROUTING
    //
    // method = what the buyer selected
    // provider = system responsible for processing it
    //
    // Silk Road owns the transaction.
    // Paystack is only one provider.
    // ─────────────────────────────────────────────────────────────────────────

    method: {
      type: String,
      enum: [
        "manual_momo",
        "paystack",
      ],
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: [
        "manual",
        "paystack",
      ],
      required: true,
      index: true,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // PAYMENT STATE
    //
    // pending
    //     Payment initiated but not verified.
    //
    // submitted
    //     Manual payment proof submitted.
    //
    // under_review
    //     Manual payment is being reviewed.
    //
    // verified
    //     Provider/manual verification succeeded.
    //
    // failed
    //     Payment attempt failed.
    //
    // refunded
    //     Actual refund completed.
    // ─────────────────────────────────────────────────────────────────────────

    status: {
      type: String,

      enum: [
        "pending",
        "submitted",
        "under_review",
        "verified",
        "failed",
        "refunded",
      ],

      default: "pending",

      index: true,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MONEY
    // ─────────────────────────────────────────────────────────────────────────

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      default: "GHS",
      uppercase: true,
      trim: true,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // PROVIDER REFERENCES
    // ─────────────────────────────────────────────────────────────────────────

    providerReference: {
      type: String,
      default: null,
      index: true,
      sparse: true,
      trim: true,
    },

    /*
     * Paystack reference is stored here through providerReference.
     *
     * Manual payments can also have an internally generated reference.
     */

    buyerReference: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MANUAL PAYMENT EVIDENCE
    // ─────────────────────────────────────────────────────────────────────────

    evidenceUrl: {
      type: String,
      default: null,
      trim: true,
    },

    notes: {
      type: String,
      default: null,
      maxlength: 2000,
      trim: true,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // VERIFICATION
    // ─────────────────────────────────────────────────────────────────────────

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // REFUND
    // ─────────────────────────────────────────────────────────────────────────

    refundRequestedAt: {
      type: Date,
      default: null,
    },

    refundRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    refundReference: {
      type: String,
      default: null,
      trim: true,
    },

    refundReason: {
      type: String,
      default: null,
      maxlength: 2000,
      trim: true,
    },

    refundedAt: {
      type: Date,
      default: null,
    },

    refundedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // PROVIDER RAW DATA
    //
    // Optional.
    //
    // Useful later for Paystack reconciliation/debugging.
    // Do NOT put sensitive secrets here.
    // ─────────────────────────────────────────────────────────────────────────

    providerData: {
      type: mongoose.Schema.Types.Mixed,
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

paymentSchema.index({
  order: 1,
  status: 1,
})

paymentSchema.index({
  provider: 1,
  providerReference: 1,
})

paymentSchema.index({
  buyer: 1,
  createdAt: -1,
})

paymentSchema.index({
  status: 1,
  createdAt: -1,
})

// ─────────────────────────────────────────────────────────────────────────────
// MODEL
// ─────────────────────────────────────────────────────────────────────────────

export default mongoose.models.Payment ||
  mongoose.model(
    "Payment",
    paymentSchema
  )

import mongoose from "mongoose"

const paymentSchema = new mongoose.Schema(
  {
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

    method: {
      type: String,
      enum: ["manual_momo", "paystack"],
      required: true,
    },

    provider: {
      type: String,
      enum: ["manual", "paystack"],
      required: true,
    },

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

    providerReference: {
      type: String,
      default: null,
      index: true,
      sparse: true,
    },

    buyerReference: {
      type: String,
      default: null,
      trim: true,
    },

    evidenceUrl: {
      type: String,
      default: null,
    },

    notes: {
      type: String,
      default: null,
      maxlength: 2000,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
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

    refundedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

paymentSchema.index({ order: 1, status: 1 })
paymentSchema.index({ provider: 1, providerReference: 1 })

export default mongoose.models.Payment ||
  mongoose.model("Payment", paymentSchema)

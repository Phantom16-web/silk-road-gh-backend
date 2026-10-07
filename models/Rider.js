import mongoose from "mongoose"
import bcrypt from "bcryptjs"

const riderSchema = new mongoose.Schema(
  {
    // ─────────────────────────────────────────────────────────────────────────
    // IDENTITY
    // ─────────────────────────────────────────────────────────────────────────

    name: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    university: {
      type: String,
      default: "",
    },

    // ─────────────────────────────────────────────────────────────────────────
    // VEHICLE
    // ─────────────────────────────────────────────────────────────────────────

    vehicle: {
      type: String,

      enum: [
        "motorbike",
        "bicycle",
        "walking",
      ],

      default: "motorbike",
    },

    // ─────────────────────────────────────────────────────────────────────────
    // LOCATION
    // ─────────────────────────────────────────────────────────────────────────

    currentLocation: {
      lat: {
        type: Number,
        default: null,
      },

      lng: {
        type: Number,
        default: null,
      },

      updatedAt: {
        type: Date,
        default: null,
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STATUS
    // ─────────────────────────────────────────────────────────────────────────

    isOnline: {
      type: Boolean,
      default: false,
    },

    isApproved: {
      type: Boolean,
      default: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EARNINGS
    //
    // pendingEarnings:
    //     Completed delivery fees awaiting settlement.
    //
    // totalEarned:
    //     Historical amount actually settled to this rider.
    //
    // totalPaid:
    //     Explicit payout amount recorded by Silk Road.
    //
    // These are deliberately separate.
    // ─────────────────────────────────────────────────────────────────────────

    pendingEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalPaid: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalDeliveries: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RATING
    // ─────────────────────────────────────────────────────────────────────────

    rating: {
      type: Number,
      default: 0,
      min: 0,
    },

    ratingCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ACTIVE DELIVERY
    // ─────────────────────────────────────────────────────────────────────────

    activeDelivery: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD HASH
// ─────────────────────────────────────────────────────────────────────────────

riderSchema.pre(
  "save",
  async function (next) {
    if (
      !this.isModified(
        "password"
      )
    ) {
      return next()
    }

    this.password =
      await bcrypt.hash(
        this.password,
        10
      )

    next()
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD CHECK
// ─────────────────────────────────────────────────────────────────────────────

riderSchema.methods.matchPassword =
  async function (entered) {
    return bcrypt.compare(
      entered,
      this.password
    )
  }

export default
  mongoose.models.Rider ||
  mongoose.model(
    "Rider",
    riderSchema
  )

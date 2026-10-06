import mongoose from "mongoose"

const deliverySchema =
  new mongoose.Schema(
    {
      // ─────────────────────────────────────────────────────────────────────
      // ORDER
      // ─────────────────────────────────────────────────────────────────────

      order: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: "Order",

        required: false,

        default: null,

        index: true,
      },

      localOrderId: {
        type: String,

        default: null,

        index: true,
      },

      // ─────────────────────────────────────────────────────────────────────
      // PARTIES
      // ─────────────────────────────────────────────────────────────────────

      seller: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: "User",

        required: true,

        index: true,
      },

      buyer: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: "User",

        default: null,

        index: true,
      },

      rider: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: "Rider",

        default: null,

        index: true,
      },

      // ─────────────────────────────────────────────────────────────────────
      // LOCATIONS
      // ─────────────────────────────────────────────────────────────────────

      pickupLocation: {
        lat: {
          type: Number,
          required: true,
        },

        lng: {
          type: Number,
          required: true,
        },

        address: {
          type: String,
          default: "",
        },
      },

      dropLocation: {
        lat: {
          type: Number,
          required: true,
        },

        lng: {
          type: Number,
          required: true,
        },

        address: {
          type: String,
          default: "",
        },
      },

      // ─────────────────────────────────────────────────────────────────────
      // CONTACT
      // ─────────────────────────────────────────────────────────────────────

      sellerContact: {
        type: String,
        default: "",
      },

      buyerContact: {
        type: String,
        default: "",
      },

      // ─────────────────────────────────────────────────────────────────────
      // DELIVERY MONEY
      // ─────────────────────────────────────────────────────────────────────

      distanceKm: {
        type: Number,
        required: true,
        min: 0,
      },

      deliveryFee: {
        type: Number,
        required: true,
        min: 0,
      },

      // ─────────────────────────────────────────────────────────────────────
      // OTP
      // ─────────────────────────────────────────────────────────────────────

      otp: {
        type: String,
        default: null,
      },

      otpExpiresAt: {
        type: Date,
        default: null,
      },

      otpVerified: {
        type: Boolean,
        default: false,
      },

      otpAttempts: {
        type: Number,
        default: 0,
      },

      // Prevent unlimited guessing.
      otpLocked: {
        type: Boolean,
        default: false,
      },

      // ─────────────────────────────────────────────────────────────────────
      // STATUS
      // ─────────────────────────────────────────────────────────────────────

      status: {
        type: String,

        enum: [
          "pending",
          "accepted",
          "picked_up",
          "delivered",
          "completed",
          "declined",
          "cancelled",
        ],

        default: "pending",

        index: true,
      },

      // ─────────────────────────────────────────────────────────────────────
      // TIMESTAMPS
      // ─────────────────────────────────────────────────────────────────────

      acceptedAt: {
        type: Date,
        default: null,
      },

      pickedUpAt: {
        type: Date,
        default: null,
      },

      deliveredAt: {
        type: Date,
        default: null,
      },

      completedAt: {
        type: Date,
        default: null,
      },

      // ─────────────────────────────────────────────────────────────────────
      // DELIVERY TYPE
      // ─────────────────────────────────────────────────────────────────────

      deliveryType: {
        type: String,

        enum: [
          "rider",
          "self",
        ],

        default: "rider",
      },

      // ─────────────────────────────────────────────────────────────────────
      // ITEM DISPLAY
      // ─────────────────────────────────────────────────────────────────────

      itemTitle: {
        type: String,
        default: "",
      },

      itemImage: {
        type: String,
        default: "",
      },

      notes: {
        type: String,
        default: "",
      },
    },

    {
      timestamps: true,
    }
  )

deliverySchema.index({
  seller: 1,
  status: 1,
})

deliverySchema.index({
  rider: 1,
  status: 1,
})

deliverySchema.index({
  localOrderId: 1,
})

export default mongoose.models.Delivery ||
  mongoose.model(
    "Delivery",
    deliverySchema
  )

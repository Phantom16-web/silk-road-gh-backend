
import mongoose from "mongoose"

const environmentSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "global",
    },

    mode: {
      type: String,
      enum: ["testing", "live"],
      default: "live",
      required: true,
    },

    changedBy: {
      type: String,
      default: null,
    },

    changedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
)

const Environment =
  mongoose.models.Environment ||
  mongoose.model("Environment", environmentSchema)

export async function getEnvironmentMode() {
  const environment = await Environment.findById("global")
    .select("mode")
    .lean()

  // A missing configuration must never enable testing.
  return environment?.mode === "testing" ? "testing" : "live"
}

export default Environment

import mongoose from "mongoose"

// One notification per recipient (buyer, seller or rider) per delivery event.
// Secrets such as delivery OTPs are NEVER stored here: they are emitted live only.
const schema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  recipientModel: { type: String, enum: ["User", "Rider"], default: "User" },
  type: { type: String, required: true },
  title: { type: String, default: "" },
  message: { type: String, default: "" },
  delivery: { type: mongoose.Schema.Types.ObjectId, ref: "Delivery", default: null },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ["unread", "read"], default: "unread" },
  readAt: { type: Date, default: null },
  dedupeKey: { type: String, default: undefined },
}, { timestamps: true })

schema.index({ recipient: 1, recipientModel: 1, status: 1, createdAt: -1 })
// Stops duplicate notifications when a request is retried or an event fires twice.
schema.index(
  { recipient: 1, recipientModel: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
)
// Keep 90 days of history.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 })

export default mongoose.models.Notification || mongoose.model("Notification", schema)

import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const riderSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  university: { type: String, default: '' },
  vehicle: { type: String, enum: ['motorbike','bicycle','walking'], default: 'motorbike' },
  currentLocation: { lat: { type: Number, default: null }, lng: { type: Number, default: null }, updatedAt: { type: Date, default: null } },
  isOnline: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  // An approved photo is immutable to riders. Admins must review replacements.
  photoUrl: { type: String, default: null },
  photoPublicId: { type: String, default: null },
  photoReviewStatus: { type: String, enum: ['missing','pending','approved','rejected'], default: 'missing' },
  photoReviewedAt: { type: Date, default: null },
  pendingEarnings: { type: Number, default: 0, min: 0 },
  totalEarned: { type: Number, default: 0, min: 0 },
  totalPaid: { type: Number, default: 0, min: 0 },
  totalDeliveries: { type: Number, default: 0, min: 0 },
  rating: { type: Number, default: 0, min: 0 },
  ratingCount: { type: Number, default: 0, min: 0 },
  activeDelivery: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', default: null },
}, { timestamps: true })

riderSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 10)
  next()
})
riderSchema.methods.matchPassword = function(password) { return bcrypt.compare(password, this.password) }
export default mongoose.models.Rider || mongoose.model('Rider', riderSchema)

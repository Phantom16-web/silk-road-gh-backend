import mongoose from "mongoose"
import bcrypt from "bcryptjs"

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  university: { type: String },
  phone: { type: String },
  role: { type: String, enum: ["user", "support", "admin", "superadmin", "owner"], default: "user" },
  status: { type: String, enum: ["Active", "Suspended"], default: "Active" },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true })

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next()
  this.password = await bcrypt.hash(this.password, 10)
  next()
})

userSchema.methods.matchPassword = async function (password) {
  return await bcrypt.compare(password, this.password)
}

export default mongoose.model("User", userSchema)
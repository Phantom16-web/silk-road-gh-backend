import express from "express"
import mongoose from "mongoose"
import protect from "../middleware/auth.js"
import SellerNotification from "../models/SellerNotification.js"

const router = express.Router()
router.use(protect)

router.get("/", async (req, res) => {
  try {
    const seller = req.user?.id
    if (!mongoose.isValidObjectId(seller)) return res.status(401).json({ message: "Invalid user" })
    const [notifications, unreadCount] = await Promise.all([
      SellerNotification.find({ seller }).sort({ createdAt: -1 }).limit(200).lean(),
      SellerNotification.countDocuments({ seller, status: "unread" }),
    ])
    res.json({ notifications: notifications.map(n => ({
      id: String(n._id), sellerId: String(n.seller), orderId: String(n.order),
      itemTitle: n.itemTitle, amount: n.amount, paymentMethod: n.paymentMethod,
      deliveryMethod: n.deliveryMethod, status: n.status, createdAt: n.createdAt,
    })), unreadCount })
  } catch (err) { console.error("Notification fetch error", err); res.status(500).json({ message: "Unable to load notifications" }) }
})

router.put("/read-all", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.user?.id)) return res.status(401).json({ message: "Invalid user" })
    await SellerNotification.updateMany({ seller: req.user.id, status: "unread" }, { $set: { status: "read", readAt: new Date() } })
    res.json({ unreadCount: 0 })
  } catch (err) { console.error("Notification read error", err); res.status(500).json({ message: "Unable to update notifications" }) }
})
export default router

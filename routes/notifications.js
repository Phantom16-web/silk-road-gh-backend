import express from "express"
import mongoose from "mongoose"
import protect from "../middleware/auth.js"
import protectRider from "../middleware/riderProtect.js"
import Notification from "../models/Notification.js"

function build(authMiddleware, getId, recipientModel) {
  const router = express.Router()
  router.use(authMiddleware)

  const shape = n => ({
    id: String(n._id), type: n.type, title: n.title, message: n.message,
    deliveryId: n.delivery ? String(n.delivery) : null,
    orderId: n.order ? String(n.order) : null,
    data: n.data || {}, status: n.status, createdAt: n.createdAt,
  })

  // GET /?limit=30&before=<ISO date>&unreadOnly=true
  router.get("/", async (req, res) => {
    try {
      const recipient = getId(req)
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100)
      const filter = { recipient, recipientModel }
      if (req.query.unreadOnly === "true") filter.status = "unread"
      if (req.query.before) {
        const before = new Date(String(req.query.before))
        if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before }
      }
      const [items, unreadCount] = await Promise.all([
        Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
        Notification.countDocuments({ recipient, recipientModel, status: "unread" }),
      ])
      res.json({ notifications: items.map(shape), unreadCount })
    } catch (err) {
      console.error("Notification list error", err)
      res.status(500).json({ message: "Unable to load notifications" })
    }
  })

  router.put("/read-all", async (req, res) => {
    try {
      await Notification.updateMany(
        { recipient: getId(req), recipientModel, status: "unread" },
        { $set: { status: "read", readAt: new Date() } })
      res.json({ unreadCount: 0 })
    } catch (err) {
      console.error("Notification read-all error", err)
      res.status(500).json({ message: "Unable to update notifications" })
    }
  })

  router.put("/:id/read", async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid id" })
      const recipient = getId(req)
      const n = await Notification.findOneAndUpdate(
        { _id: req.params.id, recipient, recipientModel },
        { $set: { status: "read", readAt: new Date() } }, { new: true }).lean()
      if (!n) return res.status(404).json({ message: "Notification not found" })
      const unreadCount = await Notification.countDocuments({ recipient, recipientModel, status: "unread" })
      res.json({ notification: shape(n), unreadCount })
    } catch (err) {
      console.error("Notification read error", err)
      res.status(500).json({ message: "Unable to update notification" })
    }
  })
  return router
}

export const userNotificationRoutes = build(protect, req => req.user.id, "User")
export const riderNotificationRoutes = build(protectRider, req => req.rider.id, "Rider")

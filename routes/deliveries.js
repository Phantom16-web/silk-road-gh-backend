import express from "express"
import jwt from "jsonwebtoken"
import crypto from "crypto"

import Delivery from "../models/Delivery.js"
import Rider from "../models/Rider.js"
import Order from "../models/Order.js"

import {
  haversineKm,
  calculateDeliveryFee,
} from "../utils/distance.js"

const router = express.Router()

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getAnyUserId(req) {
  try {
    const header =
      req.headers.authorization

    if (
      !header?.startsWith(
        "Bearer "
      )
    ) {
      return null
    }

    const token =
      header.split(" ")[1]

    const decoded =
      jwt.verify(
        token,
        process.env.JWT_SECRET
      )

    return (
      decoded.id || null
    )
  } catch {
    return null
  }
}

function pushTo(
  req,
  userId,
  event,
  data
) {
  try {
    const io =
      req.app.get("io")

    const sockets =
      req.app.get(
        "sellerSockets"
      )

    const queueNotif =
      req.app.get(
        "queueNotification"
      )

    if (
      !io ||
      !sockets ||
      !userId
    ) {
      return
    }

    const userSockets =
      sockets.get(
        String(userId)
      )

    if (
      !userSockets ||
      userSockets.size === 0
    ) {
      const queueable = [
        "delivery_accepted",
        "delivery_picked_up",
        "delivery_at_door",
        "delivery_completed",
        "delivery_cancelled_by_rider",
        "sale_completed",
      ]

      if (
        queueNotif &&
        queueable.includes(
          event
        )
      ) {
        queueNotif(
          String(userId),
          event,
          data
        )
      }

      return
    }

    userSockets.forEach(
      (socketId) => {
        io.to(socketId).emit(
          event,
          data
        )
      }
    )
  } catch (err) {
    console.error(
      "pushTo error:",
      err.message
    )
  }
}

function isMongoId(value) {
  return (
    value &&
    /^[a-f\d]{24}$/i.test(
      String(value)
    )
  )
}

function generateOtp() {
  return crypto
    .randomInt(
      100000,
      1000000
    )
    .toString()
}

function findOrderForDelivery(
  delivery
) {
  if (delivery.order) {
    return Order.findById(
      delivery.order
    )
  }

  if (
    delivery.localOrderId
  ) {
    return Order.findOne({
      localOrderId:
        delivery.localOrderId,
    })
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/quote",
  async (req, res) => {
    try {
      const {
        pickupLat,
        pickupLng,
        dropLat,
        dropLng,
      } = req.body

      const pLat =
        Number(pickupLat)

      const pLng =
        Number(pickupLng)

      const dLat =
        Number(dropLat)

      const dLng =
        Number(dropLng)

      if (
        !Number.isFinite(pLat) ||
        !Number.isFinite(pLng) ||
        !Number.isFinite(dLat) ||
        !Number.isFinite(dLng)
      ) {
        return res.status(400).json({
          message:
            "Invalid coordinates.",
        })
      }

      const distanceKm =
        haversineKm(
          pLat,
          pLng,
          dLat,
          dLng
        )

      const deliveryFee =
        calculateDeliveryFee(
          distanceKm
        )

      res.json({
        distanceKm,
        deliveryFee,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABLE RIDER JOBS
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/available",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const rider =
        await Rider.findById(
          riderId
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      if (!rider.isActive) {
        return res.status(403).json({
          message:
            "Rider account is inactive.",
        })
      }

      if (
        rider.activeDelivery
      ) {
        const active =
          await Delivery.findById(
            rider.activeDelivery
          )

        if (
          !active ||
          [
            "completed",
            "cancelled",
          ].includes(
            active.status
          )
        ) {
          rider.activeDelivery =
            null

          await rider.save()
        } else {
          return res.json({
            jobs: [],

            activeDelivery:
              rider.activeDelivery,
          })
        }
      }

      const jobs =
        await Delivery.find({
          status:
            "pending",
        })
          .sort({
            createdAt: -1,
          })
          .limit(20)

      res.json({
        jobs,
        activeDelivery:
          null,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RIDER ACTIVE DELIVERY
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/my-active",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const rider =
        await Rider.findById(
          riderId
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      if (
        !rider.activeDelivery
      ) {
        return res.json({
          delivery: null,
        })
      }

      const delivery =
        await Delivery.findById(
          rider.activeDelivery
        )

      if (
        !delivery ||
        [
          "completed",
          "cancelled",
        ].includes(
          delivery.status
        )
      ) {
        rider.activeDelivery =
          null

        await rider.save()

        return res.json({
          delivery: null,
        })
      }

      res.json({
        delivery,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// BUYER OTP
//
// IMPORTANT:
//
// We no longer expose OTP publicly.
//
// Authenticated buyer only.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/otp-for-order/:localOrderId",
  async (req, res) => {
    try {
      const buyerId =
        getAnyUserId(req)

      if (!buyerId) {
        return res.status(401).json({
          message:
            "Buyer authentication required.",
        })
      }

      const {
        localOrderId,
      } = req.params

      const order =
        await Order.findOne({
          localOrderId,
        })

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      if (
        !order.buyer ||
        String(order.buyer) !==
          String(buyerId)
      ) {
        return res.status(403).json({
          message:
            "You are not authorized to view this delivery OTP.",
        })
      }

      const delivery =
        await Delivery.findOne({
          localOrderId,

          status:
            "delivered",

          otp: {
            $exists: true,
            $ne: null,
          },
        })

      if (!delivery) {
        return res.json({
          otp: null,
        })
      }

      if (
        !delivery.otpExpiresAt ||
        new Date() >
          delivery.otpExpiresAt
      ) {
        return res.json({
          otp: null,
          expired: true,
        })
      }

      res.json({
        otp:
          delivery.otp,

        expiresAt:
          delivery.otpExpiresAt,

        deliveryId:
          delivery._id.toString(),

        itemTitle:
          delivery.itemTitle,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// FORCE CLEAR RIDER
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/force-clear",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const rider =
        await Rider.findById(
          riderId
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      const previous =
        rider.activeDelivery

      rider.activeDelivery =
        null

      await rider.save()

      res.json({
        message:
          "Cleared.",

        cleared:
          previous
            ? String(previous)
            : null,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY BY ORDER
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/by-order/:orderId",
  async (req, res) => {
    try {
      const id =
        req.params.orderId

      const delivery =
        isMongoId(id)
          ? await Delivery.findOne({
              order: id,
            }).populate(
              "rider",
              "name phone vehicle rating"
            )
          : await Delivery.findOne({
              localOrderId: id,
            }).populate(
              "rider",
              "name phone vehicle rating"
            )

      res.json({
        delivery:
          delivery || null,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// CREATE DELIVERY JOB
//
// SELLER ONLY
//
// IMPORTANT:
// Payment must already be in Silk Road escrow.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/",
  async (req, res) => {
    try {
      const sellerId =
        getAnyUserId(req)

      if (!sellerId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const {
        orderId,
        pickupLat,
        pickupLng,
        pickupAddress,
        dropLat,
        dropLng,
        dropAddress,
        sellerContact,
        buyerContact,
        itemTitle,
        itemImage,
        notes,
      } = req.body

      const pLat =
        Number(pickupLat)

      const pLng =
        Number(pickupLng)

      const dLat =
        Number(dropLat)

      const dLng =
        Number(dropLng)

      if (
        !Number.isFinite(pLat) ||
        !Number.isFinite(pLng) ||
        !Number.isFinite(dLat) ||
        !Number.isFinite(dLng)
      ) {
        return res.status(400).json({
          message:
            "Invalid coordinates.",
        })
      }

      let order = null

      if (
        isMongoId(orderId)
      ) {
        order =
          await Order.findById(
            orderId
          )
      } else if (orderId) {
        order =
          await Order.findOne({
            localOrderId:
              String(orderId),
          })
      }

      if (!order) {
        return res.status(404).json({
          message:
            "Order not found.",
        })
      }

      if (
        !order.seller ||
        String(order.seller) !==
          String(sellerId)
      ) {
        return res.status(403).json({
          message:
            "You are not authorized to create delivery for this order.",
        })
      }

      // ────────────────────────────────────────────────────────────────────
      // NO DELIVERY BEFORE PAYMENT
      // ────────────────────────────────────────────────────────────────────

      if (
        order.paymentStatus !==
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "Payment must be verified and held in Silk Road escrow before delivery can begin.",
        })
      }

      if (
        order.cancelled
      ) {
        return res.status(400).json({
          message:
            "This order has been cancelled.",
        })
      }

      if (
        order.fulfillmentStatus ===
        "completed"
      ) {
        return res.status(400).json({
          message:
            "This order has already been completed.",
        })
      }

      // Don't create duplicate active delivery jobs.
      const existing =
        await Delivery.findOne({
          order:
            order._id,

          status: {
            $in: [
              "pending",
              "accepted",
              "picked_up",
              "delivered",
            ],
          },
        })

      if (existing) {
        return res.status(409).json({
          message:
            "An active delivery already exists for this order.",

          delivery:
            existing,
        })
      }

      const distanceKm =
        haversineKm(
          pLat,
          pLng,
          dLat,
          dLng
        )

      const deliveryFee =
        calculateDeliveryFee(
          distanceKm
        )

      const delivery =
        await Delivery.create({
          order:
            order._id,

          localOrderId:
            order.localOrderId ||
            null,

          seller:
            sellerId,

          buyer:
            order.buyer || null,

          rider:
            null,

          pickupLocation: {
            lat: pLat,
            lng: pLng,
            address:
              pickupAddress ||
              `${pLat},${pLng}`,
          },

          dropLocation: {
            lat: dLat,
            lng: dLng,
            address:
              dropAddress ||
              `${dLat},${dLng}`,
          },

          sellerContact:
            sellerContact ||
            order.payerPhone ||
            "",

          buyerContact:
            buyerContact ||
            order.payerPhone ||
            "",

          distanceKm,

          deliveryFee,

          itemTitle:
            itemTitle ||
            "Package",

          itemImage:
            itemImage ||
            "",

          notes:
            notes || "",

          status:
            "pending",
        })

      // Order has now entered delivery.
      order.fulfillmentStatus =
        "awaiting_delivery"

      await order.save()

      const io =
        req.app.get("io")

      if (io) {
        io.emit(
          "new_delivery_job",
          {
            _id:
              delivery._id.toString(),

            itemTitle:
              delivery.itemTitle,

            itemImage:
              delivery.itemImage,

            pickupAddress:
              delivery
                .pickupLocation
                ?.address,

            dropAddress:
              delivery
                .dropLocation
                ?.address,

            pickupLocation:
              delivery.pickupLocation,

            dropLocation:
              delivery.dropLocation,

            distanceKm:
              delivery.distanceKm,

            deliveryFee:
              delivery.deliveryFee,

            sellerContact:
              delivery.sellerContact,

            buyerContact:
              delivery.buyerContact,

            createdAt:
              Date.now(),
          }
        )
      }

      res.status(201).json({
        delivery,

        distanceKm,

        deliveryFee,
      })
    } catch (err) {
      console.error(
        "Create delivery error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RIDER ACCEPT
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/accept",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const rider =
        await Rider.findById(
          riderId
        )

      if (!rider) {
        return res.status(404).json({
          message:
            "Rider not found.",
        })
      }

      if (!rider.isActive) {
        return res.status(403).json({
          message:
            "Rider account is inactive.",
        })
      }

      if (
        rider.activeDelivery
      ) {
        const active =
          await Delivery.findById(
            rider.activeDelivery
          )

        if (
          active &&
          ![
            "completed",
            "cancelled",
          ].includes(
            active.status
          )
        ) {
          return res.status(400).json({
            message:
              "You already have an active delivery.",
          })
        }

        rider.activeDelivery =
          null

        await rider.save()
      }

      const delivery =
        await Delivery.findById(
          req.params.id
        )

      if (!delivery) {
        return res.status(404).json({
          message:
            "Delivery not found.",
        })
      }

      if (
        delivery.status !==
        "pending"
      ) {
        return res.status(400).json({
          message:
            "Job already taken.",
        })
      }

      const order =
        await findOrderForDelivery(
          delivery
        )

      if (!order) {
        return res.status(409).json({
          message:
            "Associated order not found.",
        })
      }

      if (
        order.paymentStatus !==
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "This order is not financially cleared for delivery.",
        })
      }

      delivery.rider =
        riderId

      delivery.status =
        "accepted"

      delivery.acceptedAt =
        new Date()

      await delivery.save()

      rider.activeDelivery =
        delivery._id

      await rider.save()

      pushTo(
        req,
        String(
          delivery.seller
        ),
        "delivery_accepted",
        {
          deliveryId:
            delivery._id.toString(),

          riderName:
            rider.name,

          message:
            `${rider.name} accepted and is heading to pick up.`,
        }
      )

      res.json({
        delivery,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RIDER DECLINE
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/decline",
  async (req, res) => {
    res.json({
      message:
        "Declined.",
    })
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RIDER CANCEL
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/cancel-by-rider",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const delivery =
        await Delivery.findById(
          req.params.id
        )

      if (!delivery) {
        return res.status(404).json({
          message:
            "Delivery not found.",
        })
      }

      if (
        String(
          delivery.rider
        ) !==
        String(riderId)
      ) {
        return res.status(403).json({
          message:
            "Not your delivery.",
        })
      }

      if (
        delivery.status ===
        "completed"
      ) {
        return res.status(400).json({
          message:
            "Already completed.",
        })
      }

      if (
        delivery.status ===
        "delivered"
      ) {
        return res.status(400).json({
          message:
            "Package delivered. Obtain buyer OTP.",
        })
      }

      delivery.rider =
        null

      delivery.status =
        "pending"

      delivery.acceptedAt =
        null

      delivery.pickedUpAt =
        null

      await delivery.save()

      await Rider.findByIdAndUpdate(
        riderId,
        {
          activeDelivery:
            null,
        }
      )

      pushTo(
        req,
        String(
          delivery.seller
        ),
        "delivery_cancelled_by_rider",
        {
          deliveryId:
            delivery._id.toString(),

          message:
            "Rider cancelled. Job is back on the board.",
        }
      )

      const io =
        req.app.get("io")

      if (io) {
        io.emit(
          "new_delivery_job",
          {
            _id:
              delivery._id.toString(),

            itemTitle:
              delivery.itemTitle,

            itemImage:
              delivery.itemImage,

            pickupAddress:
              delivery
                .pickupLocation
                ?.address,

            dropAddress:
              delivery
                .dropLocation
                ?.address,

            pickupLocation:
              delivery.pickupLocation,

            dropLocation:
              delivery.dropLocation,

            distanceKm:
              delivery.distanceKm,

            deliveryFee:
              delivery.deliveryFee,

            sellerContact:
              delivery.sellerContact,

            buyerContact:
              delivery.buyerContact,

            createdAt:
              Date.now(),
          }
        )
      }

      res.json({
        message:
          "Cancelled.",

        delivery,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// PICKED UP
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/picked-up",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const delivery =
        await Delivery.findById(
          req.params.id
        )

      if (!delivery) {
        return res.status(404).json({
          message:
            "Delivery not found.",
        })
      }

      if (
        String(
          delivery.rider
        ) !==
        String(riderId)
      ) {
        return res.status(403).json({
          message:
            "Not your delivery.",
        })
      }

      if (
        delivery.status !==
        "accepted"
      ) {
        return res.status(400).json({
          message:
            `Status is ${delivery.status}.`,
        })
      }

      delivery.status =
        "picked_up"

      delivery.pickedUpAt =
        new Date()

      await delivery.save()

      const order =
        await findOrderForDelivery(
          delivery
        )

      if (order) {
        order.fulfillmentStatus =
          "delivery_in_progress"

        await order.save()
      }

      pushTo(
        req,
        String(
          delivery.seller
        ),
        "delivery_picked_up",
        {
          deliveryId:
            delivery._id.toString(),

          message:
            "Package picked up, heading to buyer.",
        }
      )

      res.json({
        delivery,
      })
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// RIDER MARKS ARRIVED / DELIVERED
//
// Generates OTP.
//
// IMPORTANT:
// This does NOT complete the order.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/delivered",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const delivery =
        await Delivery.findById(
          req.params.id
        )

      if (!delivery) {
        return res.status(404).json({
          message:
            "Delivery not found.",
        })
      }

      if (
        String(
          delivery.rider
        ) !==
        String(riderId)
      ) {
        return res.status(403).json({
          message:
            "Not your delivery.",
        })
      }

      if (
        delivery.status !==
        "picked_up"
      ) {
        return res.status(400).json({
          message:
            `Status is ${delivery.status}. It must be picked_up.`,
        })
      }

      const order =
        await findOrderForDelivery(
          delivery
        )

      if (!order) {
        return res.status(409).json({
          message:
            "Associated order not found.",
        })
      }

      if (
        order.paymentStatus !==
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "This order is not currently in escrow.",
        })
      }

      const otp =
        generateOtp()

      delivery.otp =
        otp

      delivery.otpExpiresAt =
        new Date(
          Date.now() +
            30 *
              60 *
              1000
        )

      delivery.otpAttempts =
        0

      delivery.otpLocked =
        false

      delivery.status =
        "delivered"

      delivery.deliveredAt =
        new Date()

      await delivery.save()

      order.fulfillmentStatus =
        "delivered_pending_otp"

      await order.save()

      console.log(
        `📦 Delivery ${delivery._id} awaiting OTP confirmation.`
      )

      // ────────────────────────────────────────────────────────────────────
      // Seller gets notification, but NEVER the OTP.
      // ────────────────────────────────────────────────────────────────────

      pushTo(
        req,
        String(
          delivery.seller
        ),
        "delivery_at_door",
        {
          deliveryId:
            delivery._id.toString(),

          message:
            "Package delivered. Waiting for buyer OTP confirmation.",
        }
      )

      // ────────────────────────────────────────────────────────────────────
      // Buyer notification
      //
      // We send the OTP only to the buyer's registered socket(s).
      // For guest orders, the frontend must use the authenticated
      // OTP endpoint.
      // ────────────────────────────────────────────────────────────────────

      if (
        delivery.buyer
      ) {
        pushTo(
          req,
          String(
            delivery.buyer
          ),
          "delivery_otp_ready",
          {
            deliveryId:
              delivery._id.toString(),

            localOrderId:
              delivery.localOrderId,

            itemTitle:
              delivery.itemTitle,

            expiresAt:
              delivery.otpExpiresAt,

            otp,
          }
        )
      }

      res.json({
        delivery: {
          ...delivery.toObject(),

          // Do not return OTP to rider.
          otp:
            undefined,
        },

        localOrderId:
          delivery.localOrderId,

        message:
          "Delivery marked at door. Buyer OTP is now required.",
      })
    } catch (err) {
      console.error(
        "Delivered error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM OTP
//
// RIDER enters the OTP spoken by buyer.
//
// This is the transaction completion event.
//
// IMPORTANT:
// We DO NOT mark payment released here.
// We mark:
//     fulfillment = completed
//     payment     = release_pending
//
// Actual release is a separate financial operation.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id/confirm-otp",
  async (req, res) => {
    try {
      const riderId =
        getAnyUserId(req)

      if (!riderId) {
        return res.status(401).json({
          message:
            "Not authorized.",
        })
      }

      const {
        otp,
      } = req.body

      if (!otp) {
        return res.status(400).json({
          message:
            "OTP required.",
        })
      }

      const delivery =
        await Delivery.findById(
          req.params.id
        )

      if (!delivery) {
        return res.status(404).json({
          message:
            "Delivery not found.",
        })
      }

      if (
        String(
          delivery.rider
        ) !==
        String(riderId)
      ) {
        return res.status(403).json({
          message:
            "Not your delivery.",
        })
      }

      if (
        delivery.status !==
        "delivered"
      ) {
        return res.status(400).json({
          message:
            "Delivery must first be marked delivered.",
        })
      }

      if (
        delivery.otpLocked
      ) {
        return res.status(429).json({
          message:
            "OTP verification is locked for this delivery.",
        })
      }

      if (
        !delivery.otpExpiresAt ||
        new Date() >
          delivery.otpExpiresAt
      ) {
        return res.status(400).json({
          message:
            "OTP expired.",
        })
      }

      const suppliedOtp =
        String(
          otp
        ).trim()

      const storedOtp =
        String(
          delivery.otp
        )

      const valid =
        suppliedOtp.length ===
          storedOtp.length &&
        crypto.timingSafeEqual(
          Buffer.from(
            suppliedOtp
          ),
          Buffer.from(
            storedOtp
          )
        )

      if (!valid) {
        delivery.otpAttempts +=
          1

        if (
          delivery.otpAttempts >=
          5
        ) {
          delivery.otpLocked =
            true
        }

        await delivery.save()

        return res.status(400).json({
          message:
            delivery.otpLocked
              ? "Too many incorrect OTP attempts. Verification is locked."
              : "Incorrect OTP.",

          attemptsRemaining:
            Math.max(
              0,
              5 -
                delivery.otpAttempts
            ),
        })
      }

      const order =
        await findOrderForDelivery(
          delivery
        )

      if (!order) {
        return res.status(409).json({
          message:
            "Associated order not found.",
        })
      }

      if (
        order.paymentStatus !==
        "escrow_held"
      ) {
        return res.status(400).json({
          message:
            "The order is not in a valid escrow state.",
        })
      }

      if (
        order.fulfillmentStatus ===
        "completed"
      ) {
        return res.status(409).json({
          message:
            "This order has already been completed.",
        })
      }

      // ────────────────────────────────────────────────────────────────────
      // DELIVERY COMPLETE
      // ────────────────────────────────────────────────────────────────────

      delivery.status =
        "completed"

      delivery.otpVerified =
        true

      delivery.completedAt =
        new Date()

      // OTP should not remain usable.
      delivery.otp =
        null

      delivery.otpExpiresAt =
        null

      await delivery.save()

      // ────────────────────────────────────────────────────────────────────
      // ORDER COMPLETE — BUT FUNDS NOT YET RELEASED
      // ────────────────────────────────────────────────────────────────────

      order.fulfillmentStatus =
        "completed"

      order.completedAt =
        new Date()

      order.paymentStatus =
        "release_pending"

      /*
       * Keep the legacy status useful for the current UI.
       *
       * We deliberately do NOT set:
       *
       *     paymentStatus = released
       *
       * because no actual payout has occurred yet.
       */

      order.status =
        "Completed"

      await order.save()

      // ────────────────────────────────────────────────────────────────────
      // RIDER EARNINGS
      //
      // This records accrued delivery earnings.
      // It does NOT claim that the rider has been paid.
      // ────────────────────────────────────────────────────────────────────

      const rider =
        await Rider.findById(
          riderId
        )

      if (rider) {
        rider.totalDeliveries +=
          1

        rider.totalEarned +=
          delivery.deliveryFee

        rider.activeDelivery =
          null

        await rider.save()
      }

      const orderAmount =
        order.amount || 0

      const platformFee =
        order.platformFee ||
        Math.round(
          orderAmount * 0.08
        )

      const sellerAmount =
        order.sellerAmount ||
        (
          orderAmount -
          platformFee
        )

      // ────────────────────────────────────────────────────────────────────
      // SELLER NOTIFICATION
      // ────────────────────────────────────────────────────────────────────

      pushTo(
        req,
        String(
          order.seller
        ),
        "sale_completed",
        {
          deliveryId:
            delivery._id.toString(),

          localOrderId:
            order.localOrderId,

          itemTitle:
            delivery.itemTitle,

          deliveryFee:
            delivery.deliveryFee,

          orderAmount,

          platformFee,

          sellerAmount,

          paymentStatus:
            "release_pending",

          message:
            "Delivery confirmed. Seller funds are now pending release.",
        }
      )

      pushTo(
        req,
        String(
          order.seller
        ),
        "delivery_completed",
        {
          deliveryId:
            delivery._id.toString(),

          deliveryFee:
            delivery.deliveryFee,

          orderAmount,

          sellerAmount,

          paymentStatus:
            "release_pending",

          message:
            "Delivery confirmed via OTP.",
        }
      )

      // ────────────────────────────────────────────────────────────────────
      // BUYER NOTIFICATION
      // ────────────────────────────────────────────────────────────────────

      if (
        order.buyer
      ) {
        pushTo(
          req,
          String(
            order.buyer
          ),
          "delivery_completed",
          {
            deliveryId:
              delivery._id.toString(),

            localOrderId:
              order.localOrderId,

            itemTitle:
              delivery.itemTitle,

            orderAmount,

            paymentStatus:
              "release_pending",

            message:
              "Delivery confirmed successfully.",
          }
        )
      }

      res.json({
        delivery,

        order,

        message:
          "Delivery confirmed. The order is complete and funds are pending release.",
      })
    } catch (err) {
      console.error(
        "confirm-otp error:",
        err
      )

      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// GET DELIVERY
// MUST REMAIN LAST
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/:id",
  async (req, res) => {
    try {
      const delivery =
        await Delivery.findById(
          req.params.id
        )
          .populate(
            "rider",
            "name phone vehicle rating"
          )
          .populate(
            "seller",
            "name phone"
          )

      if (!delivery) {
        return res.status(404).json({
          message:
            "Delivery not found.",
        })
      }

      // Never expose OTP through generic delivery lookup.
      const safe =
        delivery.toObject()

      delete safe.otp
      delete safe.otpExpiresAt

      res.json(safe)
    } catch (err) {
      res.status(500).json({
        message:
          err.message,
      })
    }
  }
)

export default router

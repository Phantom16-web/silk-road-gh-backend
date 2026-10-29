import { quarantineExpiredRentalPayments } from "../services/rentalPendingRecovery.js";
import express from "express";
import mongoose from "mongoose";
import protect from "../middleware/auth.js";
import Order from "../models/Order.js";
import Listing from "../models/Listing.js";
import RentalBooking from "../models/RentalBooking.js";
import RentalItemLock from "../models/RentalItemLock.js";
import RentalReservation from "../models/RentalReservation.js";
import { reclaimExpiredReservation } from "../services/rentalReservation.js";
import { getEnvironmentMode } from "../models/Environment.js";

const router = express.Router();
// Public availability is advisory only; activation uses an atomic database lock.
router.get("/availability/:listingId", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ message: "Invalid listing." });
  try {
    const listing = await Listing.findById(req.params.listingId).select("type").lean();
    if (!listing || listing.type !== "rent") return res.status(404).json({ message: "Rental listing not found." });
    await reclaimExpiredReservation(listing._id);
    const [lock, reservation] = await Promise.all([RentalItemLock.exists({ listing: listing._id }), RentalReservation.exists({listing: listing._id})]);
    return res.json({ available: !lock && !reservation, note: "Availability is advisory; a reservation must be acquired before creating a rental order." });
  } catch { return res.status(503).json({ message: "Availability temporarily unavailable." }); }
});
router.use(protect);
const err = (message, status = 409) => Object.assign(new Error(message), { status });
const cents = n => Math.round(Number(n) * 100);
const activeStatuses = ["awaiting_handover", "handed_over", "in_use", "return_requested", "disputed"];
// Reserve before order creation. The unique listing index serializes competing buyers.
// A reservation lasts 60 minutes; once a payment attempt starts, it is not auto-freed.
router.post("/reserve", async (req,res) => {
 const listingId=req.body?.listingId;
 if (!mongoose.isValidObjectId(listingId)) return res.status(400).json({message:"Invalid rental listing."});
 try {
  const listing=await Listing.findById(listingId).lean();
  if (!listing || listing.type!=="rent" || listing.status!=="Active") return res.status(404).json({message:"Active rental listing not found."});
  if (String(listing.seller)===String(req.user.id)) return res.status(403).json({message:"You cannot rent your own listing."});
  if (await RentalItemLock.exists({listing:listing._id})) return res.status(409).json({message:"Item currently rented."});
  await reclaimExpiredReservation(listing._id);
  const existing=await RentalReservation.findOne({listing:listing._id});
  if (existing) {
   if (String(existing.renter)!==String(req.user.id)) return res.status(409).json({message:"Item temporarily reserved by another renter."});
   return res.json({reservationId:String(existing._id),expiresAt:existing.expiresAt,state:existing.state});
  }
  // Quarantine expired payment attempts without releasing the item or its funds.
  await quarantineExpiredRentalPayments(req.user.id);
  // One active unpaid reservation per renter. The partial unique index also
  // enforces this across concurrent requests and multiple server instances.
  const otherHold=await RentalReservation.findOne({renter:req.user.id,state:{$in:["reserved","payment_pending"]}}).lean();
  const unresolvedCount=await RentalReservation.countDocuments({renter:req.user.id,state:"reconciliation_required"});
  if (unresolvedCount >= 2) return res.status(409).json({code:"RENTAL_RECONCILIATION_LIMIT",message:"Two earlier rental payments require verification. Contact support before placing another rental reservation."});
  if (otherHold) return res.status(409).json({code:"ACTIVE_UNPAID_RENTAL",message:"Finish or cancel your existing unpaid rental reservation before reserving another item. Payment-linked orders require support reconciliation."});
  const environment=await getEnvironmentMode();
  const reservation=await RentalReservation.create({listing:listing._id,renter:req.user.id,environment,expiresAt:new Date(Date.now()+60*60*1000)});
  return res.status(201).json({reservationId:String(reservation._id),expiresAt:reservation.expiresAt,state:reservation.state});
 } catch(e) {return res.status(e.code===11000?409:503).json({message:e.code===11000?"A rental is already reserved (or you have another unpaid reservation).":"Reservation temporarily unavailable."});}
});
router.post("/reservations/:id/cancel",async(req,res)=>{
 if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid reservation."});
 const result=await RentalReservation.deleteOne({_id:req.params.id,renter:req.user.id,state:"reserved",order:null});
 return res.json({cancelled:result.deletedCount===1});
});


async function transact(res, fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return res.json(result);
  } catch (e) {
    console.error("Rental lifecycle error:", e);
    return res.status(e.code === 11000 ? 409 : e.status || 500).json({ message: e.status ? e.message : e.code === 11000 ? "This rental item is already in use or the order is already activated. Contact support about any payment." : "Rental operation failed." });
  } finally { await session.endSession(); }
}

// Register accountability acceptance against an existing, server-priced, paid rental order.
// Never treat this as payment verification or as authority to charge damage penalties.
router.post("/orders/:orderId/activate", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId) || req.body?.acceptAccountability !== true)
    return res.status(400).json({ message: "Explicit acceptance of the rental accountability terms is required." });
  return transact(res, async session => {
    const order = await Order.findById(req.params.orderId).session(session);
    if (!order || order.type !== "rent" || String(order.buyer) !== req.user.id) throw err("Rental order not found.", 404);
    if (order.cancelled || order.paymentStatus !== "escrow_held") throw err("Verified escrow is required before rental handover.");
    const mode = await getEnvironmentMode();
    if (order.environment !== mode || (mode === "testing" ? order.isSimulatedPayment !== true : order.isSimulatedPayment === true)) throw err("Rental payment environment mismatch.");
    if (await RentalBooking.exists({ order: order._id }).session(session)) throw err("Rental already activated.");
    const reservation=await RentalReservation.findOne({order:order._id,renter:req.user.id,listing:order.listing,environment:order.environment}).session(session);
    if (!reservation || !["payment_pending","reconciliation_required","paid"].includes(reservation.state)) throw err("Rental reservation missing or invalid.");
    const listing = await Listing.findById(order.listing).session(session);
    if (!listing || listing.type !== "rent" || String(listing.seller) !== String(order.seller)) throw err("Rental listing is invalid.");
    const days = Number(order.rentalDays);
    if (!Number.isSafeInteger(days) || days < 1 || (listing.maxDays && days > listing.maxDays)) throw err("Invalid rental duration.");
    if (!Number.isFinite(Number(listing.dailyRate)) || cents(order.amount) !== cents(Number(listing.dailyRate) * days)) throw err("Rental amount differs from the listing; support review required.");
    const [booking] = await RentalBooking.create([{ order: order._id, listing: listing._id, renter: order.buyer, owner: order.seller, rentalDays: days, rentalAmount: order.amount, accountabilityAccepted: true, accountabilityAcceptedAt: new Date(), history: [{ action: "accountability_accepted", actor: order.buyer }] }], { session });
    // Unique listing lock serializes concurrent activations, even from different buyers.
    await RentalItemLock.create([{ listing: listing._id, booking: booking._id, order: order._id }], { session });
    reservation.state="activated"; await reservation.save({session});
    return { bookingId: String(booking._id), status: booking.status, message: "Rental accountability accepted. Awaiting item handover." };
  });
});

router.get("/mine", async (req, res) => {
  try {
    const bookings = await RentalBooking.find({ $or: [{ renter: req.user.id }, { owner: req.user.id }] }).select("-history").sort({ createdAt: -1 }).limit(100).lean();
    return res.json({ bookings });
  } catch { return res.status(500).json({ message: "Unable to load rentals." }); }
});

router.post("/:id/:action", async (req, res) => {
  const action = req.params.action;
  if (!mongoose.isValidObjectId(req.params.id) || !["handover", "receive", "request-return", "confirm-return", "dispute"].includes(action)) return res.status(400).json({ message: "Invalid rental action." });
  if (action === "dispute" && (typeof req.body?.reason !== "string" || req.body.reason.trim().length < 10 || req.body.reason.length > 2000)) return res.status(400).json({ message: "Provide a dispute reason of 10–2000 characters." });
  return transact(res, async session => {
    const booking = await RentalBooking.findById(req.params.id).session(session);
    if (!booking) throw err("Rental not found.", 404);
    const owner = String(booking.owner) === req.user.id, renter = String(booking.renter) === req.user.id;
    if (!owner && !renter) throw err("Not authorized.", 403);
    const order = await Order.findById(booking.order).session(session);
    if (!order || order.paymentStatus !== "escrow_held" || order.cancelled || order.environment !== await getEnvironmentMode()) throw err("Rental escrow is not eligible for this action.");
    const transitions = {
      handover: { role: owner, from: "awaiting_handover", to: "handed_over", field: "handoverAt" },
      receive: { role: renter, from: "handed_over", to: "in_use", field: "receivedAt" },
      "request-return": { role: renter, from: "in_use", to: "return_requested", field: "returnRequestedAt" },
      "confirm-return": { role: owner, from: "return_requested", to: "returned", field: "returnedAt" },
    };
    if (action === "dispute") {
      if (!["handed_over", "in_use", "return_requested"].includes(booking.status)) throw err("This rental cannot open a dispute from its current status.");
      booking.status = "disputed";
      booking.disputeReason = req.body.reason.trim();
      booking.disputeOpenedAt = new Date();
      // Settlement must be independently blocked by all payment/payout services.
      // Do not change grouped checkout financial status here without group-level reconciliation.
    } else {
      const t = transitions[action];
      if (!t.role) throw err("Not authorized for this action.", 403);
      if (booking.status !== t.from) throw err(`Rental must be ${t.from} before ${action}.`);
      booking.status = t.to;
      booking[t.field] = new Date();
      if (action === "receive") booking.dueAt = new Date(Date.now() + booking.rentalDays * 86400000);
    }
    booking.history.push({ action, actor: req.user.id });
    await booking.save({ session });
    if (action === "confirm-return") {
      const unlocked = await RentalItemLock.deleteOne({ listing: booking.listing, booking: booking._id }).session(session);
      if (unlocked.deletedCount !== 1) throw err("Rental lock missing. Contact support; return cannot be finalized.");
      await RentalReservation.deleteOne({order:order._id,state:"activated"}).session(session);
    }
    return { bookingId: String(booking._id), status: booking.status, dueAt: booking.dueAt, message: action === "confirm-return" ? "Return recorded. Settlement remains subject to separate financial approval." : "Rental updated." };
  });
});
export default router;

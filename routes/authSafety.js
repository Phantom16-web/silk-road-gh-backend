import express from "express";
import protect from "../middleware/auth.js";

const router = express.Router();
// Legacy self-delete permanently erased a user without resolving listings,
// escrow, deliveries, or payouts. Disable it until a full safe workflow exists.
router.delete("/delete", protect, (req,res)=>res.status(409).json({
  message:"Self-service account deletion is temporarily unavailable while outstanding transactions and associated records are safeguarded. Contact support.",
  code:"SAFE_ACCOUNT_CLOSURE_REQUIRED"
}));
// Legacy /me performs a JWT-only lookup. Check live account status first.
router.get("/me", protect, (req,res,next)=>next());
export default router;

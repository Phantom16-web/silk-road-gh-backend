import express from "express";
import mongoose from "mongoose";
import Admin, { ROLE_PERMISSIONS } from "../models/Admin.js";
import { requireAdminAuth, requireOwner, requireReAuth } from "../middleware/adminAuth.js";

const router = express.Router();
router.use(requireAdminAuth);
// These names must be checked at the actual operation endpoints; granting a name
// does not by itself authorize an operation whose route has no permission guard.
export const PERMISSION_GROUPS = Object.freeze({
  "Users": ["view_users", "manage_users", "suspend_accounts", "remove_users", "view_sellers", "manage_sellers", "verify_accounts"],
  "Listings": ["view_listings", "manage_listings", "remove_listings", "view_reviews", "remove_reviews", "view_content", "remove_content", "flag_content"],
  "Orders": ["view_orders", "manage_orders", "view_cancellations", "manage_cancellations", "view_escalations", "manage_escalations"],
  "Finance": ["view_payments", "manage_payments", "view_commissions", "manage_commissions", "view_refunds", "manage_refunds", "view_payouts", "manage_payouts", "view_financial_reports"],
  "Disputes": ["view_disputes", "manage_disputes", "view_evidence", "manage_evidence", "resolve_disputes", "issue_refund_decisions"],
  "Deliveries": ["view_deliveries", "manage_deliveries", "view_riders", "manage_riders", "view_assignments", "manage_assignments", "view_delivery_status", "manage_delivery_status", "handle_failed_deliveries"],
  "Security": ["view_activity_logs", "view_fraud_signals", "manage_fraud_signals", "view_auth_issues", "manage_suspicious_accounts", "view_security_incidents"],
  "Support": ["view_tickets", "manage_tickets", "view_accounts", "basic_account_help"],
});
const allowed = new Set([...Object.values(ROLE_PERMISSIONS).flat(), ...Object.values(PERMISSION_GROUPS).flat()]);
router.get("/catalog", requireOwner, (req,res)=>res.json({groups:PERMISSION_GROUPS,ownerOnly:["manage_commissions","manage_payments"],note:"Owner-only financial configuration endpoints remain separately protected."}));
router.put("/admins/:id", requireOwner, requireReAuth, async (req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:"Invalid administrator ID."});
  const requested=req.body?.permissions;
  if(!Array.isArray(requested)||requested.length>allowed.size||requested.some(p=>typeof p!=="string"||!allowed.has(p))||new Set(requested).size!==requested.length)
    return res.status(400).json({message:"Permissions must be a unique array of recognized rights."});
  const admin=await Admin.findById(req.params.id);
  if(!admin||admin.tier!=="admin") return res.status(404).json({message:"Standard administrator not found. Owner and Super Admin rights cannot be edited here."});
  const before=[...admin.permissions];
  // Do not acknowledge a permission update without a durable audit entry.
  // Audit logging must be performed before changing the administrator's rights.
  // If audit storage fails, the permission update must fail closed.
  try {
    if (!req.ownerDoc || typeof req.ownerDoc.log !== "function") {
      return res.status(503).json({message:"Owner audit logging unavailable; permissions unchanged."});
    }
    await req.ownerDoc.log("admin_permissions_updated", {
      target:admin.email, targetId:String(admin._id), before, after:requested
    }, req);
  } catch (error) {
    return res.status(503).json({message:"Audit logging failed; permissions unchanged."});
  }
  admin.permissions=requested;
  await admin.save();
  return res.json({message:"Administrator permissions saved.",admin:admin.toPublic()});
});
export default router;

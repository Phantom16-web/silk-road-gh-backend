import express from "express";
import { requireAdminAuth } from "../middleware/adminAuth.js";

// Apply authentication ONLY to matched protected legacy routes.
// /api/admin-auth also contains public login, recovery and bootstrap endpoints.
// A blanket router.use(requireAdminAuth) here would lock every admin out.
const router = express.Router();
const denied = (res, message, code) => res.status(403).json({message, code});
const protectedRoute = (req,res,next) => {
  const path=req.path.replace(/\/+$/, "");
  const isLegacyPermission=req.method==="PUT" && /^\/admin\/[a-f0-9]{24}\/permissions$/i.test(path);
  const isLegacyDelete=req.method==="DELETE" && /^\/(users|listings|riders)\/[a-f0-9]{24}$/i.test(path);
  const finance=req.method==="PUT" ? path.match(/^\/orders\/[a-f0-9]{24}\/(release|refund|refund-complete)$/i) : null;
  if(!isLegacyPermission && !isLegacyDelete && !finance) return next();
  return requireAdminAuth(req,res,()=>{
    if(isLegacyPermission) return denied(res,"Use Owner-only permission studio with fresh reauthentication.","USE_OWNER_PERMISSION_STUDIO");
    if(isLegacyDelete){
      if(path.startsWith("/riders/")) return denied(res,"Rider deletion locked until all obligations are reconciled.","RIDER_DELETION_LOCKED");
      return denied(res,"Use the audited moderation removal workflow.","USE_MODERATION_REMOVAL");
    }
    if(finance && !req.adminUser.isOwner){
      const required=finance[1]==="release" ? "manage_payouts" : "manage_refunds";
      if(!req.adminUser.permissions?.includes(required)) return denied(res,`Explicit ${required} permission required.`,"EXPLICIT_FINANCE_PERMISSION_REQUIRED");
    }
    next();
  });
};
router.use(protectedRoute);
export default router;

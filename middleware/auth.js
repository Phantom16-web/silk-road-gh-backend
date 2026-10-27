import jwt from "jsonwebtoken";
import User from "../models/User.js";

// Always check the current account status, not only a 30-day JWT.
const protect = async (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) return res.status(401).json({message:"Not authorized"});
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) return res.status(401).json({message:"Invalid token"});
    const user = await User.findById(decoded.id).select("_id status role");
    if (!user || user.status !== "Active") return res.status(403).json({message:"Account unavailable or suspended."});
    req.user = {id:String(user._id), role:user.role};
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError" || error.name === "JsonWebTokenError" || error.name === "NotBeforeError")
      return res.status(401).json({message:"Invalid or expired token"});
    console.error("User authentication check failed:",error);
    return res.status(503).json({message:"Authentication temporarily unavailable."});
  }
};
export default protect;

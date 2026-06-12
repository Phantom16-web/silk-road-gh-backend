import { useState } from "react"

const ROLE_COLORS = {
  user:       { bg: "#1e1e24", color: "#888", border: "#2a2a35" },
  support:    { bg: "#1e3a5f22", color: "#93c5fd", border: "#1d4ed8" },
  admin:      { bg: "#064e3b22", color: "#6ee7b7", border: "#065f46" },
  superadmin: { bg: "#78350f22", color: "#fcd34d", border: "#92400e" },
  owner:      { bg: "#c8a97e22", color: "#c8a97e", border: "#c8a97e" },
}

const ROLE_LABELS = {
  user:       "👤 User",
  support:    "🎧 Support Agent",
  admin:      "🛡️ Admin",
  superadmin: "⚡ Super Admin",
  owner:      "👑 Owner",
}

const ALL_PERMISSIONS = [
  { id: "manage_listings",  label: "Manage Listings",  desc: "View, approve, remove listings" },
  { id: "manage_users",     label: "Manage Users",     desc: "View, suspend, delete users" },
  { id: "manage_orders",    label: "Manage Orders",    desc: "View, refund, release orders" },
  { id: "manage_riders",    label: "Manage Riders",    desc: "View, approve, remove riders" },
  { id: "view_revenue",     label: "View Revenue",     desc: "See platform stats and earnings" },
  { id: "manage_promos",    label: "Manage Promos",    desc: "Create and delete promo codes" },
  { id: "handle_complaints",label: "Handle Complaints",desc: "View and resolve user complaints" },
]

const ROLE_DEFAULT_PERMISSIONS = {
  support:    ["handle_complaints"],
  admin:      ["manage_listings", "manage_users", "manage_orders", "manage_riders", "handle_complaints"],
  superadmin: ["manage_listings", "manage_users", "manage_orders", "manage_riders", "view_revenue", "manage_promos", "handle_complaints"],
  owner:      ["manage_listings", "manage_users", "manage_orders", "manage_riders", "view_revenue", "manage_promos", "handle_complaints"],
}

const UNIS = ["KNUST", "UG Legon", "Ashesi", "UDS", "UCC", "GIJ", "UHAS"]

const STATUS_STYLE = {
  "Active":    { bg: "#064e3b22", color: "#6ee7b7",  border: "#065f46" },
  "Completed": { bg: "#064e3b22", color: "#6ee7b7",  border: "#065f46" },
  "Resolved":  { bg: "#064e3b22", color: "#6ee7b7",  border: "#065f46" },
  "Suspended": { bg: "#7f1d1d22", color: "#fca5a5",  border: "#991b1b" },
  "Flagged":   { bg: "#78350f22", color: "#fcd34d",  border: "#92400e" },
  "In Escrow": { bg: "#1e3a5f22", color: "#93c5fd",  border: "#1d4ed8" },
  "Refunded":  { bg: "#78350f22", color: "#fcd34d",  border: "#92400e" },
  "Inactive":  { bg: "#1e1e2422", color: "#666",     border: "#2a2a35" },
  "Open":      { bg: "#7f1d1d22", color: "#fca5a5",  border: "#991b1b" },
}

// ── Initial data ──────────────────────────────────────────────────────────────
const INIT_USERS = [
  { id: 1, name: "Kwame Asante",   email: "kwame@gmail.com",  university: "UG Legon", role: "user",       status: "Active",    joined: "Jan 2025" },
  { id: 2, name: "Ama Serwaa",     email: "ama@gmail.com",    university: "KNUST",    role: "support",    status: "Active",    joined: "Feb 2025" },
  { id: 3, name: "Kofi Mensah",    email: "kofi@gmail.com",   university: "Ashesi",   role: "admin",      status: "Active",    joined: "Jan 2025" },
  { id: 4, name: "Abena Osei",     email: "abena@gmail.com",  university: "UDS",      role: "user",       status: "Suspended", joined: "Mar 2025" },
  { id: 5, name: "Yaw Darko",      email: "yaw@gmail.com",    university: "UCC",      role: "superadmin", status: "Active",    joined: "Jan 2025" },
]

const INIT_LISTINGS = [
  { id: 1, title: "Calculus Textbook",        type: "product", price: 380,  seller: "Kwame A.", status: "Active",  date: "12 Apr 2025" },
  { id: 2, title: "Canon EOS M50 Camera",     type: "rent",    price: 120,  seller: "Ama S.",   status: "Active",  date: "10 Apr 2025" },
  { id: 3, title: "Mathematics Tutoring",     type: "service", price: 80,   seller: "Kofi M.",  status: "Flagged", date: "08 Apr 2025" },
  { id: 4, title: "MacBook Pro M2",           type: "product", price: 8500, seller: "Abena O.", status: "Active",  date: "05 Apr 2025" },
  { id: 5, title: "Room Cleaning Service",    type: "service", price: 60,   seller: "Yaw D.",   status: "Active",  date: "03 Apr 2025" },
]

const INIT_ORDERS = [
  { id: "SR-A1B2C3", item: "Calculus Textbook",  buyer: "Kwame A.", seller: "Ahmad K.", amount: 380,  status: "In Escrow", date: "12 Apr 2025" },
  { id: "SR-D4E5F6", item: "Python Tutoring",    buyer: "Ama S.",   seller: "James O.", amount: 80,   status: "Completed", date: "10 Apr 2025" },
  { id: "SR-G7H8I9", item: "Desk Lamp",          buyer: "Kofi M.",  seller: "Omar A.",  amount: 95,   status: "Refunded",  date: "08 Apr 2025" },
  { id: "SR-J1K2L3", item: "Trek Bicycle",       buyer: "Abena O.", seller: "Elias T.", amount: 1800, status: "In Escrow", date: "05 Apr 2025" },
]

const INIT_RIDERS = [
  { id: 1, name: "Kwame A.", phone: "0241234567", vehicle: "Motorbike", zone: "East Legon", status: "Active",   deliveries: 34 },
  { id: 2, name: "Ama T.",   phone: "0501234567", vehicle: "Bicycle",   zone: "KNUST Area", status: "Active",   deliveries: 18 },
  { id: 3, name: "Kofi B.",  phone: "0271234567", vehicle: "Walking",   zone: "Ayeduase",   status: "Inactive", deliveries: 7  },
]

const INIT_COMPLAINTS = [
  { id: 1, from: "Kwame A.", issue: "Seller never delivered my item",          status: "Open",     date: "12 Apr 2025", response: "" },
  { id: 2, from: "Ama S.",   issue: "Item was in worse condition than described", status: "Resolved", date: "10 Apr 2025", response: "Refund issued." },
  { id: 3, from: "Kofi M.",  issue: "Rider was very late and rude",            status: "Open",     date: "08 Apr 2025", response: "" },
]

const INIT_LOGS = [
  { time: "Today 14:32",      admin: "Kofi M. (Admin)",      action: "Removed listing: MacBook Pro M2" },
  { time: "Today 13:15",      admin: "Ama S. (Support)",     action: "Resolved complaint #2" },
  { time: "Today 11:04",      admin: "Yaw D. (Super Admin)", action: "Suspended user: Abena Osei" },
  { time: "Yesterday 16:22",  admin: "Kofi M. (Admin)",      action: "Added promo code: WELCOME10" },
  { time: "Yesterday 10:11",  admin: "Ama S. (Support)",     action: "Flagged listing: Mathematics Tutoring" },
]

const INIT_PROMOS = [
  { id: 1, code: "WELCOME10", type: "percentage",    value: 10, target: "all",        uni: null,    user: null,              uses: 24, active: true },
  { id: 2, code: "KNUST20",   type: "percentage",    value: 20, target: "university", uni: "KNUST", user: null,              uses: 8,  active: true },
]

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api"

export default function AdminPanel({ onClose, siteSettings, onUpdateSiteSettings }) {
  const [authStep, setAuthStep] = useState("login")
  const [credentials, setCredentials] = useState({ key: "" })
  const [currentRole, setCurrentRole] = useState(null)
  const [currentPermissions, setCurrentPermissions] = useState([])
  const [loginError, setLoginError] = useState("")
  const [loginLoading, setLoginLoading] = useState(false)
  const [activeTab, setActiveTab] = useState("dashboard")

  // Live state
  const [users, setUsers] = useState(INIT_USERS)
  const [listings, setListings] = useState(INIT_LISTINGS)
  const [orders, setOrders] = useState(INIT_ORDERS)
  const [riders, setRiders] = useState(INIT_RIDERS)
  const [complaints, setComplaints] = useState(INIT_COMPLAINTS)
  const [logs, setLogs] = useState(INIT_LOGS)
  const [promos, setPromos] = useState(INIT_PROMOS)

  // Promo form
  const [promoForm, setPromoForm] = useState({ code: "", type: "percentage", value: "", target: "all", uni: "", user: "", freeDelivery: false })
  const [promoErrors, setPromoErrors] = useState({})

  // Admin mgmt
  const [adminForm, setAdminForm] = useState({ name: "", email: "", role: "support", permissions: [] })
  const [masterKeyInput, setMasterKeyInput] = useState("")
  const [masterKeyVerified, setMasterKeyVerified] = useState(false)
  const [masterKeyError, setMasterKeyError] = useState("")

  // Complaint response
  const [respondingTo, setRespondingTo] = useState(null)
  const [responseText, setResponseText] = useState("")

  // ── Logging ──────────────────────────────────────────────────────────────
  const addLog = (action) => {
    if (currentRole === "owner") return
    const entry = {
      time: `Today ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
      admin: `${currentRole === "superadmin" ? "Super Admin" : currentRole === "admin" ? "Admin" : "Support"}`,
      action,
    }
    setLogs(l => [entry, ...l])
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    setLoginError("")
    setLoginLoading(true)
    try {
      const res = await fetch(`${API_URL}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: credentials.key }),
      })
      const data = await res.json()
      if (data.role) {
        setCurrentRole(data.role)
        setCurrentPermissions(data.permissions || [])
        sessionStorage.setItem("silkroad_admin_token", data.token)
        setAuthStep("panel")
      } else {
        setLoginError(data.message || "Invalid credentials. Access denied.")
      }
    } catch {
      setLoginError("Could not connect to server. Please try again.")
    }
    setLoginLoading(false)
  }

  const hasPermission = (perm) => currentRole === "owner" || currentRole === "superadmin" || currentPermissions.includes(perm)

  // ── Promo ─────────────────────────────────────────────────────────────────
  const handleAddPromo = () => {
    const e = {}
    if (!promoForm.code.trim()) e.code = "Please enter a code."
    if (!promoForm.value && !promoForm.freeDelivery) e.value = "Please enter a discount value."
    if (promoForm.target === "university" && !promoForm.uni) e.uni = "Please select a university."
    if (promoForm.target === "user" && !promoForm.user.trim()) e.user = "Please enter a user email."
    if (Object.keys(e).length > 0) { setPromoErrors(e); return }
    const newPromo = {
      id: Date.now(),
      code: promoForm.code.toUpperCase(),
      type: promoForm.freeDelivery ? "free_delivery" : promoForm.type,
      value: promoForm.freeDelivery ? 0 : Number(promoForm.value),
      target: promoForm.target,
      uni: promoForm.uni || null,
      user: promoForm.user || null,
      uses: 0,
      active: true,
    }
    setPromos(p => [...p, newPromo])
    setPromoForm({ code: "", type: "percentage", value: "", target: "all", uni: "", user: "", freeDelivery: false })
    setPromoErrors({})
    addLog(`Added promo code: ${newPromo.code}`)
  }

  const handleDeletePromo = (id, code) => {
    if (!window.confirm(`Delete promo code ${code}?`)) return
    setPromos(p => p.filter(x => x.id !== id))
    addLog(`Deleted promo code: ${code}`)
  }

  const handleTogglePromo = (id) => {
    setPromos(p => p.map(x => x.id === id ? { ...x, active: !x.active } : x))
  }

  // ── Master key verification ────────────────────────────────────────────────
  const handleVerifyMasterKey = async () => {
    setMasterKeyError("")
    try {
      const res = await fetch(`${API_URL}/admin/verify-master`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: masterKeyInput }),
      })
      const data = await res.json()
      if (data.valid) setMasterKeyVerified(true)
      else setMasterKeyError("Invalid master key.")
    } catch {
      setMasterKeyError("Could not connect to server.")
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const Badge = ({ status }) => (
    <span style={{ fontSize: "10px", fontWeight: "700", background: STATUS_STYLE[status]?.bg, color: STATUS_STYLE[status]?.color, border: `1px solid ${STATUS_STYLE[status]?.border}`, padding: "3px 10px", borderRadius: "20px", flexShrink: 0 }}>
      {status}
    </span>
  )

  const RoleBadge = ({ role }) => (
    <span style={{ fontSize: "10px", fontWeight: "700", background: ROLE_COLORS[role]?.bg, color: ROLE_COLORS[role]?.color, border: `1px solid ${ROLE_COLORS[role]?.border}`, padding: "3px 10px", borderRadius: "20px" }}>
      {ROLE_LABELS[role]}
    </span>
  )

  const inputStyle = {
    width: "100%", background: "#1e1e1e", border: "1px solid #333",
    color: "#fff", padding: "10px 14px", borderRadius: "8px",
    fontSize: "13px", outline: "none", boxSizing: "border-box", fontFamily: "inherit",
  }

  // ── Revenue stats ─────────────────────────────────────────────────────────
  const totalRevenue = orders.filter(o => o.status === "Completed").reduce((sum, o) => sum + Math.round(o.amount * 0.08), 0)
  const totalVolume = orders.filter(o => o.status === "Completed").reduce((sum, o) => sum + o.amount, 0)
  const escrowHeld = orders.filter(o => o.status === "In Escrow").reduce((sum, o) => sum + o.amount, 0)

  // ── TABS ──────────────────────────────────────────────────────────────────
  const TABS = [
    { id: "dashboard",  label: "📊 Dashboard",     always: true },
    { id: "listings",   label: "📦 Listings",       perm: "manage_listings" },
    { id: "users",      label: "👤 Users",          perm: "manage_users" },
    { id: "orders",     label: "🧾 Orders",         perm: "manage_orders" },
    { id: "riders",     label: "🛵 Riders",         perm: "manage_riders" },
    { id: "promos",     label: "🎟️ Promos",         perm: "manage_promos" },
    { id: "complaints", label: "📢 Complaints",     perm: "handle_complaints" },
    { id: "logs",       label: "📋 Logs",           always: true },
    { id: "settings",   label: "⚙️ Site Settings",  superadmin: true },
    { id: "admins",     label: "🔐 Admin Mgmt",     owner: true },
  ].filter(t =>
    t.always ||
    (t.superadmin && (currentRole === "owner" || currentRole === "superadmin")) ||
    (t.owner && (currentRole === "owner" || currentRole === "superadmin")) ||
    (t.perm && hasPermission(t.perm))
  )

  // ── LOGIN SCREEN ──────────────────────────────────────────────────────────
  if (authStep === "login") return (
    <div style={{ position: "fixed", inset: 0, background: "#000000ee", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ background: "#111", borderRadius: "16px", width: "100%", maxWidth: "420px", border: "1px solid #1e1e1e", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #1e1e1e", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "28px", height: "28px", background: "linear-gradient(135deg,#c8a97e,#9a7040)", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>🕸</div>
            <span style={{ fontSize: "16px", fontWeight: "700", color: "#f0ede8" }}>Silk Road GH · Admin</span>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#666", fontSize: "22px", cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: "28px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "40px", marginBottom: "8px" }}>🔐</div>
            <div style={{ fontSize: "15px", fontWeight: "700", color: "#f0ede8" }}>Admin Access</div>
            <div style={{ fontSize: "13px", color: "#555", marginTop: "4px" }}>Enter your admin key or email</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "#888", fontWeight: "600", marginBottom: "6px" }}>ACCESS KEY OR EMAIL</div>
            <input
              placeholder="Enter your key or admin email..."
              value={credentials.key}
              onChange={e => setCredentials({ key: e.target.value })}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              style={{ ...inputStyle, padding: "12px 16px", fontSize: "14px", border: `1px solid ${loginError ? "#991b1b" : "#333"}` }}
            />
          </div>
          {loginError && (
            <div style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", borderRadius: "10px", padding: "12px", fontSize: "13px", color: "#fca5a5", textAlign: "center" }}>
              🚫 {loginError}
            </div>
          )}
          <button onClick={handleLogin} disabled={loginLoading}
            style={{ background: "#c8a97e", border: "none", padding: "13px", borderRadius: "10px", fontWeight: "700", cursor: loginLoading ? "not-allowed" : "pointer", fontSize: "15px", fontFamily: "inherit", opacity: loginLoading ? 0.7 : 1 }}>
            {loginLoading ? "⏳ Verifying..." : "Access Panel →"}
          </button>
          <div style={{ textAlign: "center", fontSize: "12px", color: "#444" }}>Unauthorized access attempts are logged.</div>
        </div>
      </div>
    </div>
  )

  // ── PANEL ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000ee", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ background: "#111", borderRadius: "16px", width: "100%", maxWidth: "900px", maxHeight: "92vh", display: "flex", flexDirection: "column", border: "1px solid #1e1e1e", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #1e1e1e", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#111", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "16px", fontWeight: "700", color: "#f0ede8" }}>Silk Road GH · Admin</span>
            <RoleBadge role={currentRole} />
          </div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            {currentRole !== "owner" && <div style={{ fontSize: "12px", color: "#555" }}>Actions logged</div>}
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#666", fontSize: "22px", cursor: "pointer" }}>✕</button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: "2px", padding: "0 16px", borderBottom: "1px solid #1e1e1e", overflowX: "auto", flexShrink: 0, background: "#0d0d0f" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ background: "transparent", border: "none", color: activeTab === t.id ? "#c8a97e" : "#555", cursor: "pointer", fontSize: "12px", fontWeight: "600", padding: "12px 14px", borderBottom: `2px solid ${activeTab === t.id ? "#c8a97e" : "transparent"}`, whiteSpace: "nowrap", fontFamily: "inherit" }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>

          {/* ── DASHBOARD ── */}
          {activeTab === "dashboard" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>Platform Overview</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
                {[
                  ["📦", "Total Listings", listings.length, `${listings.filter(l => l.status === "Active").length} active`],
                  ["👤", "Total Users", users.length, `${users.filter(u => u.status === "Active").length} active`],
                  ["🧾", "Total Orders", orders.length, `${orders.filter(o => o.status === "In Escrow").length} in escrow`],
                  ["🛵", "Active Riders", riders.filter(r => r.status === "Active").length, `${riders.length} total`],
                  ["💰", "Platform Revenue", `₵${totalRevenue}`, `Vol: ₵${totalVolume}`],
                  ["🔒", "Escrow Held", `₵${escrowHeld}`, `${orders.filter(o => o.status === "In Escrow").length} orders`],
                ].map(([icon, label, value, sub]) => (
                  <div key={label} style={{ background: "#1a1a1a", border: "1px solid #1e1e1e", borderRadius: "12px", padding: "16px" }}>
                    <div style={{ fontSize: "24px", marginBottom: "8px" }}>{icon}</div>
                    <div style={{ fontSize: "20px", fontWeight: "700", color: "#c8a97e" }}>{value}</div>
                    <div style={{ fontSize: "12px", color: "#888", marginTop: "2px" }}>{label}</div>
                    <div style={{ fontSize: "11px", color: "#555", marginTop: "4px" }}>{sub}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "18px", border: "1px solid #1e1e1e" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8", marginBottom: "14px" }}>Recent Activity</div>
                {logs.slice(0, 4).map((log, i) => (
                  <div key={i} style={{ display: "flex", gap: "12px", padding: "10px 0", borderBottom: i < 3 ? "1px solid #1e1e1e" : "none", fontSize: "13px" }}>
                    <span style={{ color: "#555", minWidth: "120px", flexShrink: 0 }}>{log.time}</span>
                    <span style={{ color: "#888" }}><span style={{ color: "#c8a97e" }}>{log.admin}</span> — {log.action}</span>
                  </div>
                ))}
              </div>
              {complaints.filter(c => c.status === "Open").length > 0 && (
                <div style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", borderRadius: "10px", padding: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "13px", color: "#fca5a5" }}>⚠️ {complaints.filter(c => c.status === "Open").length} open complaints need attention</span>
                  <button onClick={() => setActiveTab("complaints")}
                    style={{ background: "#7f1d1d", border: "none", color: "#fca5a5", padding: "6px 14px", borderRadius: "8px", cursor: "pointer", fontSize: "12px", fontWeight: "600", fontFamily: "inherit" }}>
                    View →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── LISTINGS ── */}
          {activeTab === "listings" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>All Listings</h2>
                <span style={{ fontSize: "12px", color: "#555" }}>{listings.length} total · {listings.filter(l => l.status === "Flagged").length} flagged</span>
              </div>
              {listings.map(listing => (
                <div key={listing.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid #1e1e1e" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "14px", fontWeight: "600", color: "#f0ede8", marginBottom: "4px" }}>{listing.title}</div>
                    <div style={{ fontSize: "12px", color: "#666" }}>
                      <span style={{ color: "#c8a97e", fontWeight: "600", textTransform: "capitalize" }}>{listing.type}</span>
                      {" "}· by {listing.seller} · ₵{listing.price} · {listing.date}
                    </div>
                  </div>
                  <Badge status={listing.status} />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => {
                        const newStatus = listing.status === "Flagged" ? "Active" : "Flagged"
                        setListings(l => l.map(x => x.id === listing.id ? { ...x, status: newStatus } : x))
                        addLog(`${newStatus === "Flagged" ? "Flagged" : "Unflagged"} listing: ${listing.title}`)
                      }}
                      style={{ background: "#78350f22", border: "1px solid #92400e", color: "#fcd34d", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      {listing.status === "Flagged" ? "Unflag" : "Flag"}
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`Remove "${listing.title}"?`)) return
                        setListings(l => l.filter(x => x.id !== listing.id))
                        addLog(`Removed listing: ${listing.title}`)
                      }}
                      style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── USERS ── */}
          {activeTab === "users" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>All Users</h2>
                <span style={{ fontSize: "12px", color: "#555" }}>{users.length} total · {users.filter(u => u.status === "Suspended").length} suspended</span>
              </div>
              {users.map(u => (
                <div key={u.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid #1e1e1e" }}>
                  <div style={{ width: "38px", height: "38px", borderRadius: "50%", background: "#c8a97e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: "700", color: "#000", flexShrink: 0 }}>
                    {u.name.charAt(0)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "14px", fontWeight: "600", color: "#f0ede8", marginBottom: "4px" }}>{u.name}</div>
                    <div style={{ fontSize: "12px", color: "#666" }}>{u.email} · {u.university} · Joined {u.joined}</div>
                  </div>
                  <RoleBadge role={u.role} />
                  <Badge status={u.status} />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => {
                        const newStatus = u.status === "Suspended" ? "Active" : "Suspended"
                        setUsers(us => us.map(x => x.id === u.id ? { ...x, status: newStatus } : x))
                        addLog(`${newStatus === "Suspended" ? "Suspended" : "Reinstated"} user: ${u.name}`)
                      }}
                      style={{ background: u.status === "Suspended" ? "#064e3b22" : "#7f1d1d22", border: `1px solid ${u.status === "Suspended" ? "#065f46" : "#7f1d1d"}`, color: u.status === "Suspended" ? "#6ee7b7" : "#fca5a5", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      {u.status === "Suspended" ? "Reinstate" : "Suspend"}
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`Delete user ${u.name}? This cannot be undone.`)) return
                        setUsers(us => us.filter(x => x.id !== u.id))
                        addLog(`Deleted user: ${u.name}`)
                      }}
                      style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── ORDERS ── */}
          {activeTab === "orders" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>All Orders</h2>
                <span style={{ fontSize: "12px", color: "#555" }}>₵{escrowHeld} in escrow</span>
              </div>
              {orders.map(order => (
                <div key={order.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "14px 16px", border: "1px solid #1e1e1e" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: order.status === "In Escrow" ? "12px" : "0" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: "14px", fontWeight: "600", color: "#f0ede8", marginBottom: "4px" }}>{order.item}</div>
                      <div style={{ fontSize: "12px", color: "#666" }}>Buyer: {order.buyer} · Seller: {order.seller} · {order.date}</div>
                      <div style={{ fontSize: "11px", color: "#555", marginTop: "2px", fontFamily: "monospace" }}>{order.id}</div>
                    </div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#c8a97e" }}>₵{order.amount}</div>
                    <Badge status={order.status} />
                  </div>
                  {order.status === "In Escrow" && (
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => {
                          setOrders(o => o.map(x => x.id === order.id ? { ...x, status: "Completed" } : x))
                          addLog(`Released escrow for order ${order.id}: ${order.item}`)
                        }}
                        style={{ background: "#064e3b22", border: "1px solid #065f46", color: "#6ee7b7", padding: "7px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600", fontFamily: "inherit" }}>
                        ✅ Release to Seller
                      </button>
                      <button
                        onClick={() => {
                          setOrders(o => o.map(x => x.id === order.id ? { ...x, status: "Refunded" } : x))
                          addLog(`Refunded order ${order.id}: ${order.item}`)
                        }}
                        style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "7px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600", fontFamily: "inherit" }}>
                        💸 Refund Buyer
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── RIDERS ── */}
          {activeTab === "riders" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>All Riders</h2>
                <span style={{ fontSize: "12px", color: "#555" }}>{riders.filter(r => r.status === "Active").length} active · {riders.length} total</span>
              </div>
              {riders.map(rider => (
                <div key={rider.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid #1e1e1e" }}>
                  <div style={{ fontSize: "28px" }}>{rider.vehicle === "Motorbike" ? "🛵" : rider.vehicle === "Bicycle" ? "🚲" : "🚶"}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "14px", fontWeight: "600", color: "#f0ede8", marginBottom: "4px" }}>{rider.name}</div>
                    <div style={{ fontSize: "12px", color: "#666" }}>{rider.phone} · {rider.zone} · {rider.deliveries} deliveries</div>
                  </div>
                  <Badge status={rider.status} />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => {
                        const newStatus = rider.status === "Active" ? "Inactive" : "Active"
                        setRiders(r => r.map(x => x.id === rider.id ? { ...x, status: newStatus } : x))
                        addLog(`${newStatus === "Active" ? "Activated" : "Deactivated"} rider: ${rider.name}`)
                      }}
                      style={{ background: rider.status === "Active" ? "#7f1d1d22" : "#064e3b22", border: `1px solid ${rider.status === "Active" ? "#7f1d1d" : "#065f46"}`, color: rider.status === "Active" ? "#fca5a5" : "#6ee7b7", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      {rider.status === "Active" ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`Remove rider ${rider.name}?`)) return
                        setRiders(r => r.filter(x => x.id !== rider.id))
                        addLog(`Removed rider: ${rider.name}`)
                      }}
                      style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── PROMOS ── */}
          {activeTab === "promos" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>Promo Codes</h2>

              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8", marginBottom: "16px" }}>➕ Create Promo Code</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div>
                      <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>CODE</div>
                      <input placeholder="e.g. WELCOME10" value={promoForm.code} onChange={e => setPromoForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} style={inputStyle} />
                      {promoErrors.code && <div style={{ fontSize: "11px", color: "#fca5a5", marginTop: "4px" }}>⚠️ {promoErrors.code}</div>}
                    </div>
                    <div>
                      <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>TYPE</div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        {[["percentage", "% Off"], ["fixed", "₵ Off"]].map(([v, l]) => (
                          <button key={v} onClick={() => setPromoForm(f => ({ ...f, type: v, freeDelivery: false }))}
                            style={{ flex: 1, padding: "9px", borderRadius: "7px", border: `1.5px solid ${promoForm.type === v && !promoForm.freeDelivery ? "#c8a97e" : "#2a2a2a"}`, background: promoForm.type === v && !promoForm.freeDelivery ? "#c8a97e22" : "#111", color: promoForm.type === v && !promoForm.freeDelivery ? "#c8a97e" : "#888", cursor: "pointer", fontWeight: "600", fontSize: "12px", fontFamily: "inherit" }}>
                            {l}
                          </button>
                        ))}
                        <button onClick={() => setPromoForm(f => ({ ...f, freeDelivery: !f.freeDelivery }))}
                          style={{ flex: 1, padding: "9px", borderRadius: "7px", border: `1.5px solid ${promoForm.freeDelivery ? "#c8a97e" : "#2a2a2a"}`, background: promoForm.freeDelivery ? "#c8a97e22" : "#111", color: promoForm.freeDelivery ? "#c8a97e" : "#888", cursor: "pointer", fontWeight: "600", fontSize: "11px", fontFamily: "inherit" }}>
                          🛵 Free
                        </button>
                      </div>
                    </div>
                  </div>

                  {!promoForm.freeDelivery && (
                    <div>
                      <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>
                        {promoForm.type === "percentage" ? "DISCOUNT %" : "DISCOUNT AMOUNT (₵)"}
                      </div>
                      <input placeholder={promoForm.type === "percentage" ? "e.g. 10" : "e.g. 20"} type="number" value={promoForm.value} onChange={e => setPromoForm(f => ({ ...f, value: e.target.value }))} style={inputStyle} />
                      {promoErrors.value && <div style={{ fontSize: "11px", color: "#fca5a5", marginTop: "4px" }}>⚠️ {promoErrors.value}</div>}
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "8px" }}>WHO CAN USE IT?</div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      {[["all", "👥 Everyone"], ["university", "🏫 University"], ["user", "👤 Specific User"]].map(([v, l]) => (
                        <button key={v} onClick={() => setPromoForm(f => ({ ...f, target: v, uni: "", user: "" }))}
                          style={{ flex: 1, padding: "9px 6px", borderRadius: "7px", border: `1.5px solid ${promoForm.target === v ? "#c8a97e" : "#2a2a2a"}`, background: promoForm.target === v ? "#c8a97e22" : "#111", color: promoForm.target === v ? "#c8a97e" : "#888", cursor: "pointer", fontWeight: "600", fontSize: "11px", fontFamily: "inherit", textAlign: "center" }}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>

                  {promoForm.target === "university" && (
                    <div>
                      <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "8px" }}>SELECT UNIVERSITY</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                        {UNIS.map(u => (
                          <button key={u} onClick={() => setPromoForm(f => ({ ...f, uni: u }))}
                            style={{ padding: "6px 12px", borderRadius: "20px", border: `1.5px solid ${promoForm.uni === u ? "#c8a97e" : "#2a2a2a"}`, background: promoForm.uni === u ? "#c8a97e22" : "#111", color: promoForm.uni === u ? "#c8a97e" : "#888", cursor: "pointer", fontWeight: "600", fontSize: "11px", fontFamily: "inherit" }}>
                            {u}
                          </button>
                        ))}
                      </div>
                      {promoErrors.uni && <div style={{ fontSize: "11px", color: "#fca5a5", marginTop: "4px" }}>⚠️ {promoErrors.uni}</div>}
                    </div>
                  )}

                  {promoForm.target === "user" && (
                    <div>
                      <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>USER EMAIL</div>
                      <input placeholder="e.g. student@gmail.com" value={promoForm.user} onChange={e => setPromoForm(f => ({ ...f, user: e.target.value }))} style={inputStyle} />
                      {promoErrors.user && <div style={{ fontSize: "11px", color: "#fca5a5", marginTop: "4px" }}>⚠️ {promoErrors.user}</div>}
                    </div>
                  )}

                  <button onClick={handleAddPromo}
                    style={{ background: "#c8a97e", border: "none", padding: "12px", borderRadius: "8px", fontWeight: "700", cursor: "pointer", fontSize: "14px", fontFamily: "inherit" }}>
                    ➕ Add Promo Code
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {promos.map(promo => (
                  <div key={promo.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid #1e1e1e" }}>
                    <div style={{ background: "#c8a97e22", border: "1px solid #c8a97e44", borderRadius: "8px", padding: "6px 12px", fontWeight: "800", fontSize: "14px", color: "#c8a97e", letterSpacing: ".08em", flexShrink: 0 }}>
                      {promo.code}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: "13px", color: "#f0ede8", fontWeight: "600" }}>
                        {promo.type === "free_delivery" ? "🛵 Free Delivery" : promo.type === "percentage" ? `${promo.value}% off` : `₵${promo.value} off`}
                      </div>
                      <div style={{ fontSize: "11px", color: "#666", marginTop: "2px" }}>
                        {promo.target === "all" ? "Everyone" : promo.target === "university" ? `${promo.uni} only` : `User: ${promo.user}`} · {promo.uses} uses
                      </div>
                    </div>
                    <div onClick={() => handleTogglePromo(promo.id)}
                      style={{ width: "36px", height: "20px", background: promo.active ? "#c8a97e" : "#2a2a2a", borderRadius: "20px", position: "relative", cursor: "pointer", transition: "background .2s", flexShrink: 0 }}>
                      <div style={{ position: "absolute", top: "3px", left: promo.active ? "18px" : "3px", width: "14px", height: "14px", background: "#fff", borderRadius: "50%", transition: "left .2s" }} />
                    </div>
                    <button onClick={() => handleDeletePromo(promo.id, promo.code)}
                      style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── COMPLAINTS ── */}
          {activeTab === "complaints" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>Complaints</h2>
                <span style={{ fontSize: "12px", color: "#555" }}>{complaints.filter(c => c.status === "Open").length} open</span>
              </div>
              {complaints.map(c => (
                <div key={c.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "16px", border: "1px solid #1e1e1e" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: "600", color: "#f0ede8", marginBottom: "4px" }}>{c.issue}</div>
                      <div style={{ fontSize: "12px", color: "#666" }}>From: {c.from} · {c.date}</div>
                    </div>
                    <Badge status={c.status} />
                  </div>

                  {c.response && (
                    <div style={{ background: "#064e3b22", border: "1px solid #065f46", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", color: "#6ee7b7", marginBottom: "10px" }}>
                      ✅ Response: {c.response}
                    </div>
                  )}

                  {c.status === "Open" && (
                    <>
                      {respondingTo === c.id ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          <textarea
                            placeholder="Type your response to the user..."
                            value={responseText}
                            onChange={e => setResponseText(e.target.value)}
                            rows={3}
                            style={{ ...inputStyle, resize: "vertical" }}
                          />
                          <div style={{ display: "flex", gap: "8px" }}>
                            <button onClick={() => { setRespondingTo(null); setResponseText("") }}
                              style={{ flex: 1, background: "#1e1e1e", border: "1px solid #333", color: "#aaa", padding: "9px", borderRadius: "8px", cursor: "pointer", fontWeight: "600", fontFamily: "inherit" }}>
                              Cancel
                            </button>
                            <button onClick={() => {
                              if (!responseText.trim()) return
                              setComplaints(cs => cs.map(x => x.id === c.id ? { ...x, status: "Resolved", response: responseText } : x))
                              addLog(`Resolved complaint from ${c.from}`)
                              setRespondingTo(null)
                              setResponseText("")
                            }}
                              style={{ flex: 2, background: "#064e3b", border: "1px solid #065f46", color: "#6ee7b7", padding: "9px", borderRadius: "8px", cursor: "pointer", fontWeight: "700", fontFamily: "inherit" }}>
                              ✅ Send & Resolve
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "8px" }}>
                          <button
                            onClick={() => {
                              setComplaints(cs => cs.map(x => x.id === c.id ? { ...x, status: "Resolved", response: "Marked as resolved by admin." } : x))
                              addLog(`Resolved complaint from ${c.from}`)
                            }}
                            style={{ background: "#064e3b22", border: "1px solid #065f46", color: "#6ee7b7", padding: "7px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600", fontFamily: "inherit" }}>
                            ✅ Mark Resolved
                          </button>
                          <button onClick={() => { setRespondingTo(c.id); setResponseText("") }}
                            style={{ background: "#1e1e1e", border: "1px solid #333", color: "#aaa", padding: "7px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600", fontFamily: "inherit" }}>
                            💬 Respond
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── LOGS ── */}
          {activeTab === "logs" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>Activity Logs</h2>
                <span style={{ fontSize: "12px", color: "#555" }}>{logs.length} entries</span>
              </div>
              <div style={{ background: "#1a1a1a", borderRadius: "12px", border: "1px solid #1e1e1e", overflow: "hidden" }}>
                {logs.map((log, i) => (
                  <div key={i} style={{ display: "flex", gap: "16px", padding: "14px 16px", borderBottom: i < logs.length - 1 ? "1px solid #1e1e1e" : "none", fontSize: "13px" }}>
                    <span style={{ color: "#555", minWidth: "130px", flexShrink: 0 }}>{log.time}</span>
                    <span style={{ color: "#888" }}><span style={{ color: "#c8a97e", fontWeight: "600" }}>{log.admin}</span> — {log.action}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: "12px", color: "#444", textAlign: "center" }}>Owner actions are never logged.</div>
            </div>
          )}

          {/* ── SITE SETTINGS ── */}
          {activeTab === "settings" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>Site Settings</h2>
              <p style={{ fontSize: "13px", color: "#666", marginTop: "-12px" }}>Changes apply immediately across the entire platform.</p>

              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8" }}>📞 Contact Info</div>
                <div>
                  <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>PHONE NUMBER</div>
                  <input value={siteSettings.contactPhone} onChange={e => onUpdateSiteSettings(s => ({ ...s, contactPhone: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>WHATSAPP (digits only, with country code)</div>
                  <input value={siteSettings.contactWhatsApp} onChange={e => onUpdateSiteSettings(s => ({ ...s, contactWhatsApp: e.target.value }))} style={inputStyle} />
                </div>
              </div>

              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8" }}>🛵 Delivery Fee</div>
                <div style={{ fontSize: "13px", color: "#888" }}>Fixed platform delivery rate charged to buyers per order.</div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <div style={{ fontSize: "16px", color: "#c8a97e", fontWeight: "700" }}>₵</div>
                  <input type="number" value={siteSettings.deliveryFee ?? 10} onChange={e => onUpdateSiteSettings(s => ({ ...s, deliveryFee: Number(e.target.value) }))} style={{ ...inputStyle, width: "120px" }} />
                </div>
                <div style={{ fontSize: "12px", color: "#555" }}>Riders receive 100% of this fee. Silk Road takes no cut from deliveries.</div>
              </div>

              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8" }}>🦶 Footer Tagline</div>
                <textarea value={siteSettings.footerTagline} onChange={e => onUpdateSiteSettings(s => ({ ...s, footerTagline: e.target.value }))} rows={3}
                  style={{ ...inputStyle, resize: "vertical" }} />
              </div>

              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8" }}>ℹ️ About Text</div>
                <textarea value={siteSettings.aboutText} onChange={e => onUpdateSiteSettings(s => ({ ...s, aboutText: e.target.value }))} rows={5}
                  style={{ ...inputStyle, resize: "vertical" }} />
              </div>

              <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8" }}>🔒 Privacy Policy (Information We Collect)</div>
                <textarea value={siteSettings.privacyText} onChange={e => onUpdateSiteSettings(s => ({ ...s, privacyText: e.target.value }))} rows={5}
                  style={{ ...inputStyle, resize: "vertical" }} />
              </div>

              <div style={{ background: "#064e3b22", border: "1px solid #065f46", borderRadius: "10px", padding: "12px", fontSize: "13px", color: "#6ee7b7" }}>
                ✅ All changes apply instantly. No save button needed.
              </div>
            </div>
          )}

          {/* ── ADMIN MANAGEMENT ── */}
          {activeTab === "admins" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#f0ede8" }}>Admin Management</h2>

              {!masterKeyVerified && currentRole !== "owner" && (
                <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #92400e" }}>
                  <div style={{ fontSize: "14px", fontWeight: "700", color: "#fcd34d", marginBottom: "12px" }}>🔑 Master Key Required</div>
                  <div style={{ display: "flex", gap: "10px" }}>
                    <input placeholder="Enter master key..." type="password" value={masterKeyInput} onChange={e => setMasterKeyInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleVerifyMasterKey()}
                      style={{ flex: 1, ...inputStyle }} />
                    <button onClick={handleVerifyMasterKey}
                      style={{ background: "#c8a97e", border: "none", padding: "10px 20px", borderRadius: "8px", fontWeight: "700", cursor: "pointer", fontSize: "13px", fontFamily: "inherit" }}>
                      Verify
                    </button>
                  </div>
                  {masterKeyError && <div style={{ fontSize: "12px", color: "#fca5a5", marginTop: "8px" }}>⚠️ {masterKeyError}</div>}
                </div>
              )}

              {(masterKeyVerified || currentRole === "owner") && (
                <>
                  <div style={{ background: "#1a1a1a", borderRadius: "12px", padding: "20px", border: "1px solid #1e1e1e" }}>
                    <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8", marginBottom: "16px" }}>➕ Add Admin</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                        <div>
                          <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>NAME</div>
                          <input placeholder="Full name" value={adminForm.name} onChange={e => setAdminForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
                        </div>
                        <div>
                          <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "5px" }}>EMAIL</div>
                          <input placeholder="email@example.com" value={adminForm.email} onChange={e => setAdminForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} />
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "8px" }}>ROLE</div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {["support", "admin", "superadmin"].map(r => (
                            <button key={r} onClick={() => setAdminForm(f => ({ ...f, role: r, permissions: ROLE_DEFAULT_PERMISSIONS[r] || [] }))}
                              style={{ flex: 1, padding: "9px", borderRadius: "7px", border: `1.5px solid ${adminForm.role === r ? ROLE_COLORS[r].border : "#2a2a2a"}`, background: adminForm.role === r ? ROLE_COLORS[r].bg : "#111", color: adminForm.role === r ? ROLE_COLORS[r].color : "#888", cursor: "pointer", fontWeight: "600", fontSize: "11px", fontFamily: "inherit" }}>
                              {ROLE_LABELS[r]}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: "11px", color: "#888", fontWeight: "600", marginBottom: "8px" }}>PERMISSIONS</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {ALL_PERMISSIONS.map(perm => (
                            <div key={perm.id}
                              onClick={() => setAdminForm(f => ({ ...f, permissions: f.permissions.includes(perm.id) ? f.permissions.filter(p => p !== perm.id) : [...f.permissions, perm.id] }))}
                              style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "8px", background: adminForm.permissions.includes(perm.id) ? "#c8a97e11" : "#111", border: `1px solid ${adminForm.permissions.includes(perm.id) ? "#c8a97e44" : "#2a2a2a"}`, cursor: "pointer" }}>
                              <div style={{ width: "16px", height: "16px", borderRadius: "4px", background: adminForm.permissions.includes(perm.id) ? "#c8a97e" : "#1e1e1e", border: `1.5px solid ${adminForm.permissions.includes(perm.id) ? "#c8a97e" : "#444"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                {adminForm.permissions.includes(perm.id) && <span style={{ fontSize: "10px", color: "#000", fontWeight: "800" }}>✓</span>}
                              </div>
                              <div>
                                <div style={{ fontSize: "13px", fontWeight: "600", color: "#f0ede8" }}>{perm.label}</div>
                                <div style={{ fontSize: "11px", color: "#666" }}>{perm.desc}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          if (!adminForm.name.trim() || !adminForm.email.trim()) { alert("Please fill in name and email."); return }
                          const newAdmin = { id: Date.now(), name: adminForm.name, email: adminForm.email, university: "N/A", role: adminForm.role, status: "Active", joined: new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" }) }
                          setUsers(u => [...u, newAdmin])
                          addLog(`Added ${ROLE_LABELS[adminForm.role]}: ${adminForm.name}`)
                          setAdminForm({ name: "", email: "", role: "support", permissions: [] })
                          alert(`${adminForm.name} added as ${ROLE_LABELS[adminForm.role]}`)
                        }}
                        style={{ background: "#c8a97e", border: "none", padding: "12px", borderRadius: "8px", fontWeight: "700", cursor: "pointer", fontSize: "14px", fontFamily: "inherit" }}>
                        ➕ Add Admin
                      </button>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: "14px", fontWeight: "700", color: "#f0ede8", marginBottom: "12px" }}>Current Admins & Staff</div>
                    {users.filter(u => u.role !== "user").map(u => (
                      <div key={u.id} style={{ background: "#1a1a1a", borderRadius: "12px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", border: "1px solid #1e1e1e", marginBottom: "8px" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: "14px", fontWeight: "600", color: "#f0ede8", marginBottom: "4px" }}>{u.name}</div>
                          <div style={{ fontSize: "12px", color: "#666" }}>{u.email}</div>
                        </div>
                        <RoleBadge role={u.role} />
                        {currentRole === "owner" && u.role !== "owner" && (
                          <button
                            onClick={() => {
                              if (!window.confirm(`Revoke admin access for ${u.name}?`)) return
                              setUsers(us => us.map(x => x.id === u.id ? { ...x, role: "user" } : x))
                            }}
                            style={{ background: "#7f1d1d22", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "600", fontFamily: "inherit" }}>
                            Revoke Access
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

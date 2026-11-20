// services/searchIndex.js
//
// Everything search needs at runtime besides the route itself:
//   1. Creates the Atlas Search index "listings_search" automatically (no laptop needed).
//   2. Seeds an editable synonym vocabulary in the "searchsynonyms" collection.
//   3. Keeps Listing.universityKey in sync with each seller's university.
//   4. Records searches (SearchLog) and exposes an owner-only analytics summary,
//      including "searched but nobody sells it" (zero-result queries).
//
// Every step is wrapped so a failure here can NEVER stop the server or break search.
// routes/search.js falls back to MongoDB regex search until the index reports READY.

import express from "express"
import mongoose from "mongoose"
import Listing from "../models/Listing.js"
import User from "../models/User.js"
import { requireAdminAuth, requireOwnerOrSuperAdmin } from "../middleware/adminAuth.js"
import { universityKey } from "../utils/university.js"

export const INDEX_NAME = "listings_search"
export const SYNONYM_MAPPING = "marketplace_synonyms"
// Bump this when SEARCH_INDEX_DEFINITION changes; the index is then updated once on next boot.
// (Atlas rewrites definitions with defaults, so comparing them directly would rebuild every deploy.)
export const INDEX_VERSION = "v1"
const INDEX_VERSION_KEY = "listingsSearchIndexVersion"

// ---------------------------------------------------------------- index definition
export const SEARCH_INDEX_DEFINITION = {
  mappings: {
    dynamic: false,
    fields: {
      title: [
        { type: "string", analyzer: "lucene.english" },
        { type: "autocomplete", analyzer: "lucene.standard", tokenization: "edgeGram", minGrams: 2, maxGrams: 15, foldDiacritics: true },
      ],
      desc: { type: "string", analyzer: "lucene.english" },
      category: { type: "string", analyzer: "lucene.english" },
    },
  },
  synonyms: [{ name: SYNONYM_MAPPING, analyzer: "lucene.english", source: { collection: "searchsynonyms" } }],
}

// ---------------------------------------------------------------- models
const synonymSchema = new mongoose.Schema({
  mappingType: { type: String, enum: ["equivalent", "explicit"], required: true },
  input: { type: [String], default: undefined },   // explicit only: omitted entirely for "equivalent" (Atlas rejects an empty input)
  synonyms: { type: [String], required: true },
}, { collection: "searchsynonyms", versionKey: false })
export const SearchSynonym = mongoose.models.SearchSynonym || mongoose.model("SearchSynonym", synonymSchema)

const metaSchema = new mongoose.Schema({ _id: String, value: String }, { collection: "searchmeta" })
const SearchMeta = mongoose.models.SearchMeta || mongoose.model("SearchMeta", metaSchema)

const logSchema = new mongoose.Schema({
  q: { type: String, index: true },
  total: Number,
  engine: String,
  type: String,
  campus: String,
  ms: Number,
  interpreted: [{ _id: false, kind: String, value: mongoose.Schema.Types.Mixed }],
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 60 }, // auto-delete after 60 days
}, { collection: "searchlogs" })
export const SearchLog = mongoose.models.SearchLog || mongoose.model("SearchLog", logSchema)

// ---------------------------------------------------------------- default vocabulary
// "equivalent": all words mean the same. "explicit": one-way, so searching "laptop" also finds
// MacBooks, but searching "macbook" does not return every laptop. Edit the collection any time;
// Atlas picks up changes automatically.
export const DEFAULT_SYNONYMS = [
  { mappingType: "explicit", input: ["phone"], synonyms: ["phone", "smartphone", "mobile", "cellphone", "handset", "iphone", "android"] },
  { mappingType: "explicit", input: ["laptop"], synonyms: ["laptop", "notebook", "macbook", "chromebook", "thinkpad"] },
  { mappingType: "explicit", input: ["playstation"], synonyms: ["playstation", "ps3", "ps4", "ps5"] },
  { mappingType: "explicit", input: ["tutor"], synonyms: ["tutor", "tutoring", "lesson", "lessons", "teacher"] },
  { mappingType: "equivalent", synonyms: ["fridge", "refrigerator"] },
  { mappingType: "equivalent", synonyms: ["tv", "television"] },
  { mappingType: "equivalent", synonyms: ["sneakers", "sneaker", "trainers"] },
  { mappingType: "equivalent", synonyms: ["bike", "bicycle"] },
  { mappingType: "equivalent", synonyms: ["cooker", "stove"] },
  { mappingType: "equivalent", synonyms: ["earphones", "earbuds", "headphones"] },
  { mappingType: "equivalent", synonyms: ["hostel", "accommodation", "apartment"] },
  { mappingType: "equivalent", synonyms: ["photographer", "photography", "photoshoot"] },
  { mappingType: "equivalent", synonyms: ["hairdresser", "hairstylist", "stylist"] },
  { mappingType: "equivalent", synonyms: ["wig", "wigs", "weave"] },
  { mappingType: "equivalent", synonyms: ["textbook", "textbooks"] },
]

// ---------------------------------------------------------------- setup steps
const log = (...args) => console.log("[search]", ...args)

export async function seedSynonyms() {
  if (await SearchSynonym.estimatedDocumentCount() > 0) return { seeded: 0 }
  await SearchSynonym.insertMany(DEFAULT_SYNONYMS)
  log(`seeded ${DEFAULT_SYNONYMS.length} default synonym groups`)
  return { seeded: DEFAULT_SYNONYMS.length }
}

export async function ensureSearchIndex() {
  let existing
  try { existing = await Listing.listSearchIndexes() }
  catch (err) { log(`Atlas Search unavailable (${err.message}). Using regex fallback search.`); return { ok: false } }
  const found = existing.find(i => i.name === INDEX_NAME)
  const applied = (await SearchMeta.findById(INDEX_VERSION_KEY).lean())?.value
  if (!found) {
    await Listing.createSearchIndex({ name: INDEX_NAME, definition: SEARCH_INDEX_DEFINITION })
    await SearchMeta.updateOne({ _id: INDEX_VERSION_KEY }, { $set: { value: INDEX_VERSION } }, { upsert: true })
    log(`created Atlas Search index "${INDEX_NAME}" (it takes a minute or two to build)`)
    return { ok: true, action: "created" }
  }
  if (applied !== INDEX_VERSION) {
    await Listing.updateSearchIndex(INDEX_NAME, SEARCH_INDEX_DEFINITION)
    await SearchMeta.updateOne({ _id: INDEX_VERSION_KEY }, { $set: { value: INDEX_VERSION } }, { upsert: true })
    log(`updated Atlas Search index "${INDEX_NAME}" to ${INDEX_VERSION}`)
    return { ok: true, action: "updated" }
  }
  return { ok: true, action: "unchanged", status: found.status, queryable: found.queryable }
}

// Makes every listing's universityKey match its seller's current university.
// Idempotent: only touches listings that are out of date, and leaves updatedAt alone.
export async function syncListingUniversityKeys() {
  const users = await User.find({}).select("_id university").lean()
  const byKey = new Map(), without = []
  for (const user of users) {
    const key = universityKey(user.university)
    if (!key) { without.push(user._id); continue }
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(user._id)
  }
  let changed = 0
  const apply = async (ids, key) => {
    for (let i = 0; i < ids.length; i += 1000) {
      const result = await Listing.updateMany({ seller: { $in: ids.slice(i, i + 1000) }, universityKey: { $ne: key } }, { $set: { universityKey: key } }, { timestamps: false })
      changed += result.modifiedCount || 0
    }
  }
  for (const [key, ids] of byKey) await apply(ids, key)
  await apply(without, "")
  if (changed) log(`synced universityKey on ${changed} listing(s)`)
  return { changed }
}

async function runSetup() {
  for (const [name, step] of [["synonyms", seedSynonyms], ["index", ensureSearchIndex], ["campus keys", syncListingUniversityKeys]]) {
    try { await step() } catch (err) { console.error(`[search] setup step "${name}" failed:`, err.message) }
  }
}

// ---------------------------------------------------------------- analytics
export function logSearch(event) {
  if (mongoose.connection.readyState !== 1) return
  SearchLog.create({
    q: String(event.q || "").slice(0, 100),
    total: Number(event.total) || 0,
    engine: String(event.engine || "").slice(0, 20),
    type: String(event.type || "").slice(0, 20),
    campus: String(event.campus || "").slice(0, 60),
    ms: Number(event.ms) || 0,
    interpreted: Array.isArray(event.interpreted) ? event.interpreted.slice(0, 6) : [],
  }).catch(() => {})
}

export const analyticsRouter = express.Router()
// Owner / super-admin only.
analyticsRouter.get("/summary", requireAdminAuth, requireOwnerOrSuperAdmin, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, Math.floor(Number(req.query.days)) || 30))
    const since = new Date(Date.now() - days * 86400000)
    const [result] = await SearchLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $facet: {
        totals: [{ $group: { _id: null, searches: { $sum: 1 }, zero: { $sum: { $cond: [{ $eq: ["$total", 0] }, 1, 0] } }, avgMs: { $avg: "$ms" } } }],
        top: [{ $group: { _id: "$q", count: { $sum: 1 }, avgResults: { $avg: "$total" }, lastSeen: { $max: "$createdAt" } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 25 }],
        // Demand with no supply: recruit sellers who can list these.
        unmet: [{ $match: { total: 0 } }, { $group: { _id: "$q", count: { $sum: 1 }, lastSeen: { $max: "$createdAt" } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 50 }],
        engines: [{ $group: { _id: "$engine", count: { $sum: 1 } } }],
      } },
    ])
    const totals = result?.totals?.[0] || { searches: 0, zero: 0, avgMs: 0 }
    res.json({
      days,
      searches: totals.searches,
      zeroResultRate: totals.searches ? Number((totals.zero / totals.searches).toFixed(3)) : 0,
      avgMs: Math.round(totals.avgMs || 0),
      topQueries: (result?.top || []).map(x => ({ q: x._id, count: x.count, avgResults: Math.round(x.avgResults || 0), lastSeen: x.lastSeen })),
      unmetDemand: (result?.unmet || []).map(x => ({ q: x._id, count: x.count, lastSeen: x.lastSeen })),
      engines: Object.fromEntries((result?.engines || []).map(x => [x._id || "unknown", x.count])),
    })
  } catch (err) {
    console.error("Search analytics failed:", err)
    res.status(500).json({ message: "Analytics unavailable" })
  }
})

// ---------------------------------------------------------------- startup hook
// Call once after MongoDB connects. Never throws, never blocks startup.
export function initSearch(app) {
  app.set("searchLogger", logSearch)
  setTimeout(runSetup, 5000).unref?.()
  setInterval(() => { syncListingUniversityKeys().catch(err => console.error("[search] campus key sync failed:", err.message)) }, 6 * 60 * 60 * 1000).unref?.()
}

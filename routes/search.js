// routes/search.js
//
// Marketplace search. Three engines, tried in order, so search never goes down:
//   1. "atlas"    MongoDB Atlas Search (Lucene): typo tolerance, prefix matching,
//                 synonyms, field boosts. Used only when the index is READY.
//   2. "fallback" Regex/synonym matching in MongoDB (the original behaviour).
//   3. "fuzzy"    In-memory Levenshtein over recent listings (last resort).
//
// Atlas index required (created by services/searchIndex.js, file 4). Name: listings_search
//   title    -> string + autocomplete (edgeGram)
//   desc     -> string
//   category -> string
//   synonyms -> mapping "marketplace_synonyms" from collection "searchsynonyms"
// Until that index exists, this file behaves like engine 2, so it is safe to
// deploy BEFORE the index is created.
//
// Hard constraints (status, type, category, price, campus, rental availability)
// are applied with plain $match stages, never inside $search. That keeps results
// correct even if the Atlas index mapping is ever wrong or still building.

import express from 'express'
import mongoose from 'mongoose'
import Listing from '../models/Listing.js'
import User from '../models/User.js'
import RentalReservation from '../models/RentalReservation.js'
import RentalItemLock from '../models/RentalItemLock.js'
import { universityKey } from '../utils/university.js'

const router = express.Router()

// ---------------------------------------------------------------- constants
const INDEX_NAME = 'listings_search'
const SYNONYM_MAPPING = 'marketplace_synonyms'
const MAX_CANDIDATES = 1000
const ATLAS_TIMEOUT_MS = 4000
const types = new Set(['product', 'rent', 'service'])
const SORTS = new Set(['relevant', 'newest', 'price_asc', 'price_desc', 'rating'])
const CACHE_TTL_MS = 20 * 1000
const CACHE_MAX = 300

// Acronyms that are safe to detect inside a free-text query. Ambiguous ones are
// deliberately excluded ("mug", "pug", "central", "stu", "atu"...): a search for
// "mug" must find mugs, not silently switch to a campus.
const QUERY_CAMPUS_SAFE = new Set([
  'ucc', 'ug', 'knust', 'uew', 'uds', 'umat', 'uhas', 'upsa', 'gimpa', 'ashesi',
  'uenr', 'cktutas', 'aamusted', 'gctu', 'vvu', 'uesd', 'umac',
])

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'for', 'in', 'on', 'at', 'of', 'to', 'and', 'with', 'any', 'some',
  'sale', 'selling', 'sell', 'buy', 'buying', 'need', 'want', 'wanted', 'looking', 'please', 'me',
])

// ---------------------------------------------------------------- small helpers
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bounded = (value, max = 100) => String(value ?? '').trim().slice(0, max)
const numberParam = (value, fallback) => value === undefined || value === '' ? fallback : Number(value)
const normalize = value => bounded(value).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim()
const tokenize = value => normalize(value).split(/\s+/).filter(Boolean)

// Conservative synonym groups used by the regex/fuzzy engines. The Atlas engine
// uses the editable "searchsynonyms" collection instead.
const synonymGroups = [
  ['phone', 'smartphone', 'mobile', 'handset'],
  ['laptop', 'notebook', 'computer'],
  ['sneakers', 'trainers', 'shoes'],
  ['hostel', 'accommodation', 'room'],
  ['tutor', 'tutoring', 'lessons'],
  ['photographer', 'photography', 'photoshoot'],
  ['bike', 'bicycle'],
  ['fridge', 'refrigerator'],
  ['charger', 'charging'],
  ['textbook', 'books'],
]
const expandTerm = term => synonymGroups.find(group => group.includes(term)) || [term]

const levenshtein = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 3
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]
}

const fuzzyScore = (query, item) => {
  const title = normalize(item.title), category = normalize(item.category), desc = normalize(item.desc)
  const titleWords = tokenize(title), allWords = [...new Set([...titleWords, ...tokenize(category), ...tokenize(desc).slice(0, 50)])]
  const terms = tokenize(query).slice(0, 8)
  if (!terms.length) return 0
  let score = title === query ? 150 : title.startsWith(query) ? 90 : 0
  for (const term of terms) {
    const alternatives = expandTerm(term)
    const exactTitle = titleWords.some(w => alternatives.includes(w))
    const prefixTitle = titleWords.some(w => alternatives.some(t => w.startsWith(t)))
    const exactOther = allWords.some(w => alternatives.includes(w))
    const nearTitle = term.length >= 4 && titleWords.some(w => Math.abs(w.length - term.length) <= 2 && levenshtein(term, w) <= (term.length >= 7 ? 2 : 1))
    const nearOther = term.length >= 4 && allWords.some(w => Math.abs(w.length - term.length) <= 1 && levenshtein(term, w) <= 1)
    if (!exactTitle && !prefixTitle && !exactOther && !nearTitle && !nearOther) return 0
    score += exactTitle ? 35 : prefixTitle ? 24 : exactOther ? 15 : nearTitle ? 10 : 4
  }
  return score + Math.min(10, Math.max(0, Number(item.rating) || 0) * 2)
}

// ---------------------------------------------------------------- tiny TTL cache
const cache = new Map()
const cacheGet = key => {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null }
  return hit.value
}
const cacheSet = (key, value) => {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), value })
}

// ---------------------------------------------------------------- query understanding
const CUR = '(?:ghs|gh₵|gh¢|ghc|₵|¢|cedis?|cedi)?'
const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)(k\\b)?'
const toAmount = (digits, k) => {
  const n = parseFloat(String(digits).replace(/,/g, ''))
  return Number.isFinite(n) ? n * (k ? 1000 : 1) : NaN
}
const looksLikeYear = (amount, hadCurrency) => !hadCurrency && Number.isInteger(amount) && amount >= 1990 && amount <= 2035

// Pulls price / type / campus intent out of free text so "laptop under 2000 ucc"
// becomes keywords ["laptop"] + max price 2000 + campus ucc. Pure and exported for tests.
export function parseIntent(raw, { interpret = true } = {}) {
  let text = bounded(raw).toLowerCase()
  const out = { keywords: [], type: null, minPrice: null, maxPrice: null, campusKey: null, interpreted: [] }
  if (interpret) {
    const take = (regex, handler) => {
      const m = regex.exec(text)
      if (!m) return false
      if (handler(m) === false) return false
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ')
      return true
    }
    const setMax = n => { if (Number.isFinite(n) && n >= 0 && out.maxPrice === null) out.maxPrice = n }
    const setMin = n => { if (Number.isFinite(n) && n >= 0 && out.minPrice === null) out.minPrice = n }
    // ranges: "between 100 and 300", "from 100 to 300"
    take(new RegExp(`\\b(?:between|from)\\s*${CUR}\\s*${NUM}\\s*(?:and|to|-)\\s*${CUR}\\s*${NUM}`), m => {
      const a = toAmount(m[1], m[2]), b = toAmount(m[3], m[4])
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      setMin(Math.min(a, b)); setMax(Math.max(a, b))
    })
    // currency-marked range: "ghs 100-300", "100-300 cedis"
    take(new RegExp(`(?:ghs|gh₵|gh¢|ghc|₵)\\s*${NUM}\\s*(?:-|to)\\s*${CUR}\\s*${NUM}`), m => {
      const a = toAmount(m[1], m[2]), b = toAmount(m[3], m[4])
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      setMin(Math.min(a, b)); setMax(Math.max(a, b))
    })
    take(new RegExp(`${NUM}\\s*(?:-|to)\\s*${NUM}\\s*(?:ghs|cedis?|cedi)\\b`), m => {
      const a = toAmount(m[1], m[2]), b = toAmount(m[3], m[4])
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      setMin(Math.min(a, b)); setMax(Math.max(a, b))
    })
    // upper bound: "under 500", "below ghs 500", "max 2k", "<= 300"
    take(new RegExp(`(?:\\b(?:under|below|less than|cheaper than|not more than|max(?:imum)?|up ?to|within|budget(?: of)?)|<=?|≤)\\s*${CUR}\\s*${NUM}`), m => {
      const n = toAmount(m[1], m[2]); if (!Number.isFinite(n)) return false
      setMax(n)
    })
    // lower bound: "over 200", "at least 100", ">= 50". Bare years are ignored ("from 2020").
    take(new RegExp(`(?:\\b(?:over|above|more than|min(?:imum)?|at least)|>=?|≥)\\s*(${CUR})\\s*${NUM}`), m => {
      const n = toAmount(m[2], m[3]); if (!Number.isFinite(n) || looksLikeYear(n, !!m[1])) return false
      setMin(n)
    })
    // bare currency amount = a budget: "ghs 500", "500 cedis"
    take(new RegExp(`(?:ghs|gh₵|gh¢|ghc|₵)\\s*${NUM}`), m => { const n = toAmount(m[1], m[2]); if (!Number.isFinite(n)) return false; setMax(n) })
    take(new RegExp(`${NUM}\\s*(?:ghs|cedis?|cedi)\\b`), m => { const n = toAmount(m[1], m[2]); if (!Number.isFinite(n)) return false; setMax(n) })
    // type intent
    if (/\b(?:for rent|to rent|for hire|rentals?|renting|hire|rent)\b/.test(text)) {
      out.type = 'rent'
      text = text.replace(/\b(?:for rent|to rent|for hire|rentals?|renting|hire|rent)\b/g, ' ')
    } else if (/\bfor sale\b/.test(text)) {
      out.type = 'product'
      text = text.replace(/\bfor sale\b/g, ' ')
    }
  }
  let words = normalize(text).split(/\s+/).filter(Boolean)
  if (interpret) {
    const found = detectCampus(words)
    if (found) { out.campusKey = found.key; words = [...words.slice(0, found.start), ...words.slice(found.start + found.size)] }
    words = words.filter(w => !STOP_WORDS.has(w))
  }
  out.keywords = words.filter(w => w.length >= 2 || /^\d$/.test(w)).slice(0, 8)
  if (out.type) out.interpreted.push({ kind: 'type', value: out.type })
  if (out.minPrice !== null) out.interpreted.push({ kind: 'minPrice', value: out.minPrice })
  if (out.maxPrice !== null) out.interpreted.push({ kind: 'maxPrice', value: out.maxPrice })
  if (out.campusKey) out.interpreted.push({ kind: 'campus', value: out.campusKey })
  return out
}

// Finds a campus mention. Multi-word windows must be minimal (dropping an edge
// word must change the match) so "knust laptop charger" only consumes "knust".
function detectCampus(words) {
  for (let size = Math.min(8, words.length); size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const win = words.slice(i, i + size)
      const key = universityKey(win.join(' '))
      if (!QUERY_CAMPUS_SAFE.has(key)) continue
      if (size > 1) {
        const withoutFirst = universityKey(win.slice(1).join(' '))
        const withoutLast = universityKey(win.slice(0, -1).join(' '))
        if (withoutFirst === key || withoutLast === key) continue
      }
      return { key, start: i, size }
    }
  }
  return null
}

// ---------------------------------------------------------------- rental availability (unchanged behaviour)
const parseRentalDates = query => {
  const start = bounded(query.startDate, 10), end = bounded(query.endDate, 10)
  if (!start && !end) return null
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('Invalid rental dates')
  const from = new Date(`${start}T00:00:00.000Z`), to = new Date(`${end}T00:00:00.000Z`)
  const days = Math.round((to - from) / 86400000)
  if (!Number.isFinite(days) || from.toISOString().slice(0, 10) !== start || to.toISOString().slice(0, 10) !== end || days < 1 || days > 90 || from < new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')) throw new Error('Invalid rental dates')
  return { days, start, end }
}
const unavailableRentalIds = async () => {
  // Conservative: never advertise a currently reserved or locked item as available.
  // The rental ledger has no future calendar intervals, so this does NOT promise
  // future-date booking; final checkout must re-check atomically.
  const [locks, reservations] = await Promise.all([
    RentalItemLock.distinct('listing'),
    RentalReservation.distinct('listing', { $or: [{ state: { $in: ['paid', 'activated', 'reconciliation_required'] } }, { state: { $in: ['reserved', 'payment_pending'] }, expiresAt: { $gt: new Date() } }] }),
  ])
  return [...new Set([...locks, ...reservations].map(String))].filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(id))
}

// ---------------------------------------------------------------- campus -> seller ids
// Works before listings are back-filled with universityKey, and stays correct if a
// seller changes university (refreshed every 5 minutes).
let campusCache = { at: 0, map: new Map(), loading: null }
const getCampusSellerIds = async key => {
  if (!key) return []
  try {
    if (Date.now() - campusCache.at > 5 * 60 * 1000) {
      if (!campusCache.loading) {
        campusCache.loading = User.find({ university: { $exists: true, $ne: '' } }).select('_id university').lean().then(users => {
          const map = new Map()
          for (const u of users) {
            const k = universityKey(u.university)
            if (!k) continue
            if (!map.has(k)) map.set(k, [])
            map.get(k).push(u._id)
          }
          campusCache = { at: Date.now(), map, loading: null }
        }).catch(err => { campusCache.loading = null; campusCache.at = Date.now() - 4 * 60 * 1000; throw err })
      }
      await campusCache.loading
    }
    return campusCache.map.get(key) || []
  } catch (err) { console.error('Campus seller lookup failed:', err.message); return [] }
}

// ---------------------------------------------------------------- filters
const campusMatch = (key, ids) => ({ $or: [{ universityKey: key }, { seller: { $in: ids } }] })

// Hard constraints. type and category are returned separately because the facet
// counts must ignore their own filter (so a user can switch category/type).
export function buildFilters({ type, category, minPrice, maxPrice, rentalDays, campusKey, campusIds, excludeIds }) {
  const base = { status: 'Active' }
  const and = []
  if (excludeIds?.length) base._id = { $nin: excludeIds }
  if (rentalDays) and.push({ $or: [{ maxDays: { $gte: rentalDays } }, { maxDays: { $exists: false } }] })
  if (campusKey) and.push(campusMatch(campusKey, campusIds || []))
  if (minPrice > 0 || maxPrice !== Number.MAX_SAFE_INTEGER) {
    const range = { $gte: minPrice, $lte: maxPrice }
    and.push({ $or: [{ type: 'rent', dailyRate: range }, { type: { $in: ['product', 'service'] }, price: range }] })
  }
  if (and.length) base.$and = and
  return { base, typeOnly: type ? { type } : {}, categoryOnly: category ? { category } : {}, typeAndCategory: { ...(type ? { type } : {}), ...(category ? { category } : {}) } }
}

// ---------------------------------------------------------------- ranking + paging (shared by both MongoDB engines)
const ITEM_PROJECTION = {
  title: 1, desc: 1, category: 1, type: 1, price: 1, dailyRate: 1, maxDays: 1, condition: 1, delivery: 1,
  image: 1, rating: 1, reviews: 1, seller: 1, createdAt: 1, accountability: 1, accountabilityPct: 1,
  serviceDelivery: 1, liveSession: 1, universityKey: 1,
}
const SORT_STAGES = {
  relevant: { relevance: -1, createdAt: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  price_asc: { _pAsc: 1, _id: 1 },
  price_desc: { _pDesc: -1, _id: 1 },
  rating: { rating: -1, reviews: -1, createdAt: -1, _id: 1 },
}

// Input docs carry a numeric "_text" (Lucene score or regex score). Final relevance =
// text score x quality x freshness x campus. Multipliers keep text relevance dominant:
// rating (Bayesian, so unrated listings are neutral) 0.8-1.2, freshness up to +15%,
// campus +25% (user's own campus) or +60% (campus named in the query).
export function rankStages({ boost, sort, page, limit, filters }) {
  const campusExpr = boost?.key
    ? { $cond: [{ $or: [{ $eq: ['$universityKey', boost.key] }, { $in: ['$seller', boost.ids || []] }] }, boost.factor, 1] }
    : 1
  return [
    { $addFields: {
      _eff: { $cond: [{ $eq: ['$type', 'rent'] }, '$dailyRate', '$price'] },
      _bayes: { $divide: [
        { $add: [{ $multiply: [{ $ifNull: ['$rating', 0] }, { $ifNull: ['$reviews', 0] }] }, 3 * 3.5] },
        { $add: [{ $ifNull: ['$reviews', 0] }, 3] },
      ] },
      _age: { $max: [0, { $dateDiff: { startDate: { $ifNull: ['$createdAt', '$$NOW'] }, endDate: '$$NOW', unit: 'day' } }] },
    } },
    { $addFields: {
      _pAsc: { $ifNull: ['$_eff', 1e15] },
      _pDesc: { $ifNull: ['$_eff', -1] },
      relevance: { $multiply: [
        { $max: [0.0001, { $ifNull: ['$_text', 1] }] },
        { $min: [1.2, { $max: [0.8, { $add: [1, { $multiply: [0.1, { $subtract: ['$_bayes', 3.5] }] }] }] }] },
        { $add: [1, { $multiply: [0.15, { $exp: { $multiply: [-1 / 21, '$_age'] } }] }] },
        campusExpr,
      ] },
    } },
    { $facet: {
      items: [
        { $match: filters.typeAndCategory },
        { $sort: SORT_STAGES[sort] || SORT_STAGES.relevant },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: ITEM_PROJECTION },
      ],
      total: [{ $match: filters.typeAndCategory }, { $count: 'n' }],
      categories: [{ $match: filters.typeOnly }, { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 30 }],
      types: [{ $match: filters.categoryOnly }, { $group: { _id: '$type', count: { $sum: 1 } } }],
    } },
  ]
}

const shapeFacetResult = result => ({
  items: result?.items || [],
  total: result?.total?.[0]?.n || 0,
  facets: {
    categories: (result?.categories || []).map(x => ({ name: x._id, count: x.count })),
    types: (result?.types || []).map(x => ({ name: x._id, count: x.count })),
  },
})

// ---------------------------------------------------------------- engine 1: Atlas Search
const fuzzyEditsFor = term => term.length >= 6 ? 2 : term.length >= 4 ? 1 : 0

export function buildAtlasSearchStage(keywords) {
  const must = keywords.map(term => {
    const edits = fuzzyEditsFor(term)
    const should = [
      { text: { query: term, path: 'title', score: { boost: { value: 6 } } } },
      { text: { query: term, path: 'category', score: { boost: { value: 3 } } } },
      { text: { query: term, path: 'desc', score: { boost: { value: 1 } } } },
      // Synonyms cannot be combined with fuzzy in one operator, so they are separate clauses.
      { text: { query: term, path: ['title', 'category', 'desc'], synonyms: SYNONYM_MAPPING, score: { boost: { value: 2 } } } },
    ]
    if (edits > 0) should.push({ text: { query: term, path: 'title', fuzzy: { maxEdits: edits, prefixLength: 1, maxExpansions: 50 }, score: { boost: { value: 3 } } } })
    if (term.length >= 2) should.push({ autocomplete: { query: term, path: 'title', score: { boost: { value: 2 } } } })
    return { compound: { should, minimumShouldMatch: 1 } }
  })
  const should = []
  if (keywords.length > 1) should.push({ phrase: { query: keywords.join(' '), path: 'title', slop: 3, score: { boost: { value: 10 } } } })
  return { $search: { index: INDEX_NAME, compound: { must, ...(should.length ? { should } : {}) } } }
}

export function buildAtlasPipeline({ keywords, filters, boost, sort, page, limit }) {
  return [
    buildAtlasSearchStage(keywords),
    { $addFields: { _text: { $meta: 'searchScore' } } }, // materialise before any other stage
    { $match: filters.base },
    { $limit: MAX_CANDIDATES },
    ...rankStages({ boost, sort, page, limit, filters }),
  ]
}

const engineState = { ready: false, checkedAt: 0, checking: null }
async function atlasReady(force = false) {
  const ttl = engineState.ready ? 10 * 60 * 1000 : 60 * 1000
  if (!force && Date.now() - engineState.checkedAt < ttl) return engineState.ready
  if (engineState.checking) return engineState.checking
  engineState.checking = (async () => {
    try {
      const indexes = await Listing.listSearchIndexes()
      const found = Array.isArray(indexes) ? indexes.find(i => i.name === INDEX_NAME) : null
      engineState.ready = !!(found && (found.queryable === true || found.status === 'READY'))
    } catch { engineState.ready = false }
    engineState.checkedAt = Date.now()
    engineState.checking = null
    return engineState.ready
  })()
  return engineState.checking
}
const markAtlasFailed = err => {
  engineState.ready = false
  engineState.checkedAt = Date.now()
  console.error('Atlas Search failed, using fallback engine:', err?.message || err)
}

// ---------------------------------------------------------------- engine 2: regex/synonym match in MongoDB
export function buildRegexPipeline({ keywords, query, filters, boost, sort, page, limit }) {
  const textMatch = keywords.map(word => ({
    $or: expandTerm(word).flatMap(term => ['title', 'category', 'desc'].map(field => ({ [field]: { $regex: escapeRegex(term), $options: 'i' } }))),
  }))
  const termScores = keywords.flatMap(word => {
    const re = escapeRegex(word)
    return [
      { $cond: [{ $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: re, options: 'i' } }, 12, 0] },
      { $cond: [{ $regexMatch: { input: { $ifNull: ['$category', ''] }, regex: re, options: 'i' } }, 6, 0] },
      { $cond: [{ $regexMatch: { input: { $ifNull: ['$desc', ''] }, regex: re, options: 'i' } }, 2, 0] },
    ]
  })
  const q = escapeRegex(query)
  const match = { ...filters.base, $and: [...(filters.base.$and || []), ...textMatch] }
  return [
    { $match: match },
    { $limit: MAX_CANDIDATES },
    { $addFields: { _text: { $add: [
      { $cond: [{ $eq: [{ $toLower: { $ifNull: ['$title', ''] } }, query] }, 100, 0] },
      { $cond: [{ $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: `^${q}`, options: 'i' } }, 50, 0] },
      ...termScores,
    ] } } },
    ...rankStages({ boost, sort, page, limit, filters }),
  ]
}

// Plain browse (no keywords).
export function buildBrowsePipeline({ filters, boost, sort, page, limit }) {
  return [
    { $match: filters.base },
    { $limit: MAX_CANDIDATES },
    { $addFields: { _text: 1 } },
    ...rankStages({ boost, sort, page, limit, filters }),
  ]
}

// ---------------------------------------------------------------- engine 3: in-memory fuzzy (last resort)
const memorySorters = {
  relevant: (a, b) => b.relevance - a.relevance || new Date(b.createdAt) - new Date(a.createdAt),
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  price_asc: (a, b) => (a.type === 'rent' ? a.dailyRate : a.price) - (b.type === 'rent' ? b.dailyRate : b.price),
  price_desc: (a, b) => (b.type === 'rent' ? b.dailyRate : b.price) - (a.type === 'rent' ? a.dailyRate : a.price),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0),
}
async function runFuzzyMemory({ query, type, category, filters, sort, page, limit }) {
  const candidates = await Listing.find(filters.base)
    .select(Object.keys(ITEM_PROJECTION).join(' '))
    .sort({ createdAt: -1, _id: 1 }).limit(600).lean()
  const ranked = candidates.map(item => ({ ...item, relevance: fuzzyScore(query, item) })).filter(item => item.relevance > 0)
  const countBy = (rows, key) => [...rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map())].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const eligible = ranked.filter(r => (!type || r.type === type) && (!category || r.category === category))
  eligible.sort(memorySorters[sort] || memorySorters.relevant)
  return {
    items: eligible.slice((page - 1) * limit, page * limit),
    total: eligible.length,
    facets: { categories: countBy(ranked.filter(r => !type || r.type === type), 'category').slice(0, 30), types: countBy(ranked.filter(r => !category || r.category === category), 'type') },
  }
}

// ---------------------------------------------------------------- "did you mean"
let vocabulary = { at: 0, words: new Map() }
async function getVocabulary() {
  if (Date.now() - vocabulary.at < 5 * 60 * 1000 && vocabulary.words.size) return vocabulary.words
  try {
    const rows = await Listing.find({ status: 'Active' }).select('title category').sort({ createdAt: -1 }).limit(5000).lean()
    const words = new Map()
    for (const row of rows) for (const w of [...tokenize(row.title), ...tokenize(row.category)]) if (w.length >= 3) words.set(w, (words.get(w) || 0) + 1)
    vocabulary = { at: Date.now(), words }
  } catch { vocabulary.at = Date.now() }
  return vocabulary.words
}
export async function didYouMean(keywords, words) {
  if (!keywords.length || !words?.size) return null
  let changed = false
  const out = keywords.map(term => {
    if (term.length < 4 || words.has(term) || expandTerm(term).length > 1) return term
    let best = null, bestDistance = 3
    for (const [word, count] of words) {
      if (Math.abs(word.length - term.length) > 2) continue
      const d = levenshtein(term, word)
      if (d <= (term.length >= 7 ? 2 : 1) && (d < bestDistance || (d === bestDistance && count > (words.get(best) || 0)))) { best = word; bestDistance = d }
    }
    if (best && best !== term) { changed = true; return best }
    return term
  })
  return changed ? out.join(' ') : null
}

// ---------------------------------------------------------------- GET /api/search
router.get('/', async (req, res) => {
  const startedAt = Date.now()
  try {
    // ---- validate (same rules and messages as before)
    const rentalDates = parseRentalDates(req.query)
    const interpret = bounded(req.query.interpret, 2) !== '0'
    const intent = parseIntent(req.query.q || req.query.search, { interpret })
    const explicitType = bounded(req.query.type, 20)
    if (explicitType && !types.has(explicitType)) throw new Error('Invalid listing type')
    const type = explicitType || intent.type || ''
    if (rentalDates && type !== 'rent') throw new Error('Invalid rental dates: select Rentals')
    const category = bounded(req.query.category, 80)
    const explicitMin = numberParam(req.query.minPrice, null), explicitMax = numberParam(req.query.maxPrice, null)
    const minPrice = explicitMin !== null ? explicitMin : (intent.minPrice ?? 0)
    const maxPrice = explicitMax !== null ? explicitMax : (intent.maxPrice ?? Number.MAX_SAFE_INTEGER)
    if (![minPrice, maxPrice].every(Number.isFinite) || minPrice < 0 || maxPrice < minPrice) throw new Error('Invalid price range')
    const pageRaw = numberParam(req.query.page, 1)
    if (!Number.isFinite(pageRaw) || pageRaw < 1) return res.status(400).json({ message: 'Invalid page' })
    const page = Math.max(1, Math.min(100, Math.floor(pageRaw)))
    const limitRaw = numberParam(req.query.limit, 16)
    if (!Number.isFinite(limitRaw) || limitRaw < 1) return res.status(400).json({ message: 'Invalid limit' })
    const limit = Math.max(1, Math.min(40, Math.floor(limitRaw)))
    const sort = bounded(req.query.sort, 20) || 'relevant'
    if (!SORTS.has(sort)) return res.status(400).json({ message: 'Invalid sort' })

    // ---- campus: explicit filter, query-named campus, and the searcher's own campus
    const filterCampus = bounded(req.query.university, 100) ? universityKey(req.query.university) : ''
    const userCampus = bounded(req.query.campus, 100) ? universityKey(req.query.campus) : ''
    const keywords = intent.keywords
    // A campus named in the query filters when it is the only thing searched; otherwise it boosts.
    const campusFilterKey = filterCampus || (intent.campusKey && !keywords.length ? intent.campusKey : '')
    const boostKey = intent.campusKey && keywords.length ? intent.campusKey : userCampus
    const boostFactor = intent.campusKey && keywords.length ? 1.6 : 1.25
    const wantedKeys = [...new Set([campusFilterKey, boostKey].filter(Boolean))]
    const idsByKey = {}
    for (const key of wantedKeys) idsByKey[key] = await getCampusSellerIds(key)

    // ---- cache (skipped for rental-date searches, where availability changes quickly)
    const cacheKey = rentalDates ? null : JSON.stringify([keywords, type, category, minPrice, maxPrice, sort, page, limit, campusFilterKey, boostKey, boostFactor])
    if (cacheKey) { const hit = cacheGet(cacheKey); if (hit) return res.json(hit) }

    const filters = buildFilters({
      type, category, minPrice, maxPrice,
      rentalDays: rentalDates?.days,
      campusKey: campusFilterKey, campusIds: idsByKey[campusFilterKey],
      excludeIds: rentalDates ? await unavailableRentalIds() : null,
    })
    const boost = boostKey ? { key: boostKey, ids: idsByKey[boostKey], factor: boostFactor } : null
    const ctx = { keywords, query: keywords.join(' '), type, category, filters, boost, sort, page, limit }

    // ---- run engines in order
    let engine = 'browse', result
    const aggregate = async pipeline => shapeFacetResult((await Listing.aggregate(pipeline).option({ maxTimeMS: ATLAS_TIMEOUT_MS }))[0])
    if (!keywords.length) {
      result = await aggregate(buildBrowsePipeline(ctx))
    } else {
      if (await atlasReady()) {
        try { result = await aggregate(buildAtlasPipeline(ctx)); engine = 'atlas' } catch (err) { markAtlasFailed(err) }
      }
      if (!result || (engine === 'atlas' && result.total === 0)) {
        // Zero Atlas hits are double-checked, so a wrong or stale index can never hide listings.
        const regexResult = await aggregate(buildRegexPipeline(ctx))
        if (engine === 'atlas' && regexResult.total > 0) console.warn(`Atlas returned 0 for "${ctx.query}" but fallback found ${regexResult.total}; check the ${INDEX_NAME} index.`)
        if (!result || regexResult.total > 0) { result = regexResult; engine = 'fallback' }
      }
      if (result.total === 0) { result = await runFuzzyMemory(ctx); engine = 'fuzzy' }
    }

    await Listing.populate(result.items, { path: 'seller', select: 'name university' })
    const suggestion = keywords.length && result.total < 3 ? await didYouMean(keywords, await getVocabulary()) : null
    const body = {
      items: result.items, total: result.total, page, limit, pages: Math.ceil(result.total / limit),
      facets: result.facets, engine,
      ...(engine === 'fuzzy' ? { approximate: true } : {}),
      interpreted: intent.interpreted, ...(suggestion ? { didYouMean: suggestion } : {}),
    }
    if (cacheKey) cacheSet(cacheKey, body)
    try {
      // Optional analytics hook (attached in server.js): never allowed to affect the response.
      const logger = req.app.get('searchLogger')
      if (typeof logger === 'function' && keywords.length && page === 1) {
        logger({ q: keywords.join(' '), keywords, interpreted: intent.interpreted, total: result.total, engine, type, campus: boostKey || campusFilterKey || '', ms: Date.now() - startedAt })
      }
    } catch { /* analytics must never break search */ }
    res.json(body)
  } catch (err) {
    const message = String(err?.message || '')
    if (message.startsWith('Invalid')) return res.status(400).json({ message })
    console.error('Search failed:', err)
    res.status(500).json({ message: 'Search temporarily unavailable' })
  }
})

// ---------------------------------------------------------------- GET /api/search/suggest
const SUGGEST_FIELDS = 'title type category image price dailyRate rating createdAt'
router.get('/suggest', async (req, res) => {
  try {
    const q = normalize(req.query.q)
    if (q.length < 2) return res.json({ suggestions: [] })
    const type = bounded(req.query.type, 20)
    if (type && !types.has(type)) return res.status(400).json({ message: 'Invalid listing type' })
    const key = `s:${q}:${type}`
    const hit = cacheGet(key)
    if (hit) return res.json(hit)
    let listings = null
    if (await atlasReady()) {
      try {
        listings = await Listing.aggregate([
          { $search: { index: INDEX_NAME, compound: {
            should: [
              { autocomplete: { query: q, path: 'title', fuzzy: { maxEdits: 1, prefixLength: 1 }, score: { boost: { value: 3 } } } },
              { text: { query: q, path: ['title', 'category'], fuzzy: { maxEdits: 1, prefixLength: 1 } } },
            ],
            minimumShouldMatch: 1,
          } } },
          { $limit: 60 },
          { $match: { status: 'Active', ...(type ? { type } : {}) } },
          { $limit: 8 },
          { $project: Object.fromEntries(SUGGEST_FIELDS.split(' ').map(f => [f, 1])) },
        ]).option({ maxTimeMS: ATLAS_TIMEOUT_MS })
      } catch (err) { markAtlasFailed(err); listings = null }
    }
    if (!listings || !listings.length) {
      const terms = tokenize(q).slice(0, 6)
      const filter = { status: 'Active', $and: terms.map(term => ({ $or: expandTerm(term).map(word => ({ title: { $regex: escapeRegex(word), $options: 'i' } })) })) }
      if (type) filter.type = type
      listings = await Listing.find(filter).select(SUGGEST_FIELDS).limit(60).lean()
      if (!listings.length) {
        const fallback = { status: 'Active' }
        if (type) fallback.type = type
        listings = (await Listing.find(fallback).select(SUGGEST_FIELDS).sort({ createdAt: -1 }).limit(400).lean()).filter(item => fuzzyScore(q, item) > 0)
      }
      listings.sort((a, b) => fuzzyScore(q, b) - fuzzyScore(q, a))
      listings = listings.slice(0, 8)
    }
    const body = { suggestions: listings }
    cacheSet(key, body)
    res.json(body)
  } catch { res.status(500).json({ message: 'Suggestions unavailable' }) }
})

// ---------------------------------------------------------------- GET /api/search/status
// Open this URL in any browser to see which engine is live: { engine: "atlas" | "fallback" }.
let lastStatusRefresh = 0
router.get('/status', async (req, res) => {
  const force = req.query.refresh === '1' && Date.now() - lastStatusRefresh > 10 * 1000
  if (force) lastStatusRefresh = Date.now()
  const ready = await atlasReady(force)
  res.json({ engine: ready ? 'atlas' : 'fallback', index: INDEX_NAME, checkedAt: new Date(engineState.checkedAt).toISOString() })
})

export default router

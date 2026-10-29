import express from 'express'
import mongoose from 'mongoose'
import Listing from '../models/Listing.js'
import RentalReservation from '../models/RentalReservation.js'
import RentalItemLock from '../models/RentalItemLock.js'

const router = express.Router()
const types = new Set(['product', 'rent', 'service'])
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bounded = (value, max = 100) => String(value ?? '').trim().slice(0, max)
const numberParam = (value, fallback) => value === undefined || value === '' ? fallback : Number(value)
const normalize = value => bounded(value).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim()
// Conservative synonym groups; expanding only known marketplace vocabulary.
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
  ['textbook', 'books']
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
const tokenize = value => normalize(value).split(/\s+/).filter(Boolean)
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
const parseRentalDates = query => {
  const start = bounded(query.startDate, 10), end = bounded(query.endDate, 10)
  if (!start && !end) return null
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('Invalid rental dates')
  const from = new Date(`${start}T00:00:00.000Z`), to = new Date(`${end}T00:00:00.000Z`)
  const days = Math.round((to - from) / 86400000)
  if (!Number.isFinite(days) || from.toISOString().slice(0,10) !== start || to.toISOString().slice(0,10) !== end || days < 1 || days > 90 || from < new Date(new Date().toISOString().slice(0,10) + 'T00:00:00.000Z')) throw new Error('Invalid rental dates')
  return { days, start, end }
}
const availableRentalIds = async () => {
  // Conservative: never advertise a currently reserved or locked item as available.
  // The existing rental ledger has no future calendar intervals, so this does NOT
  // promise future-date booking; final checkout must re-check atomically.
  const [locks, reservations] = await Promise.all([
    RentalItemLock.distinct('listing'),
    RentalReservation.distinct('listing', { $or: [{ state: { $in: ['paid', 'activated', 'reconciliation_required'] } }, { state: { $in: ['reserved', 'payment_pending'] }, expiresAt: { $gt: new Date() } }] })
  ])
  return [...new Set([...locks, ...reservations].map(String))]
}
const buildFilter = query => {
  const rentalDates = parseRentalDates(query)
  const q = normalize(query.q || query.search)
  const type = bounded(query.type, 20)
  const category = bounded(query.category, 80)
  const university = bounded(query.university, 100)
  const minPrice = numberParam(query.minPrice, 0)
  const maxPrice = numberParam(query.maxPrice, Number.MAX_SAFE_INTEGER)
  if (rentalDates && type !== 'rent') throw new Error('Invalid rental dates: select Rentals')
  if (type && !types.has(type)) throw new Error('Invalid listing type')
  if (![minPrice, maxPrice].every(Number.isFinite) || minPrice < 0 || maxPrice < minPrice) throw new Error('Invalid price range')
  const filter = { status: 'Active' }
  if (type) filter.type = type
  if (category) filter.category = category
  if (rentalDates) filter.$and = [{ $or: [{ maxDays: { $gte: rentalDates.days } }, { maxDays: { $exists: false } }] }]
  if (q) {
    const words = q.split(' ').filter(w => w.length > 1).slice(0, 8)
    if (words.length) filter.$and = [...(filter.$and || []), ...words.map(word => ({ $or: expandTerm(word).flatMap(term => ['title', 'category', 'desc'].map(field => ({ [field]: { $regex: escapeRegex(term), $options: 'i' } }))) }))]
  }
  if (minPrice || maxPrice !== Number.MAX_SAFE_INTEGER) {
    const range = { $gte: minPrice, $lte: maxPrice }
    if (type === 'rent') filter.dailyRate = range
    else if (type === 'product' || type === 'service') filter.price = range
    else filter.$or = [{ type: 'rent', dailyRate: range }, { type: { $in: ['product', 'service'] }, price: range }]
  }
  return { filter, q, university, rentalDates }
}
const sellerFilter = university => university ? [{ $lookup: { from: 'users', localField: 'seller', foreignField: '_id', as: '_seller' } }, { $match: { '_seller.university': { $regex: `^${escapeRegex(university)}$`, $options: 'i' } } }] : []
const scoreStages = q => q ? [{ $addFields: { relevance: { $add: [
  { $cond: [{ $eq: [{ $toLower: '$title' }, q] }, 100, 0] },
  { $cond: [{ $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: `^${escapeRegex(q)}`, options: 'i' } }, 50, 0] },
  { $cond: [{ $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: escapeRegex(q), options: 'i' } }, 25, 0] },
  { $cond: [{ $regexMatch: { input: { $ifNull: ['$category', ''] }, regex: escapeRegex(q), options: 'i' } }, 10, 0] },
  { $multiply: [{ $ifNull: ['$rating', 0] }, 2] }
] } } }] : [{ $addFields: { relevance: { $multiply: [{ $ifNull: ['$rating', 0] }, 2] } } }]
router.get('/', async (req, res) => {
  try {
    const { filter, q, university, rentalDates } = buildFilter(req.query)
    if (rentalDates) {
      const unavailable = await availableRentalIds()
      filter._id = { $nin: unavailable.filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(id)) }
    }
    const pageRaw = numberParam(req.query.page, 1)
    if (!Number.isFinite(pageRaw) || pageRaw < 1) return res.status(400).json({ message: 'Invalid page' })
    const page = Math.max(1, Math.min(100, Math.floor(pageRaw)))
    const limitRaw = numberParam(req.query.limit, 16)
    if (!Number.isFinite(limitRaw) || limitRaw < 1) return res.status(400).json({ message: 'Invalid limit' })
    const limit = Math.max(1, Math.min(40, Math.floor(limitRaw)))
    const sort = bounded(req.query.sort, 20)
    const sorts = { relevant: { relevance: -1, createdAt: -1 }, newest: { createdAt: -1 }, price_asc: { effectivePrice: 1, _id: 1 }, price_desc: { effectivePrice: -1, _id: 1 }, rating: { rating: -1, reviews: -1, createdAt: -1 } }
    if (sort && !sorts[sort]) return res.status(400).json({ message: 'Invalid sort' })
    const stages = [{ $match: filter }, ...sellerFilter(university), ...scoreStages(q), { $addFields: { effectivePrice: { $cond: [{ $eq: ['$type', 'rent'] }, '$dailyRate', '$price'] } } }]
    // Fuzzy fallback only if the exact/synonym query has no hits. Candidate cap prevents an unbounded scan.
    const countMatches = q ? await Listing.countDocuments(filter) : 1
    if (q && !countMatches) {
      const fallbackFilter = { ...filter }
      delete fallbackFilter.$and
      if (rentalDates) fallbackFilter.$and = [{ $or: [{ maxDays: { $gte: rentalDates.days } }, { maxDays: { $exists: false } }] }]
      const candidates = await Listing.find(fallbackFilter).select('title desc category type price dailyRate image rating reviews seller createdAt').sort({ createdAt: -1 }).limit(600).lean()
      const ranked = candidates.map(item => ({ ...item, relevance: fuzzyScore(q, item) })).filter(item => item.relevance > 0)
      const sorters = {
        relevant: (a,b) => b.relevance-a.relevance || new Date(b.createdAt)-new Date(a.createdAt),
        newest: (a,b) => new Date(b.createdAt)-new Date(a.createdAt),
        price_asc: (a,b) => (a.type==='rent'?a.dailyRate:a.price)-(b.type==='rent'?b.dailyRate:b.price),
        price_desc: (a,b) => (b.type==='rent'?b.dailyRate:b.price)-(a.type==='rent'?a.dailyRate:a.price),
        rating: (a,b) => (b.rating||0)-(a.rating||0)
      }
      ranked.sort(sorters[sort || 'relevant'])
      if (university) {
        await Listing.populate(ranked, { path: 'seller', select: 'name university' })
      }
      const eligible = university ? ranked.filter(item => normalize(item.seller?.university) === normalize(university)) : ranked
      const items = eligible.slice((page-1)*limit,page*limit)
      if (!university) await Listing.populate(items, { path: 'seller', select: 'name university' })
      return res.json({ items, total: eligible.length, page, limit, pages: Math.ceil(eligible.length/limit), approximate: true, facets: { categories: [], types: [] } })
    }
    const [result] = await Listing.aggregate([...stages, { $facet: {
      items: [{ $sort: sorts[sort || 'relevant'] }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { title: 1, desc: 1, category: 1, type: 1, price: 1, dailyRate: 1, image: 1, rating: 1, reviews: 1, seller: 1, createdAt: 1 } }],
      count: [{ $count: 'total' }],
      categories: [{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 30 }],
      types: [{ $group: { _id: '$type', count: { $sum: 1 } } }]
    } }])
    await Listing.populate(result.items, { path: 'seller', select: 'name university' })
    res.json({ items: result.items, total: result.count[0]?.total || 0, page, limit, pages: Math.ceil((result.count[0]?.total || 0) / limit), facets: { categories: result.categories.map(x => ({ name: x._id, count: x.count })), types: result.types.map(x => ({ name: x._id, count: x.count })) } })
  } catch (err) { res.status(err.message.startsWith('Invalid') ? 400 : 500).json({ message: err.message.startsWith('Invalid') ? err.message : 'Search temporarily unavailable' }) }
})
router.get('/suggest', async (req, res) => {
  try {
    const q = normalize(req.query.q)
    if (q.length < 2) return res.json({ suggestions: [] })
    const type = bounded(req.query.type, 20)
    if (type && !types.has(type)) return res.status(400).json({ message: 'Invalid listing type' })
    const terms = tokenize(q).slice(0, 6)
    const filter = { status: 'Active', $and: terms.map(term => ({ $or: expandTerm(term).map(word => ({ title: { $regex: escapeRegex(word), $options: 'i' } })) })) }
    if (type) filter.type = type
    let listings = await Listing.find(filter).select('title type category image price dailyRate rating createdAt').limit(60).lean()
    if (!listings.length) {
      const fallback = { status: 'Active' }
      if (type) fallback.type = type
      listings = (await Listing.find(fallback).select('title type category image price dailyRate rating createdAt').sort({ createdAt: -1 }).limit(400).lean()).filter(item => fuzzyScore(q, item) > 0)
    }
    listings.sort((a,b) => fuzzyScore(q,b)-fuzzyScore(q,a))
    listings = listings.slice(0,8)
    res.json({ suggestions: listings })
  } catch { res.status(500).json({ message: 'Suggestions unavailable' }) }
})
export default router

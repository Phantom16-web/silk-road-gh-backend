// lib/ogCore.js
//
// Builds WhatsApp / Facebook / Telegram / X link-preview tags for a listing.
//
// Why this exists: the site is a single-page app, so every URL serves the same index.html with the
// same generic <meta> tags, and link-preview crawlers do not run JavaScript. Without this, every
// shared listing would show the generic "Silk Road GH" card instead of the item's photo, title
// and price.
//
// This file is host-neutral (plain JavaScript, no dependencies, no Vercel APIs). The Vercel
// adapter is api/listing.js; a Cloudflare Pages adapter can wrap the same function.

export const DEFAULT_ORIGIN = "https://silk-road-gh.vercel.app"
export const SITE_NAME = "Silk Road GH"
const DEFAULT_PAGE_TITLE = "Silk Road GH — Ghana's Student Marketplace"
const DEFAULT_TITLE = "Silk Road GH"
const DEFAULT_DESCRIPTION = "Ghana's student marketplace — buy, sell, rent, request services."

const ID_PATTERN = /^[a-fA-F0-9]{24}$/
export const isValidId = id => typeof id === "string" && ID_PATTERN.test(id)

export const escapeHtml = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

// Collapses whitespace, strips control characters and trims to a length with an ellipsis.
const plain = (value, max) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text
}

// Cloudinary photo -> 1200x630 JPEG (the large-preview size WhatsApp and Facebook like, well under
// their size limits). Anything not on Cloudinary over https is rejected, so a crafted listing can
// never point a preview at an arbitrary host.
export function ogImage(url) {
  if (typeof url !== "string") return null
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null
  const marker = "/image/upload/"
  const at = parsed.pathname.indexOf(marker)
  if (at === -1) return null
  const [first, ...others] = parsed.pathname.slice(at + marker.length).split("/")
  // Standard uploads look like .../upload/v1700000000/folder/name.jpg. Anything else already carries
  // transformations, so use it untouched.
  if (!/^v\d+$/.test(first)) return { url: parsed.origin + parsed.pathname, resized: false }
  const head = parsed.pathname.slice(0, at + marker.length)
  const rest = `${first}/${others.join("/")}`.replace(/\.[A-Za-z0-9]+$/, ".jpg")
  return { url: `${parsed.origin}${head}c_fill,g_auto,w_1200,h_630,q_auto:good,f_jpg/${rest}`, resized: true }
}

const priceText = listing => {
  const amount = Number(listing.type === "rent" ? listing.dailyRate : listing.price)
  if (!Number.isFinite(amount) || amount <= 0) return ""
  return `GH₵ ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}${listing.type === "rent" ? " / day" : ""}`
}

export function buildListingMeta(listing, origin) {
  const label = { product: "For sale", rent: "For rent", service: "Service" }[listing.type] || "Listing"
  const price = priceText(listing)
  const campus = plain(listing.seller?.university, 60)
  const headline = [label, campus].filter(Boolean).join(" · ")
  const image = ogImage(listing.image)
  return {
    pageTitle: plain(`${listing.title} — ${SITE_NAME}`, 100),
    title: plain(price ? `${listing.title} — ${price}` : listing.title, 90),
    description: plain(listing.desc ? `${headline} — ${listing.desc}` : headline, 180),
    url: `${origin}/listing/${String(listing._id).toLowerCase()}`,
    image: image?.url || `${origin}/preview.png`,
    imageResized: !!image?.resized,
    imageAlt: plain(listing.title, 100) || SITE_NAME,
  }
}

// Used when the listing is missing, removed or the backend is unreachable. og:url still names the
// listing's own address so previews of different listings can never overwrite each other's cache.
export const defaultMeta = (origin, url) => ({
  pageTitle: DEFAULT_PAGE_TITLE, title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION,
  url, image: `${origin}/preview.png`, imageResized: false, imageAlt: SITE_NAME,
})

// Removes the generic tags already in the page, then adds this listing's before </head>.
const STRIP = [
  /<title[\s\S]*?<\/title>\s*/i,
  /<meta\s+[^>]*?(?:property|name)\s*=\s*["'](?:og:[^"']*|twitter:[^"']*|description)["'][^>]*>\s*/gi,
  /<link\s+[^>]*?rel\s*=\s*["']canonical["'][^>]*>\s*/gi,
]
export function injectMeta(html, meta) {
  if (!/<\/head>/i.test(html)) return html
  let out = String(html)
  for (const pattern of STRIP) out = out.replace(pattern, "")
  const e = escapeHtml
  const tags = [
    `<title>${e(meta.pageTitle)}</title>`,
    `<meta name="description" content="${e(meta.description)}" />`,
    `<link rel="canonical" href="${e(meta.url)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${e(meta.title)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    `<meta property="og:url" content="${e(meta.url)}" />`,
    `<meta property="og:image" content="${e(meta.image)}" />`,
    ...(meta.imageResized ? [`<meta property="og:image:width" content="1200" />`, `<meta property="og:image:height" content="630" />`] : []),
    `<meta property="og:image:alt" content="${e(meta.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(meta.title)}" />`,
    `<meta name="twitter:description" content="${e(meta.description)}" />`,
    `<meta name="twitter:image" content="${e(meta.image)}" />`,
  ]
  return out.replace(/<\/head>/i, () => `  ${tags.join("\n  ")}\n</head>`)
}

// Last-resort page if index.html cannot be fetched. Crawlers only need the <head>.
const shellHtml = origin =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${SITE_NAME}</title></head><body><p><a href="${escapeHtml(origin)}">Open ${SITE_NAME}</a></p></body></html>`

// A request that can never hang: the timer covers reading the body too.
async function request(fetchImpl, url, timeoutMs, parse) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: parse === "json" ? "application/json" : "text/html" } })
    const body = res.ok ? (parse === "json" ? await res.json() : await res.text()) : null
    return { ok: !!res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns { html, cacheControl, outcome } for a listing link.
 *   id        the listing id from the URL
 *   origin    the public site, e.g. https://silk-road-gh.vercel.app
 *   apiBase   the backend API root, e.g. https://xxx.onrender.com/api
 * Never throws: every failure degrades to the generic card with a short cache time.
 */
export async function renderListingPage({ id, origin, apiBase, fetchImpl = globalThis.fetch, listingTimeoutMs = 6000, indexTimeoutMs = 2500 }) {
  const valid = isValidId(id)
  const listingId = valid ? id.toLowerCase() : ""
  const api = /^https?:\/\//i.test(apiBase || "") ? apiBase.replace(/\/+$/, "") : ""
  const [indexRes, listingRes] = await Promise.all([
    request(fetchImpl, `${origin}/index.html`, indexTimeoutMs, "text"),
    valid && api ? request(fetchImpl, `${api}/listings/${listingId}`, listingTimeoutMs, "json") : Promise.resolve(null),
  ])
  const indexUsable = indexRes.ok && typeof indexRes.body === "string" && /<\/head>/i.test(indexRes.body)

  let meta = defaultMeta(origin, valid ? `${origin}/listing/${listingId}` : origin)
  let cacheControl = "public, s-maxage=60"
  let outcome = valid ? "no-api" : "invalid-id"
  if (listingRes) {
    const listing = listingRes.body
    if (listingRes.ok && listing && String(listing._id).toLowerCase() === listingId && (!listing.status || listing.status === "Active")) {
      meta = buildListingMeta(listing, origin)
      cacheControl = "public, s-maxage=300, stale-while-revalidate=86400"
      outcome = "listing"
    } else if (listingRes.ok || listingRes.status === 404) {
      outcome = "missing"
    } else {
      cacheControl = "public, s-maxage=10" // backend asleep or erroring: let the next crawl retry soon
      outcome = "backend-unavailable"
    }
  }
  if (!indexUsable) cacheControl = "no-store" // the fallback shell must never be cached for real visitors
  return { html: injectMeta(indexUsable ? indexRes.body : shellHtml(origin), meta), cacheControl, outcome }
}

/* global process */
// api/listing.js  (Vercel serverless function)
//
// Serves a listing's page with ITS OWN link-preview tags (photo, title, price) so WhatsApp,
// Facebook, Telegram and X show the real item. vercel.json sends only link-preview bots here;
// normal visitors keep getting the instant static page.
//
// Runtime settings (Vercel -> Project -> Settings -> Environment Variables):
//   VITE_API_URL  (already set for the app) the backend API root, read here at runtime
//   API_URL       optional: overrides VITE_API_URL for this function
//   SITE_ORIGIN   optional: public address of the site, e.g. https://silkroadgh.com
//                 (defaults to https://silk-road-gh.vercel.app)

import { renderListingPage, DEFAULT_ORIGIN } from "../lib/ogCore.js"

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405
    res.setHeader("Allow", "GET, HEAD")
    return res.end("Method not allowed")
  }
  try {
    const raw = req.query?.id
    const id = String(Array.isArray(raw) ? raw[0] : raw || "")
    const origin = (process.env.SITE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, "")
    const apiBase = process.env.API_URL || process.env.VITE_API_URL || ""
    const { html, cacheControl, outcome } = await renderListingPage({ id, origin, apiBase })
    if (outcome === "backend-unavailable" || outcome === "no-api") console.warn(`[og] generic preview served for ${id || "(no id)"}: ${outcome}`)
    res.statusCode = 200
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Cache-Control", cacheControl)
    return res.end(req.method === "HEAD" ? undefined : html)
  } catch (err) {
    console.error("[og] preview failed:", err)
    res.statusCode = 500
    res.setHeader("Cache-Control", "no-store")
    return res.end("Preview unavailable")
  }
}

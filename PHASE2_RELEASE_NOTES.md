Silk Road Advanced Search Phase 2 — STAGING

Changes: bounded typo-tolerant fallback, curated synonym expansion, improved relevance ranking, autocomplete from active MongoDB listings, header search API integration. Rider login/online fix retained in frontend.

Caveats: typo fallback scans up to 600 newest eligible listings; approximate result count; no production integration tests. Confirm real DB behavior before release. Do not upload .env or node_modules.

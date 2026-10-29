# Silk Road GH — Consolidated Services Staging Release

These are **complete repository snapshots** (not incremental patches). They combine:
- Advanced Search Phase 3 base
- Search item details and rider blank-screen hotfix (App.jsx, AdvancedSearch.jsx, RentItems.jsx)
- Services Phase 1 provider acceptance, no embedded video
- Services Phase 2 safety gates
- Services Phase 2 grouped checkout/payment and service settlement patch

## Installation
Unzip BACKEND into the root of `silk-road-gh-backend` and FRONTEND into the root of `silk-road-gh`, retaining folder paths. Review differences before merging; do not overwrite .env, secrets, or newer unrelated changes. Do not upload ZIP files as a single source file. Do not overwrite one repo with the other.

## Financial safety / limitations
STAGING ONLY. MongoDB replica set/transaction support, Paystack test keys, manual MoMo evidence verification, payment webhooks, duplicate checkout, refund/dispute paths, settlement and payout reconciliation require real integration tests. No live payment or payout should be enabled before these pass.

This is a consolidated **code baseline**, not proof of a successful live payment.

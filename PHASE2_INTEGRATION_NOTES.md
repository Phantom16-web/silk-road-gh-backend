# Services Phase 2 — financial safety checkpoint

This package does NOT activate collection or payout. The existing Owner payout executor requires a verified CheckoutGroup; creating a standalone service Order through /payments would not satisfy that requirement. The general /orders route now blocks service listings to prevent bypassing provider acceptance. The service request model and API provide a fail-closed checkout endpoint that explicitly returns SERVICE_FINANCE_NOT_READY.

Do not promote this staging patch as a working payment feature. Next implementation must atomically link an accepted ServiceRequest, Order, and verified CheckoutGroup, apply the effective Owner commission schedule, and provide service-specific completion/dispute settlement gates.

Paths: backend routes/orders.js, routes/serviceRequests.js, models/ServiceRequest.js; frontend src/RequestService.jsx.

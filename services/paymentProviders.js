import crypto from "crypto"

const PAYSTACK_BASE_URL =
  process.env.PAYSTACK_BASE_URL ||
  "https://api.paystack.co"

export class PaymentProviderError extends Error {
  constructor(message, code = "PAYMENT_PROVIDER_ERROR") {
    super(message)
    this.name = "PaymentProviderError"
    this.code = code
  }
}

function generateReference(prefix = "SR") {
  return `${prefix}-${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")
    .toUpperCase()}`
}

function toSubunit(amount) {
  return Math.round(Number(amount) * 100)
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

export const manualPaymentProvider = {
  name: "manual",

  async createPayment({
    order,
    amount,
    currency = "GHS",
  }) {
    return {
      provider: "manual",
      reference: generateReference("SR-MANUAL"),
      amount,
      currency,
      status: "pending",
    }
  },

  async verifyPayment() {
    return {
      verified: false,
      requiresManualReview: true,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYSTACK
// ─────────────────────────────────────────────────────────────────────────────

export const paystackPaymentProvider = {
  name: "paystack",

  async createPayment({
    order,
    amount,
    currency = "GHS",
    email,
  }) {
    const secretKey =
      process.env.PAYSTACK_SECRET_KEY

    if (!secretKey) {
      throw new PaymentProviderError(
        "Paystack is not configured.",
        "PAYSTACK_NOT_CONFIGURED"
      )
    }

    if (!email) {
      throw new PaymentProviderError(
        "A customer email address is required for Paystack.",
        "PAYSTACK_EMAIL_REQUIRED"
      )
    }

    const reference =
      generateReference("SR-PAYSTACK")

    const body = {
      email,
      amount: String(
        toSubunit(amount)
      ),
      currency,
      reference,

      metadata: {
        silk_road_order_id:
          String(order._id),

        silk_road_local_order_id:
          order.localOrderId || "",

        silk_road_payment_method:
          "paystack",
      },
    }

    const response =
      await fetch(
        `${PAYSTACK_BASE_URL}/transaction/initialize`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${secretKey}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify(body),
        }
      )

    let result

    try {
      result = await response.json()
    } catch {
      throw new PaymentProviderError(
        "Paystack returned an invalid response.",
        "PAYSTACK_INVALID_RESPONSE"
      )
    }

    if (
      !response.ok ||
      !result?.status
    ) {
      throw new PaymentProviderError(
        result?.message ||
          "Paystack transaction initialization failed.",
        "PAYSTACK_INITIALIZATION_FAILED"
      )
    }

    return {
      provider: "paystack",

      reference:
        result.data.reference,

      authorizationUrl:
        result.data.authorization_url,

      accessCode:
        result.data.access_code,

      amount,

      currency,

      status: "pending",
    }
  },

  async verifyPayment(reference) {
    const secretKey =
      process.env.PAYSTACK_SECRET_KEY

    if (!secretKey) {
      throw new PaymentProviderError(
        "Paystack is not configured.",
        "PAYSTACK_NOT_CONFIGURED"
      )
    }

    if (!reference) {
      throw new PaymentProviderError(
        "Paystack reference is required.",
        "PAYSTACK_REFERENCE_REQUIRED"
      )
    }

    const response =
      await fetch(
        `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${secretKey}`,
          },
        }
      )

    let result

    try {
      result = await response.json()
    } catch {
      throw new PaymentProviderError(
        "Paystack returned an invalid verification response.",
        "PAYSTACK_INVALID_RESPONSE"
      )
    }

    if (
      !response.ok ||
      !result?.status
    ) {
      throw new PaymentProviderError(
        result?.message ||
          "Paystack verification failed.",
        "PAYSTACK_VERIFICATION_FAILED"
      )
    }

    const transaction =
      result.data

    return {
      verified:
        transaction.status ===
        "success",

      status:
        transaction.status,

      reference:
        transaction.reference,

      amount:
        Number(transaction.amount) / 100,

      currency:
        transaction.currency,

      raw:
        transaction,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const providers = {
  manual:
    manualPaymentProvider,

  paystack:
    paystackPaymentProvider,
}

export function getPaymentProvider(
  provider
) {
  const selected =
    providers[provider]

  if (!selected) {
    throw new PaymentProviderError(
      `Unsupported payment provider: ${provider}`,
      "UNSUPPORTED_PAYMENT_PROVIDER"
    )
  }

  return selected
}

export default providers

import crypto from "crypto"

/*
 * Silk Road Payment Provider Layer
 *
 * IMPORTANT:
 * Payment providers are adapters.
 *
 * The Silk Road transaction engine must NOT depend directly
 * on Paystack.
 *
 * Available providers:
 *
 *   manual  -> human/admin verification
 *   paystack -> automated provider verification
 *
 * Later we can add:
 *
 *   momo
 *   hubtel
 *   stripe
 *   another Ghanaian provider
 *
 * without changing the Order/Delivery engine.
 */

export class PaymentProviderError extends Error {
  constructor(message, code = "PAYMENT_PROVIDER_ERROR") {
    super(message)
    this.name = "PaymentProviderError"
    this.code = code
  }
}

/* ---------------------------------------------------------
   MANUAL PAYMENT PROVIDER
--------------------------------------------------------- */

export const manualPaymentProvider = {
  name: "manual",

  async createPayment({ order, amount, currency = "GHS" }) {
    return {
      provider: "manual",
      reference: `MANUAL-${order._id}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      amount,
      currency,
      status: "pending",
      instructions: {
        message:
          "Complete payment using the Silk Road payment instructions, then submit your payment reference.",
      },
    }
  },

  async verifyPayment() {
    /*
     * Manual payments are NOT automatically verified.
     *
     * An authorized Silk Road administrator must verify
     * the payment and move it to escrow.
     */
    return {
      verified: false,
      requiresManualReview: true,
    }
  },
}

/* ---------------------------------------------------------
   PAYSTACK PROVIDER
--------------------------------------------------------- */

export const paystackPaymentProvider = {
  name: "paystack",

  async createPayment({ order, amount, currency = "GHS" }) {
    /*
     * We deliberately do NOT require a live Paystack account
     * here.
     *
     * This adapter can be completed when Paystack credentials
     * are available.
     */

    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new PaymentProviderError(
        "Paystack is currently unavailable because no Paystack secret key is configured.",
        "PAYSTACK_NOT_CONFIGURED"
      )
    }

    throw new PaymentProviderError(
      "Paystack payment creation has not been enabled yet.",
      "PAYSTACK_NOT_IMPLEMENTED"
    )
  },

  async verifyPayment() {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new PaymentProviderError(
        "Paystack is not configured.",
        "PAYSTACK_NOT_CONFIGURED"
      )
    }

    throw new PaymentProviderError(
      "Paystack verification has not been enabled yet.",
      "PAYSTACK_NOT_IMPLEMENTED"
    )
  },
}

/* ---------------------------------------------------------
   PROVIDER REGISTRY
--------------------------------------------------------- */

const providers = {
  manual: manualPaymentProvider,
  paystack: paystackPaymentProvider,
}

export function getPaymentProvider(provider) {
  const selected = providers[provider]

  if (!selected) {
    throw new PaymentProviderError(
      `Unsupported payment provider: ${provider}`,
      "UNSUPPORTED_PAYMENT_PROVIDER"
    )
  }

  return selected
}

export default providers

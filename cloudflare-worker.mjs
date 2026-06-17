const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 1000000;

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = env.ALLOWED_ORIGIN || "https://www.iacceptdonations.com";

  return {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function getSiteUrl(request, env) {
  return (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
}

function getAmountCents(amount) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return 0;
  }

  return Math.round(numericAmount * 100);
}

async function createStripeCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: "Missing STRIPE_SECRET_KEY Worker secret." }, 500, corsHeaders(request, env));
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400, corsHeaders(request, env));
  }

  const amountCents = getAmountCents(payload.amount);

  if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    return jsonResponse({ error: "Donation amount must be between $1 and $10,000." }, 400, corsHeaders(request, env));
  }

  const siteUrl = getSiteUrl(request, env);
  const productImageUrl = env.PRODUCT_IMAGE_URL || `${siteUrl}/assets/stripe-money-trash-product-1024.jpg`;
  const stripeBody = new URLSearchParams({
    mode: "payment",
    success_url: `${siteUrl}/?donation=accepted`,
    cancel_url: `${siteUrl}/#donate`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": amountCents.toString(),
    "line_items[0][price_data][product_data][name]": "Donation to iAcceptDonations.com",
    "line_items[0][price_data][product_data][description]": "A voluntary contribution. You receive nothing, efficiently.",
    "line_items[0][price_data][product_data][images][0]": productImageUrl
  });

  const stripeResponse = await fetch(STRIPE_CHECKOUT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: stripeBody
  });

  const stripeResult = await stripeResponse.json();

  if (!stripeResponse.ok) {
    return jsonResponse(
      { error: stripeResult.error?.message || "Stripe checkout session creation failed." },
      502,
      corsHeaders(request, env)
    );
  }

  return jsonResponse({ url: stripeResult.url }, 200, corsHeaders(request, env));
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/create-checkout-session") {
      return createStripeCheckoutSession(request, env);
    }

    return jsonResponse({ error: "Not found." }, 404, headers);
  }
};

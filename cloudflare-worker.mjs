const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 1000000;
const CANONICAL_HOST = "www.iacceptdonations.com";
const APEX_HOST = "iacceptdonations.com";
const API_RATE_LIMIT_WINDOW_MS = 60000;
const API_RATE_LIMIT_DEFAULT_MAX = 20;
const API_RATE_LIMIT_CAPTURE_MAX = 10;
const PAYMENT_UNAVAILABLE_MESSAGE = "Payment checkout is temporarily unavailable. Please try again later.";
const INVALID_PAYMENT_REQUEST_MESSAGE = "Invalid payment request.";
const rateLimitBuckets = new Map();
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://static.cloudflareinsights.com",
    "connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com https://cloudflareinsights.com",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://buy.stripe.com https://www.paypal.com",
    "upgrade-insecure-requests"
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff"
};

function getPayPalApiBase(env) {
  return env.PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
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

function getClientIdentifier(request) {
  const forwardedFor = request.headers.get("X-Forwarded-For") || "";
  const forwardedIp = forwardedFor.split(",")[0]?.trim();

  return request.headers.get("CF-Connecting-IP") || forwardedIp || "unknown";
}

function isRateLimited(request, pathname, maxRequests) {
  const now = Date.now();
  const clientIdentifier = getClientIdentifier(request);
  const key = `${pathname}:${clientIdentifier}`;
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + API_RATE_LIMIT_WINDOW_MS
    });
    return false;
  }

  bucket.count += 1;

  return bucket.count > maxRequests;
}

function getApiRateLimitMax(pathname) {
  return pathname === "/api/capture-paypal-order"
    ? API_RATE_LIMIT_CAPTURE_MAX
    : API_RATE_LIMIT_DEFAULT_MAX;
}

function getAmountCents(amount) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return 0;
  }

  return Math.round(numericAmount * 100);
}

function getSafeAmountValue(amount) {
  const amountCents = getAmountCents(amount);

  if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    return "";
  }

  return (amountCents / 100).toFixed(2);
}

async function getPayPalAccessToken(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal credentials are unavailable.");
  }

  const paypalResponse = await fetch(`${getPayPalApiBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const paypalResult = await paypalResponse.json();

  if (!paypalResponse.ok || !paypalResult.access_token) {
    throw new Error("PayPal authentication failed.");
  }

  return paypalResult.access_token;
}

async function createStripeCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500, corsHeaders(request, env));
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
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
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 502, corsHeaders(request, env));
  }

  return jsonResponse({ url: stripeResult.url }, 200, corsHeaders(request, env));
}

async function createPayPalOrder(request, env) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
  }

  const amountValue = getSafeAmountValue(payload.amount);

  if (!amountValue) {
    return jsonResponse({ error: "Donation amount must be between $1 and $10,000." }, 400, corsHeaders(request, env));
  }

  try {
    const accessToken = await getPayPalAccessToken(env);
    const siteUrl = getSiteUrl(request, env);
    const paypalResponse = await fetch(`${getPayPalApiBase(env)}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: "A voluntary contribution. You receive nothing, efficiently.",
            amount: {
              currency_code: "USD",
              value: amountValue
            }
          }
        ],
        application_context: {
          brand_name: "iAcceptDonations.com",
          cancel_url: `${siteUrl}/#donate`,
          return_url: `${siteUrl}/?paypal=approved`,
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW"
        }
      })
    });

    const paypalResult = await paypalResponse.json();
    const approvalUrl = paypalResult.links?.find((link) => link.rel === "approve")?.href;

    if (!paypalResponse.ok || !approvalUrl) {
      return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 502, corsHeaders(request, env));
    }

    return jsonResponse({ orderID: paypalResult.id, url: approvalUrl }, 200, corsHeaders(request, env));
  } catch {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500, corsHeaders(request, env));
  }
}

async function capturePayPalOrder(request, env) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
  }

  if (!payload.orderID) {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
  }

  try {
    const accessToken = await getPayPalAccessToken(env);
    const paypalResponse = await fetch(`${getPayPalApiBase(env)}/v2/checkout/orders/${payload.orderID}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    const paypalResult = await paypalResponse.json();

    if (!paypalResponse.ok) {
      return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 502, corsHeaders(request, env));
    }

    return jsonResponse({ status: paypalResult.status, id: paypalResult.id }, 200, corsHeaders(request, env));
  } catch {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500, corsHeaders(request, env));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if ((request.method === "GET" || request.method === "HEAD") && url.hostname === APEX_HOST) {
      url.hostname = CANONICAL_HOST;
      return new Response(null, {
        status: 308,
        headers: {
          Location: url.toString(),
          ...SECURITY_HEADERS
        }
      });
    }

    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...headers } });
    }

    if (request.method === "POST" && url.pathname === "/api/create-checkout-session") {
      if (isRateLimited(request, url.pathname, getApiRateLimitMax(url.pathname))) {
        return jsonResponse({ error: "Too many payment requests. Please wait a minute and try again." }, 429, headers);
      }

      return createStripeCheckoutSession(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/create-paypal-order") {
      if (isRateLimited(request, url.pathname, getApiRateLimitMax(url.pathname))) {
        return jsonResponse({ error: "Too many payment requests. Please wait a minute and try again." }, 429, headers);
      }

      return createPayPalOrder(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/capture-paypal-order") {
      if (isRateLimited(request, url.pathname, getApiRateLimitMax(url.pathname))) {
        return jsonResponse({ error: "Too many payment requests. Please wait a minute and try again." }, 429, headers);
      }

      return capturePayPalOrder(request, env);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }
};

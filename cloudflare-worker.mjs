const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 1000000;
const CANONICAL_HOST = "www.iacceptdonations.com";
const APEX_HOST = "iacceptdonations.com";
const API_RATE_LIMIT_WINDOW_MS = 60000;
const API_RATE_LIMIT_DEFAULT_MAX = 20;
const API_RATE_LIMIT_CAPTURE_MAX = 10;
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
const PAYPAL_ORDER_ID_PATTERN = /^[A-Z0-9]{10,32}$/;
const PAYMENT_UNAVAILABLE_MESSAGE = "Payment checkout is temporarily unavailable. Please try again later.";
const INVALID_PAYMENT_REQUEST_MESSAGE = "Invalid payment request.";
const rateLimitBuckets = new Map();
const BLOCKED_PUBLIC_PATHS = [
  "/.env",
  "/.git",
  "/.wrangler",
  "/AGENTS.md",
  "/cloudflare-worker.mjs",
  "/DEPLOYMENT.md",
  "/migrations",
  "/node_modules",
  "/package-lock.json",
  "/package.json",
  "/security-audit",
  "/tests",
  "/wrangler.toml"
].map((item) => item.toLowerCase());
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

function hexEncode(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(firstValue, secondValue) {
  if (firstValue.length !== secondValue.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < firstValue.length; index += 1) {
    difference |= firstValue.charCodeAt(index) ^ secondValue.charCodeAt(index);
  }

  return difference === 0;
}

function redactIdentifier(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  if (value.length <= 10) {
    return `${value.slice(0, 2)}...`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

function notFoundResponse() {
  return new Response(null, {
    status: 404,
    headers: SECURITY_HEADERS
  });
}

export function isBlockedPublicPath(pathname) {
  const normalizedPath = pathname.toLowerCase();

  return (
    BLOCKED_PUBLIC_PATHS.some((blockedPath) => (
      normalizedPath === blockedPath ||
      normalizedPath.startsWith(`${blockedPath}/`)
    )) ||
    normalizedPath.endsWith(".log") ||
    normalizedPath.endsWith(".map") ||
    normalizedPath.endsWith(".sql")
  );
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

export function getSafePayPalOrderId(orderID) {
  if (typeof orderID !== "string") {
    return "";
  }

  const trimmedOrderId = orderID.trim();

  return PAYPAL_ORDER_ID_PATTERN.test(trimmedOrderId) ? trimmedOrderId : "";
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

function hasDatabase(env) {
  return Boolean(env.DB?.prepare);
}

function getCentsFromDecimalValue(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.round(amount * 100);
}

function getStripeEventDetails(event) {
  const object = event.data?.object || {};
  const amountCents = object.amount_total || object.amount_received || object.amount || 0;
  const paymentId = typeof object.payment_intent === "string"
    ? object.payment_intent
    : object.id || event.id;

  return {
    paymentId,
    amountCents,
    currency: (object.currency || "usd").toUpperCase(),
    status: object.payment_status || object.status || event.type,
    shouldRecordDonation: (
      event.type === "checkout.session.completed" ||
      event.type === "payment_intent.succeeded"
    ) && amountCents > 0
  };
}

function getPayPalEventDetails(event) {
  const resource = event.resource || {};
  const amount = resource.amount || resource.seller_receivable_breakdown?.gross_amount || {};

  return {
    paymentId: resource.id || event.id,
    amountCents: getCentsFromDecimalValue(amount.value),
    currency: (amount.currency_code || "USD").toUpperCase(),
    status: resource.status || event.event_type,
    shouldRecordDonation: event.event_type === "PAYMENT.CAPTURE.COMPLETED"
  };
}

function getPayPalOrderAmount(order) {
  const amount = order.purchase_units?.[0]?.amount || {};

  return {
    amountCents: getCentsFromDecimalValue(amount.value),
    currency: (amount.currency_code || "").toUpperCase()
  };
}

function getExpectedPayPalRecipient(env) {
  if (env.PAYPAL_MERCHANT_ID) {
    return {
      field: "merchant_id",
      value: env.PAYPAL_MERCHANT_ID
    };
  }

  if (env.PAYPAL_RECEIVER_EMAIL) {
    return {
      field: "email_address",
      value: env.PAYPAL_RECEIVER_EMAIL.toLowerCase()
    };
  }

  return null;
}

export function validatePayPalOrderDetails(order, expectedOrder, env = {}) {
  if (!order || !expectedOrder || order.id !== expectedOrder.order_id || order.intent !== "CAPTURE") {
    return false;
  }

  const amount = getPayPalOrderAmount(order);

  if (
    amount.amountCents !== expectedOrder.amount_cents ||
    amount.currency !== expectedOrder.currency
  ) {
    return false;
  }

  const expectedRecipient = getExpectedPayPalRecipient(env);

  if (expectedRecipient) {
    const payee = order.purchase_units?.[0]?.payee || {};
    const actualRecipient = expectedRecipient.field === "email_address"
      ? payee.email_address?.toLowerCase()
      : payee.merchant_id;

    if (actualRecipient !== expectedRecipient.value) {
      return false;
    }
  }

  return order.status === "APPROVED" || order.status === "COMPLETED";
}

export function getPayPalCaptureDetails(captureResult) {
  const capture = captureResult?.purchase_units
    ?.flatMap((unit) => unit.payments?.captures || [])
    ?.find((item) => item.status === "COMPLETED");

  if (!capture) {
    return null;
  }

  return {
    captureId: capture.id,
    amountCents: getCentsFromDecimalValue(capture.amount?.value),
    currency: (capture.amount?.currency_code || "").toUpperCase(),
    status: capture.status
  };
}

async function storePayPalOrder(env, orderId, amountCents, currency) {
  await env.DB.prepare(`
    INSERT INTO paypal_orders (
      order_id,
      amount_cents,
      currency,
      status
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      amount_cents = excluded.amount_cents,
      currency = excluded.currency,
      status = excluded.status,
      capture_id = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(orderId, amountCents, currency, "CREATED").run();
}

async function getPayPalOrderRecord(env, orderId) {
  return env.DB.prepare(`
    SELECT order_id, amount_cents, currency, status, capture_id
    FROM paypal_orders
    WHERE order_id = ?
  `).bind(orderId).first();
}

async function markPayPalOrderCaptured(env, orderId, captureId) {
  await env.DB.prepare(`
    UPDATE paypal_orders
    SET status = ?,
        capture_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE order_id = ?
  `).bind("COMPLETED", captureId, orderId).run();
}

async function storeWebhookEvent(env, provider, eventId, eventType, details, payload) {
  if (!hasDatabase(env)) {
    console.log("D1 DB binding not configured; verified webhook was not stored.", {
      provider,
      eventId: redactIdentifier(eventId),
      eventType
    });
    return { stored: false, duplicate: false };
  }

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO webhook_events (
      id,
      provider,
      event_type,
      payment_id,
      amount_cents,
      currency,
      status,
      payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    provider,
    eventType,
    details.paymentId,
    details.amountCents,
    details.currency,
    details.status,
    payload
  ).run();

  return {
    stored: true,
    duplicate: result.meta?.changes === 0
  };
}

async function upsertDonation(env, provider, sourceEventId, details) {
  await env.DB.prepare(`
    INSERT INTO donations (
      id,
      provider,
      payment_id,
      amount_cents,
      currency,
      status,
      source_event_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, payment_id) DO UPDATE SET
      amount_cents = excluded.amount_cents,
      currency = excluded.currency,
      status = excluded.status,
      source_event_id = excluded.source_event_id,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    `${provider}:${details.paymentId}`,
    provider,
    details.paymentId,
    details.amountCents,
    details.currency,
    details.status,
    sourceEventId
  ).run();
}

async function recordStripeWebhookEvent(env, event, payload) {
  const details = getStripeEventDetails(event);
  const result = await storeWebhookEvent(env, "stripe", event.id, event.type, details, payload);

  if (result.stored && !result.duplicate && details.shouldRecordDonation) {
    await upsertDonation(env, "stripe", event.id, details);
  }

  return result;
}

async function recordPayPalWebhookEvent(env, event, payload) {
  const details = getPayPalEventDetails(event);
  const result = await storeWebhookEvent(env, "paypal", event.id, event.event_type, details, payload);

  if (result.stored && !result.duplicate && details.shouldRecordDonation && details.amountCents > 0) {
    await upsertDonation(env, "paypal", event.id, details);
  }

  return result;
}

async function verifyStripeWebhookSignature(payload, signatureHeader, endpointSecret) {
  if (!signatureHeader || !endpointSecret) {
    return false;
  }

  const headerParts = signatureHeader.split(",").reduce((parts, item) => {
    const [key, value] = item.split("=");
    parts[key] = value;
    return parts;
  }, {});
  const timestamp = Number(headerParts.t);
  const signature = headerParts.v1;

  if (!Number.isFinite(timestamp) || !signature) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);

  if (Math.abs(nowInSeconds - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(endpointSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = hexEncode(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signedPayload)));

  return timingSafeEqual(expectedSignature, signature);
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500);
  }

  const payload = await request.text();
  const signatureHeader = request.headers.get("Stripe-Signature");
  const isVerified = await verifyStripeWebhookSignature(payload, signatureHeader, env.STRIPE_WEBHOOK_SECRET);

  if (!isVerified) {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400);
  }

  let event;

  try {
    event = JSON.parse(payload);
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400);
  }

  let recordResult;

  try {
    recordResult = await recordStripeWebhookEvent(env, event, payload);
  } catch (error) {
    console.error("Stripe webhook storage failed", { eventId: redactIdentifier(event.id), error: error.message });
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500);
  }

  if (recordResult.duplicate) {
    console.log("Duplicate Stripe webhook ignored", { id: redactIdentifier(event.id), type: event.type });
    return jsonResponse({ received: true, duplicate: true });
  }

  if (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded") {
    console.log("Stripe payment event verified", {
      id: redactIdentifier(event.id),
      type: event.type,
      objectId: redactIdentifier(event.data?.object?.id)
    });
  }

  return jsonResponse({ received: true, recorded: recordResult.stored });
}

function getRequiredPayPalWebhookHeaders(request) {
  return {
    auth_algo: request.headers.get("PAYPAL-AUTH-ALGO"),
    cert_url: request.headers.get("PAYPAL-CERT-URL"),
    transmission_id: request.headers.get("PAYPAL-TRANSMISSION-ID"),
    transmission_sig: request.headers.get("PAYPAL-TRANSMISSION-SIG"),
    transmission_time: request.headers.get("PAYPAL-TRANSMISSION-TIME")
  };
}

function hasPayPalWebhookHeaders(headers) {
  return Object.values(headers).every(Boolean);
}

async function verifyPayPalWebhookSignature(request, env, webhookEvent) {
  if (!env.PAYPAL_WEBHOOK_ID) {
    return false;
  }

  const webhookHeaders = getRequiredPayPalWebhookHeaders(request);

  if (!hasPayPalWebhookHeaders(webhookHeaders)) {
    return false;
  }

  const accessToken = await getPayPalAccessToken(env);
  const paypalResponse = await fetch(`${getPayPalApiBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...webhookHeaders,
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent
    })
  });
  const paypalResult = await paypalResponse.json();

  return paypalResponse.ok && paypalResult.verification_status === "SUCCESS";
}

async function handlePayPalWebhook(request, env) {
  if (!env.PAYPAL_WEBHOOK_ID) {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500);
  }

  let event;

  try {
    event = await request.json();
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400);
  }

  let isVerified = false;

  try {
    isVerified = await verifyPayPalWebhookSignature(request, env, event);
  } catch {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500);
  }

  if (!isVerified) {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400);
  }

  let recordResult;
  const payload = JSON.stringify(event);

  try {
    recordResult = await recordPayPalWebhookEvent(env, event, payload);
  } catch (error) {
    console.error("PayPal webhook storage failed", { eventId: redactIdentifier(event.id), error: error.message });
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500);
  }

  if (recordResult.duplicate) {
    console.log("Duplicate PayPal webhook ignored", { id: redactIdentifier(event.id), type: event.event_type });
    return jsonResponse({ received: true, duplicate: true });
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    console.log("PayPal payment event verified", {
      id: redactIdentifier(event.id),
      type: event.event_type,
      resourceId: redactIdentifier(event.resource?.id)
    });
  }

  return jsonResponse({ received: true, recorded: recordResult.stored });
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
  if (!hasDatabase(env)) {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500, corsHeaders(request, env));
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
  }

  const amountValue = getSafeAmountValue(payload.amount);
  const amountCents = getAmountCents(payload.amount);

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

    await storePayPalOrder(env, paypalResult.id, amountCents, "USD");

    return jsonResponse({ orderID: paypalResult.id, url: approvalUrl }, 200, corsHeaders(request, env));
  } catch {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500, corsHeaders(request, env));
  }
}

async function capturePayPalOrder(request, env) {
  if (!hasDatabase(env)) {
    return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 500, corsHeaders(request, env));
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
  }

  const orderID = getSafePayPalOrderId(payload.orderID);

  if (!orderID) {
    return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
  }

  try {
    const expectedOrder = await getPayPalOrderRecord(env, orderID);

    if (!expectedOrder) {
      return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
    }

    if (expectedOrder.status === "COMPLETED" && expectedOrder.capture_id) {
      return jsonResponse({ status: "COMPLETED", id: expectedOrder.capture_id }, 200, corsHeaders(request, env));
    }

    const accessToken = await getPayPalAccessToken(env);
    const orderResponse = await fetch(`${getPayPalApiBase(env)}/v2/checkout/orders/${orderID}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    const orderResult = await orderResponse.json();

    if (!orderResponse.ok || !validatePayPalOrderDetails(orderResult, expectedOrder, env)) {
      console.warn("PayPal order validation failed before capture", {
        orderId: redactIdentifier(orderID),
        status: orderResult?.status
      });
      return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
    }

    const existingCapture = getPayPalCaptureDetails(orderResult);

    if (existingCapture) {
      await markPayPalOrderCaptured(env, orderID, existingCapture.captureId);
      return jsonResponse({ status: existingCapture.status, id: existingCapture.captureId }, 200, corsHeaders(request, env));
    }

    const paypalResponse = await fetch(`${getPayPalApiBase(env)}/v2/checkout/orders/${orderID}/capture`, {
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

    const captureDetails = getPayPalCaptureDetails(paypalResult);

    if (!captureDetails) {
      return jsonResponse({ error: PAYMENT_UNAVAILABLE_MESSAGE }, 502, corsHeaders(request, env));
    }

    if (
      captureDetails.amountCents !== expectedOrder.amount_cents ||
      captureDetails.currency !== expectedOrder.currency
    ) {
      console.warn("PayPal capture amount validation failed", { orderId: redactIdentifier(orderID) });
      return jsonResponse({ error: INVALID_PAYMENT_REQUEST_MESSAGE }, 400, corsHeaders(request, env));
    }

    await markPayPalOrderCaptured(env, orderID, captureDetails.captureId);
    await upsertDonation(env, "paypal", `capture:${orderID}`, {
      paymentId: captureDetails.captureId,
      amountCents: captureDetails.amountCents,
      currency: captureDetails.currency,
      status: captureDetails.status
    });

    return jsonResponse({ status: captureDetails.status, id: captureDetails.captureId }, 200, corsHeaders(request, env));
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

    if ((request.method === "GET" || request.method === "HEAD") && isBlockedPublicPath(url.pathname)) {
      return notFoundResponse();
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

    if (request.method === "POST" && url.pathname === "/api/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/paypal-webhook") {
      return handlePayPalWebhook(request, env);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }
};

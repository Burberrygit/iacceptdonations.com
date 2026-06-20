import assert from "node:assert/strict";
import test from "node:test";
import {
  getPayPalCaptureDetails,
  getSafePayPalOrderId,
  isBlockedPublicPath,
  validatePayPalOrderDetails
} from "../cloudflare-worker.mjs";

test("getSafePayPalOrderId accepts only PayPal-shaped order IDs", () => {
  assert.equal(getSafePayPalOrderId("1AB23456CD789012E"), "1AB23456CD789012E");
  assert.equal(getSafePayPalOrderId(" 1AB23456CD789012E "), "1AB23456CD789012E");
  assert.equal(getSafePayPalOrderId("../.env"), "");
  assert.equal(getSafePayPalOrderId("abc123"), "");
  assert.equal(getSafePayPalOrderId(123), "");
});

test("validatePayPalOrderDetails requires matching order, amount, currency, and approved state", () => {
  const expectedOrder = {
    order_id: "1AB23456CD789012E",
    amount_cents: 2500,
    currency: "USD"
  };
  const order = {
    id: "1AB23456CD789012E",
    intent: "CAPTURE",
    status: "APPROVED",
    purchase_units: [
      {
        amount: {
          currency_code: "USD",
          value: "25.00"
        }
      }
    ]
  };

  assert.equal(validatePayPalOrderDetails(order, expectedOrder), true);
  assert.equal(validatePayPalOrderDetails({ ...order, status: "CREATED" }, expectedOrder), false);
  assert.equal(validatePayPalOrderDetails({ ...order, id: "9ZZ99999ZZ999999Z" }, expectedOrder), false);
  assert.equal(
    validatePayPalOrderDetails({
      ...order,
      purchase_units: [{ amount: { currency_code: "USD", value: "30.00" } }]
    }, expectedOrder),
    false
  );
  assert.equal(
    validatePayPalOrderDetails({
      ...order,
      purchase_units: [{ amount: { currency_code: "CAD", value: "25.00" } }]
    }, expectedOrder),
    false
  );
});

test("validatePayPalOrderDetails optionally validates merchant recipient", () => {
  const expectedOrder = {
    order_id: "1AB23456CD789012E",
    amount_cents: 2500,
    currency: "USD"
  };
  const order = {
    id: "1AB23456CD789012E",
    intent: "CAPTURE",
    status: "APPROVED",
    purchase_units: [
      {
        amount: {
          currency_code: "USD",
          value: "25.00"
        },
        payee: {
          merchant_id: "UYS7NA5ZL2WG6"
        }
      }
    ]
  };

  assert.equal(validatePayPalOrderDetails(order, expectedOrder, { PAYPAL_MERCHANT_ID: "UYS7NA5ZL2WG6" }), true);
  assert.equal(validatePayPalOrderDetails(order, expectedOrder, { PAYPAL_MERCHANT_ID: "WRONGMERCHANT" }), false);
});

test("getPayPalCaptureDetails returns completed capture details only", () => {
  const captureResult = {
    purchase_units: [
      {
        payments: {
          captures: [
            {
              id: "7XY12345AB678901C",
              status: "COMPLETED",
              amount: {
                currency_code: "USD",
                value: "25.00"
              }
            }
          ]
        }
      }
    ]
  };

  assert.deepEqual(getPayPalCaptureDetails(captureResult), {
    captureId: "7XY12345AB678901C",
    amountCents: 2500,
    currency: "USD",
    status: "COMPLETED"
  });
  assert.equal(getPayPalCaptureDetails({ purchase_units: [] }), null);
});

test("isBlockedPublicPath blocks internals without blocking security.txt", () => {
  assert.equal(isBlockedPublicPath("/.env"), true);
  assert.equal(isBlockedPublicPath("/.git/config"), true);
  assert.equal(isBlockedPublicPath("/migrations/0001_payment_ledger.sql"), true);
  assert.equal(isBlockedPublicPath("/tests/payment-security.test.mjs"), true);
  assert.equal(isBlockedPublicPath("/.well-known/security.txt"), false);
  assert.equal(isBlockedPublicPath("/assets/favicon.png"), false);
});

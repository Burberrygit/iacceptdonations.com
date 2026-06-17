const amountButtons = document.querySelectorAll(".amount-button");
const customAmount = document.querySelector("#custom-amount");
const gratitude = document.querySelector(".gratitude");
const donateButtons = document.querySelectorAll("[data-provider]");
const toast = document.querySelector(".toast");

const paymentConfig = {
  // Cloudflare Worker route for exact-amount Stripe Checkout.
  stripeCheckoutEndpoint: "/api/create-checkout-session",
  // Cloudflare Worker routes for exact-amount PayPal checkout.
  paypalOrderEndpoint: "/api/create-paypal-order",
  paypalCaptureEndpoint: "/api/capture-paypal-order",
  // Fallback Stripe Payment Link if the Worker is not deployed yet.
  stripePaymentLink: "https://buy.stripe.com/4gM3cxgyCeKXeUlf7O9ws00",
  // PayPal: paste a PayPal Donate, hosted button, or PayPal.me URL here.
  paypalDonationLink: "https://www.paypal.com/ncp/payment/UBFXJW835XCM8"
};

const messages = {
  5: "Gratitude level: polite nod in the quarterly update.",
  25: "Gratitude level: boardroom nod.",
  100: "Gratitude level: suspiciously confident handshake.",
  500: "Gratitude level: naming a spreadsheet tab after you."
};

let selectedAmount = 25;
let toastTimer;

function updateGratitude(amount) {
  const numericAmount = Number(amount);

  if (messages[numericAmount]) {
    gratitude.textContent = messages[numericAmount];
    return;
  }

  if (numericAmount >= 1000) {
    gratitude.textContent = "Gratitude level: emergency all-hands celebration.";
  } else if (numericAmount >= 250) {
    gratitude.textContent = "Gratitude level: strategic sparkle in the pitch deck.";
  } else if (numericAmount > 0) {
    gratitude.textContent = "Gratitude level: deeply monetized appreciation.";
  } else {
    gratitude.textContent = "Gratitude level: awaiting disruption.";
  }
}

amountButtons.forEach((button) => {
  button.addEventListener("click", () => {
    amountButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    selectedAmount = Number(button.dataset.amount);
    customAmount.value = "";
    updateGratitude(selectedAmount);
  });
});

customAmount.addEventListener("input", () => {
  amountButtons.forEach((item) => item.classList.remove("active"));
  selectedAmount = Number(customAmount.value);
  updateGratitude(selectedAmount);
});

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

function appendAmount(url, amount) {
  const numericAmount = Number(amount);

  if (!url || !numericAmount || numericAmount < 1) {
    return url;
  }

  const formattedAmount = numericAmount.toFixed(2);
  let paymentUrl;

  try {
    paymentUrl = new URL(url);
  } catch {
    return "";
  }

  if (paymentUrl.hostname.includes("paypal.me")) {
    const cleanPath = paymentUrl.pathname.replace(/\/$/, "");
    paymentUrl.pathname = `${cleanPath}/${formattedAmount}`;
    return paymentUrl.toString();
  }

  if (paymentUrl.hostname.includes("paypal.com")) {
    paymentUrl.searchParams.set("amount", formattedAmount);
    paymentUrl.searchParams.set("currency_code", "USD");
  }

  return paymentUrl.toString();
}

function getPaymentUrl(provider) {
  if (provider === "paypal") {
    return appendAmount(paymentConfig.paypalDonationLink, selectedAmount);
  }

  return "";
}

function getSafeAmount() {
  const amount = Number(selectedAmount);

  if (!Number.isFinite(amount) || amount < 1) {
    return 0;
  }

  return Math.round(amount * 100) / 100;
}

async function openStripeCheckout(button) {
  const amount = getSafeAmount();

  if (!amount) {
    showToast("Choose at least $1 before funding the absence of a product.");
    return;
  }

  button.disabled = true;
  button.textContent = "Opening Stripe...";

  try {
    const response = await fetch(paymentConfig.stripeCheckoutEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ amount })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.url) {
      throw new Error(result.error || "Stripe checkout is not available yet.");
    }

    window.location.href = result.url;
  } catch (error) {
    if (paymentConfig.stripePaymentLink) {
      showToast("Exact Stripe amount needs the Cloudflare Worker. Opening the fallback Stripe link.");
      window.setTimeout(() => {
        window.location.href = paymentConfig.stripePaymentLink;
      }, 900);
      return;
    }

    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Donate with Stripe";
  }
}

async function openPayPalCheckout(button) {
  const amount = getSafeAmount();

  if (!amount) {
    showToast("Choose at least $1 before routing generosity through PayPal.");
    return;
  }

  button.disabled = true;
  button.textContent = "Opening PayPal...";

  try {
    const response = await fetch(paymentConfig.paypalOrderEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ amount })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.url) {
      throw new Error(result.error || "PayPal checkout is not available yet.");
    }

    window.location.href = result.url;
  } catch (error) {
    const fallbackUrl = getPaymentUrl("paypal");

    if (fallbackUrl) {
      showToast("Exact PayPal amount needs the Cloudflare Worker. Opening the fallback PayPal link.");
      window.setTimeout(() => {
        window.location.href = fallbackUrl;
      }, 900);
      return;
    }

    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Donate with PayPal";
  }
}

async function captureApprovedPayPalOrder() {
  const params = new URLSearchParams(window.location.search);
  const orderID = params.get("token");

  if (params.get("paypal") !== "approved" || !orderID) {
    return;
  }

  showToast("Finalizing PayPal donation. Please admire the efficiency.");

  try {
    const response = await fetch(paymentConfig.paypalCaptureEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ orderID })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || "PayPal capture failed.");
    }

    showToast("PayPal donation accepted. The business model survives another day.");
  } catch (error) {
    showToast(error.message);
  } finally {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

donateButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const provider = button.dataset.provider;

    if (provider === "stripe") {
      await openStripeCheckout(button);
      return;
    }

    if (provider === "paypal") {
      await openPayPalCheckout(button);
      return;
    }

    const url = getPaymentUrl(provider);

    if (!url) {
      showToast("Add your PayPal donation URL in script.js to accept this donation live.");
      return;
    }

    window.location.href = url;
  });
});

captureApprovedPayPalOrder();

toast.addEventListener("click", () => {
  const amount = selectedAmount > 0 ? `$${selectedAmount}` : "money";
  showToast(`Still an excellent decision. ${amount} remains emotionally available.`);
});

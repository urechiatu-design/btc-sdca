// Shared Stripe client (secret key), for server-side API routes only.
const Stripe = require("stripe");

let client = null;

function getStripe() {
  if (client) return client;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("Server misconfigured: STRIPE_SECRET_KEY is not set.");
  client = new Stripe(secretKey, { apiVersion: "2024-06-20" });
  return client;
}

// Maps our platform-agnostic price_tier label (stored in profiles.price_tier)
// to the actual Stripe Price ID. The dollar amounts themselves live in the
// Stripe dashboard, never hardcoded here -- change STRIPE_PRICE_STANDARD in
// Vercel's env vars any time without touching this file.
const PRICE_IDS = {
  founder: process.env.STRIPE_PRICE_FOUNDER,
  standard: process.env.STRIPE_PRICE_STANDARD,
};

module.exports = { getStripe, PRICE_IDS };

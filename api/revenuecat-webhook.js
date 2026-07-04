// RevenueCat webhook -- the mobile-side counterpart to api/stripe-webhook.js.
// Same role (sync of record for subscription_status), same target table,
// different transport: RevenueCat signs requests with a simple shared
// secret in the Authorization header rather than raw-body HMAC, so unlike
// stripe-webhook.js there's no need to disable Vercel's body parser here.
//
// The Capacitor app configures RevenueCat with appUserID == the Supabase
// user's own id (see index.html, refreshGate()), so event.app_user_id
// IS the profiles.id directly -- no separate id-mapping table needed,
// mirroring how stripe-webhook.js resolves users via
// subscription.metadata.supabase_user_id.
const { getSupabaseAdmin } = require("./_supabaseAdmin");

// Maps RevenueCat's event vocabulary to the same small, generic enum
// api/stripe-webhook.js writes (see supabase/schema.sql) -- this is what
// lets index.html's isEntitled() stay provider-agnostic.
function mapRevenueCatStatus(eventType, periodType) {
  switch (eventType) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
      return periodType === "TRIAL" || periodType === "INTRO" ? "trialing" : "active";
    case "BILLING_ISSUE":
      return "past_due";
    case "CANCELLATION":
    case "EXPIRATION":
      return "canceled";
    default:
      return "incomplete";
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const webhookSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("revenuecat-webhook error: REVENUECAT_WEBHOOK_SECRET is not set.");
    return res.status(500).json({ success: false, error: "Server misconfigured." });
  }

  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${webhookSecret}`) {
    console.error("revenuecat-webhook: invalid or missing Authorization header.");
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  try {
    const event = req.body && req.body.event;
    if (!event || !event.app_user_id) {
      // Not a shape we recognize -- ack anyway so RevenueCat doesn't retry
      // forever over something we'll never be able to process.
      return res.status(200).json({ received: true });
    }

    const supabaseAdmin = getSupabaseAdmin();
    await supabaseAdmin
      .from("profiles")
      .update({
        subscription_status: mapRevenueCatStatus(event.type, event.period_type),
        current_period_end: event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null,
        revenuecat_app_user_id: event.app_user_id,
        billing_provider: "revenuecat",
      })
      .eq("id", event.app_user_id);

    // Respond fast: RevenueCat retries on slow/non-2xx responses, and the
    // write above is a straightforward idempotent field update (safe to
    // apply twice if the same event is redelivered).
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("revenuecat-webhook handler error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
};

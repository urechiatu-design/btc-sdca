// Stripe webhook -- the sync of record for subscription_status in Postgres.
// Signature verification needs the RAW request body, so Vercel's default
// JSON body-parsing is disabled below (module.exports.config) and the raw
// bytes are read manually before handing them to stripe.webhooks.constructEvent.
const { getSupabaseAdmin } = require("./_supabaseAdmin");
const { getStripe } = require("./_stripe");

module.exports.config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Maps Stripe's subscription status vocabulary to our smaller, generic
// enum (kept generic so a future non-Stripe/mobile path could write the
// same values -- see supabase/schema.sql).
function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
      return "canceled";
    default:
      return "incomplete";
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("stripe-webhook error: STRIPE_WEBHOOK_SECRET is not set.");
    return res.status(500).json({ success: false, error: "Server misconfigured." });
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const stripe = getStripe();
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("stripe-webhook signature verification failed:", err);
    return res.status(400).json({ success: false, error: "Invalid signature." });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (userId && session.subscription) {
        const stripe = getStripe();
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await supabaseAdmin
          .from("profiles")
          .update({
            stripe_subscription_id: subscription.id,
            subscription_status: mapStripeStatus(subscription.status),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          })
          .eq("id", userId);
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const userId = subscription.metadata && subscription.metadata.supabase_user_id;
      const updates = {
        subscription_status: mapStripeStatus(subscription.status),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      };
      if (userId) {
        await supabaseAdmin.from("profiles").update(updates).eq("id", userId);
      } else {
        await supabaseAdmin.from("profiles").update(updates).eq("stripe_customer_id", subscription.customer);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const userId = subscription.metadata && subscription.metadata.supabase_user_id;
      const updates = { subscription_status: "canceled" };
      if (userId) {
        await supabaseAdmin.from("profiles").update(updates).eq("id", userId);
      } else {
        await supabaseAdmin.from("profiles").update(updates).eq("stripe_customer_id", subscription.customer);
      }
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      if (invoice.customer) {
        await supabaseAdmin
          .from("profiles")
          .update({ subscription_status: "past_due" })
          .eq("stripe_customer_id", invoice.customer);
      }
    }
    // Other event types are intentionally ignored -- add more `else if`
    // branches here if you add corresponding events to the Stripe webhook
    // endpoint's subscribed-events list in the Stripe dashboard.

    // Respond fast: Stripe retries on slow responses or non-2xx, and any
    // side effect above is a straightforward idempotent field write (safe
    // to apply twice if Stripe redelivers the same event).
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("stripe-webhook handler error:", err);
    // Still 500 here (not 200) so Stripe retries -- this is a genuine
    // processing failure, unlike a bad signature above which should not
    // be retried.
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
};

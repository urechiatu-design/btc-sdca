// Called from the paywall/start-trial screen's button. The price tier
// (and trial length, if any) are always derived from the caller's own
// profiles row server-side -- never from a client-supplied value -- so a
// user cannot request the founder price or a trial for themselves by
// tampering with a request body.
//
// Trial handling is Stripe-native: subscription_data.trial_period_days is
// a stable, GA Checkout parameter (no preview API version or account
// billing-mode migration needed) that starts the trial clock at the same
// moment the card is collected, and Stripe auto-bills automatically once
// it elapses -- see api/stripe-webhook.js for how that sync flows back
// into profiles.subscription_status.
const { getVerifiedUser } = require("./_auth");
const { getSupabaseAdmin } = require("./_supabaseAdmin");
const { getStripe, PRICE_IDS } = require("./_stripe");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: "Not authenticated." });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("price_tier, stripe_customer_id, stripe_subscription_id, referral_code_used")
      .eq("id", user.id)
      .single();
    if (profileError) throw profileError;

    const tier = profile?.price_tier || "standard";
    const priceId = PRICE_IDS[tier];
    if (!priceId) {
      throw new Error(`Server misconfigured: no Stripe price configured for tier "${tier}".`);
    }

    // Trial only applies to a user's FIRST-ever subscription -- someone
    // who already had one (and canceled, or fell past_due) doesn't get a
    // second free trial just by resubscribing.
    let trialDays = 0;
    if (!profile?.stripe_subscription_id) {
      if (profile?.referral_code_used) {
        const { data: codeRow } = await supabaseAdmin
          .from("referral_codes")
          .select("trial_days")
          .eq("code", profile.referral_code_used)
          .single();
        trialDays = Number(codeRow?.trial_days) || 0;
      } else {
        const { data: configRow } = await supabaseAdmin
          .from("app_config")
          .select("value")
          .eq("key", "standard_trial_days")
          .single();
        trialDays = Number(configRow?.value) || 0;
      }
    }

    const stripe = getStripe();
    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      const { error: updateError } = await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id);
      if (updateError) throw updateError;
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
      client_reference_id: user.id,
      subscription_data: {
        metadata: { supabase_user_id: user.id },
        ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
      },
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
};

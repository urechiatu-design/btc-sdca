// Called from the paywall screen's "Subscribe" button. The price tier is
// always derived from the caller's own profiles row (never from a
// client-supplied value), so a user cannot request the founder price for
// themselves by tampering with a request body.
const { getVerifiedUser } = require("./_auth");
const { getSupabaseAdmin } = require("./_supabaseAdmin");
const { getStripe, PRICE_IDS } = require("./_stripe");

module.exports = async function handler(req, res) {
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
      .select("price_tier, stripe_customer_id")
      .eq("id", user.id)
      .single();
    if (profileError) throw profileError;

    const tier = profile?.price_tier || "standard";
    const priceId = PRICE_IDS[tier];
    if (!priceId) {
      throw new Error(`Server misconfigured: no Stripe price configured for tier "${tier}".`);
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
      },
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
};

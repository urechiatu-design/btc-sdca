// Called from the account chip's "Manage billing" link (self-service
// cancel / update payment method) for users who already have a Stripe
// customer record.
const { getVerifiedUser } = require("./_auth");
const { getSupabaseAdmin } = require("./_supabaseAdmin");
const { getStripe } = require("./_stripe");

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
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();
    if (profileError) throw profileError;

    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ success: false, error: "No billing account yet -- subscribe first." });
    }

    const stripe = getStripe();
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${origin}/`,
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error("create-portal-session error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
};

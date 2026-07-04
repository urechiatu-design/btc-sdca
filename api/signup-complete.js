// Called by the client immediately after a successful client-side
// supabase.auth.signUp(). Finishes account setup server-side: redeems a
// referral code if one was submitted (via the atomic redeem_referral_code
// RPC, defined in supabase/schema.sql), or otherwise places the user on
// the standard tier per the app_config.standard_trial_days knob.
//
// The acting user is always derived from the caller's verified access
// token (api/_auth.js) -- never from a client-supplied user id -- so a
// signed-in user can only ever complete their own signup.
const { getVerifiedUser } = require("./_auth");
const { getSupabaseAdmin } = require("./_supabaseAdmin");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: "Not authenticated." });
    }

    const referralCode = (req.body && typeof req.body.referralCode === "string")
      ? req.body.referralCode.trim()
      : "";

    const supabaseAdmin = getSupabaseAdmin();

    if (referralCode) {
      const { data, error } = await supabaseAdmin.rpc("redeem_referral_code", {
        p_user_id: user.id,
        p_code: referralCode,
      });
      if (error) throw error;
      if (data && data.success) {
        return res.status(200).json({
          success: true,
          isFounder: true,
          trialEndsAt: data.trial_ends_at,
        });
      }
      // Code invalid/exhausted -- fall through to the standard path below
      // rather than failing the whole signup over a promo code.
    }

    const { data: configRow, error: configError } = await supabaseAdmin
      .from("app_config")
      .select("value")
      .eq("key", "standard_trial_days")
      .single();
    if (configError) throw configError;

    const standardTrialDays = Number(configRow?.value) || 0;
    const trialEndsAt = standardTrialDays > 0
      ? new Date(Date.now() + standardTrialDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .update({
        price_tier: "standard",
        subscription_status: standardTrialDays > 0 ? "trialing" : "incomplete",
        trial_ends_at: trialEndsAt,
      })
      .eq("id", user.id);
    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      isFounder: false,
      trialEndsAt,
    });
  } catch (err) {
    console.error("signup-complete error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
};

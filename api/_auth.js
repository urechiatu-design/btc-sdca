// Shared helper: verifies the caller's Supabase access token from the
// Authorization header and returns their user id + email. Always derive
// the acting user this way -- never trust a client-supplied user id in a
// request body, or any authenticated user could act on another user's
// profile/subscription.
const { getSupabaseAdmin } = require("./_supabaseAdmin");

async function getVerifiedUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return { id: data.user.id, email: data.user.email };
}

module.exports = { getVerifiedUser };

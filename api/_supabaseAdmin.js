// Shared Supabase admin client (service-role key), for server-side API
// routes only. NEVER import this from client-side code and never expose
// SUPABASE_SERVICE_ROLE_KEY to the browser -- it bypasses Row Level
// Security entirely, by design, so every write it makes must be trusted
// application logic, not a client-controlled value.
const { createClient } = require("@supabase/supabase-js");

let client = null;

function getSupabaseAdmin() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.");
  }
  client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  return client;
}

module.exports = { getSupabaseAdmin };

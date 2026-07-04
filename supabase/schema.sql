-- BTC SDCA: accounts, referral/founder program, and subscription state.
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query)
-- on a fresh Supabase project. Safe to re-run individual sections if you
-- need to tweak something, but it is NOT idempotent as a whole (it will
-- error on a second full run because the tables already exist).

-- ============================================================
-- 1. referral_codes (created first: profiles references it)
-- ============================================================
create table public.referral_codes (
  code text primary key,
  max_redemptions int not null,
  redemptions_count int not null default 0,
  trial_days int not null,
  grants_price_tier text not null check (grants_price_tier in ('founder','standard')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. profiles (1:1 with auth.users)
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  referral_code_used text references public.referral_codes(code),
  is_founder boolean not null default false,
  -- 'incomplete' = row just created by the auth trigger, not yet processed
  -- by api/signup-complete.js; that request flips it to 'trialing' (founder
  -- or standard-with-trial) almost immediately, so this state is transient.
  subscription_status text not null default 'incomplete'
    check (subscription_status in ('incomplete','trialing','active','past_due','canceled')),
  -- Label, not a Stripe Price ID -- the founder/standard -> actual Stripe
  -- Price ID mapping lives in Vercel env vars (STRIPE_PRICE_FOUNDER /
  -- STRIPE_PRICE_STANDARD), never in this table. Keeps this schema
  -- platform-agnostic for a future non-Stripe (mobile/RevenueCat) path.
  price_tier text check (price_tier in ('founder','standard')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  stripe_customer_id text unique,
  stripe_subscription_id text unique
);

-- ============================================================
-- 3. referral_redemptions (audit log; not load-bearing for the cap --
--    the atomic counter on referral_codes is -- but gives a durable,
--    queryable record of this one-shot 100-person promotion)
-- ============================================================
create table public.referral_redemptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  code text not null references public.referral_codes(code),
  redeemed_at timestamptz not null default now(),
  redemption_number int not null
);

-- ============================================================
-- 4. app_config (tiny key/value config table; currently one key)
-- ============================================================
create table public.app_config (
  key text primary key,
  value jsonb not null
);

-- ============================================================
-- 5. Auto-create a profiles row whenever a new auth.users row appears,
--    and keep profiles.updated_at current on every update.
-- ============================================================
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 6. Row Level Security
-- ============================================================
alter table public.profiles enable row level security;
alter table public.referral_codes enable row level security;
alter table public.referral_redemptions enable row level security;
alter table public.app_config enable row level security;

-- Users can read only their own profile row. This is what the client's
-- initAppGate() reads to decide which screen to show. There is
-- deliberately NO client-facing update policy on profiles: every write to
-- subscription/trial/Stripe fields happens exclusively through server-side
-- functions using the service-role key (which bypasses RLS by design).
-- If you ever add an "update policy" here for convenience, make sure it
-- excludes subscription_status/price_tier/trial_ends_at/is_founder/
-- stripe_customer_id/stripe_subscription_id, or a user could grant
-- themselves an active subscription via a direct REST PATCH call.
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- No policies at all on referral_codes / referral_redemptions / app_config:
-- with RLS enabled and zero policies, all client access (anon +
-- authenticated roles) is denied by default. They're only ever touched by
-- the redeem_referral_code() RPC (security definer, below) or directly by
-- server-side functions using the service-role key, which bypasses RLS.

-- ============================================================
-- 7. Atomic referral code redemption
-- ============================================================
-- Called via supabase.rpc('redeem_referral_code', {p_user_id, p_code})
-- from a SERVER-SIDE function only (api/signup-complete.js), using the
-- service-role client. Never call this from browser code.
create function public.redeem_referral_code(
  p_user_id uuid,
  p_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row referral_codes%rowtype;
  v_redemption_number int;
begin
  -- Atomic claim: this single UPDATE...WHERE is where the race-safety
  -- comes from. Two concurrent callers serialize on Postgres's row-level
  -- lock for this row -- the second one to run re-evaluates
  -- "redemptions_count < max_redemptions" against the ALREADY-INCREMENTED
  -- value, so it is impossible for two callers to both "win" the same slot.
  update referral_codes
     set redemptions_count = redemptions_count + 1
   where code = upper(p_code)
     and active = true
     and redemptions_count < max_redemptions
  returning * into v_row;

  if not found then
    return jsonb_build_object('success', false, 'error', 'code_invalid_or_exhausted');
  end if;

  v_redemption_number := v_row.redemptions_count;

  insert into referral_redemptions (user_id, code, redemption_number)
  values (p_user_id, v_row.code, v_redemption_number);

  -- subscription_status stays 'incomplete' here -- the trial itself is
  -- Stripe-native (subscription_data.trial_period_days, applied in
  -- api/create-checkout-session.js) and only actually starts once the
  -- user completes Checkout and Stripe's webhook confirms it, so it
  -- would be wrong to mark them 'trialing' before that's happened.
  update profiles
     set referral_code_used = v_row.code,
         is_founder = true,
         price_tier = v_row.grants_price_tier
   where id = p_user_id;

  return jsonb_build_object(
    'success', true,
    'redemption_number', v_redemption_number
  );
end;
$$;

-- Defense in depth: even though RLS + no policies already blocks anon/
-- authenticated roles from touching referral_codes/profiles directly,
-- explicitly revoke execute on this function from those roles too, so it
-- can only ever be invoked with the service-role key.
revoke execute on function public.redeem_referral_code(uuid, text) from public, anon, authenticated;

-- ============================================================
-- 8. Seed data
-- ============================================================
insert into public.referral_codes (code, max_redemptions, redemptions_count, trial_days, grants_price_tier, active)
values ('FOUNDER100', 100, 0, 90, 'founder', true);

-- Config knob read by api/signup-complete.js for anyone who signs up
-- WITHOUT a live founder code: how many trial days (if any) they get.
-- Set to 0 = no trial, straight to Checkout after signup. Change this
-- value any time directly in the table -- no code deploy needed.
insert into public.app_config (key, value)
values ('standard_trial_days', '0');

-- ============================================================
-- 9. Mobile billing (RevenueCat) -- run this section once when adding
--    the iOS/Android apps. Mirrors stripe_customer_id/stripe_subscription_id
--    below: a nullable per-provider identifier, never a foreign key to
--    anything Stripe-specific, so a profile can be billed by either
--    provider (or, transiently, migrate between them) without a schema
--    change. api/revenuecat-webhook.js writes to these exactly like
--    api/stripe-webhook.js writes to the Stripe columns -- both funnel
--    into the same subscription_status enum, which is what makes
--    entitlement checks (isEntitled() in index.html) provider-agnostic.
-- ============================================================
alter table public.profiles add column if not exists revenuecat_app_user_id text unique;
alter table public.profiles add column if not exists billing_provider text
  check (billing_provider in ('stripe', 'revenuecat'));

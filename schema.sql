-- ======================================================================
-- Core game rules / configs
-- ======================================================================

create table if not exists game_rules (
  id serial primary key,
  rtp_bps int not null default 9900,
  house_edge_bps int not null default 100,
  min_bet_lamports bigint not null default 50000,
  max_bet_lamports bigint not null default 5000000000,
  updated_at timestamptz not null default now()
);

insert into game_rules (rtp_bps, house_edge_bps)
select 9900, 100
where not exists (select 1 from game_rules);

create table if not exists game_configs (
  game_key text primary key,
  enabled boolean not null default true,
  running boolean not null default true,
  fee_bps int not null default 0,
  rtp_bps int not null default 9900,
  min_bet_lamports bigint not null default 50000,
  max_bet_lamports bigint not null default 5000000000,
  updated_at timestamptz not null default now()
);

insert into game_configs (game_key, fee_bps, rtp_bps)
values
 ('coinflip', 600, 9900),
 ('slots',    500, 8500),
 ('plinko',   500, 9400),
 ('crash',    500, 9900),
 ('mines',    500, 9800),
 ('dice',     500, 9900)
on conflict (game_key) do nothing;

-- ======================================================================
-- Game data
-- ======================================================================

create table if not exists slots_spins (
  id bigserial primary key,
  player text not null,
  bet_amount numeric not null,
  client_seed text not null default '',
  server_seed_hash text not null,
  server_seed text,
  nonce bigint not null unique,
  grid_json jsonb,
  payout numeric not null default 0,
  status text not null default 'prepared',
  fee_pct numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_slots_spins_player on slots_spins (player);
create index if not exists idx_slots_spins_created_at on slots_spins (created_at);

create table if not exists bets (
  id bigserial primary key,
  player text not null,
  bet_amount_lamports bigint not null,
  bet_type smallint not null,
  target int not null,
  roll int not null default 0,
  payout_lamports bigint not null default 0,
  nonce bigint not null unique,
  expiry_unix bigint not null,
  signature_base58 text not null default '',
  status text not null default 'prepared_lock',
  tx_sig text,
  created_at timestamptz not null default now()
);
create index if not exists idx_bets_nonce on bets (nonce);
create index if not exists idx_bets_player on bets (player);
create index if not exists idx_bets_created_at on bets (created_at);

create table if not exists game_rounds (
  id bigserial primary key,
  game_key text not null,
  player text not null,
  nonce bigint,
  stake_lamports bigint not null default 0,
  payout_lamports bigint not null default 0,
  result_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_game_rounds_key on game_rounds (game_key);
create index if not exists idx_game_rounds_player on game_rounds (player);
create index if not exists idx_game_rounds_created on game_rounds (created_at);

create table if not exists activities (
  id bigserial primary key,
  user_addr text not null,
  action text not null,
  amount numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_activities_created on activities (created_at);

create table if not exists coinflip_matches (
  id bigserial primary key,
  nonce bigint not null unique,
  player_a text not null,
  player_b text,
  side_a int not null,
  side_b int not null,
  bet_lamports bigint not null,
  outcome int not null,
  winner text not null,
  payout_lamports bigint not null default 0,
  fee_bps int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_coinflip_created on coinflip_matches (created_at);
create index if not exists idx_coinflip_winner on coinflip_matches (winner);

-- ======================================================================
-- Users (admin)
-- ======================================================================

create table if not exists app_users (
  user_id       text primary key,
  username      text not null,
  status        text not null default 'active' check (status in ('active','disabled','banned')),
  pda_balance   numeric not null default 0,
  favorite_game text,
  joined_at     timestamptz not null default now(),
  last_active   timestamptz not null default now()
);
create index if not exists idx_app_users_status on app_users(status);
create index if not exists idx_app_users_last_active on app_users(last_active);

-- ======================================================================
-- PROMOS / AFFILIATES / WELCOME / XP
-- ======================================================================

create table if not exists affiliates (
  code            text primary key,
  owner_wallet    text not null,
  rakeback_bps    int  not null default 100 check (rakeback_bps between 0 and 10000),
  revshare_bps    int  not null default 500 check (revshare_bps between 0 and 10000),
  created_at      timestamptz not null default now(),
  unique(owner_wallet)
);

create table if not exists referrals (
  id bigserial primary key,
  affiliate_code  text not null references affiliates(code) on delete cascade,
  referrer_wallet text not null,
  referred_wallet text not null unique,
  device_id       text,
  bound_at        timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists idx_referrals_affiliate on referrals(affiliate_code);
create index if not exists idx_referrals_referrer on referrals(referrer_wallet);
create index if not exists idx_referrals_created on referrals(created_at);

alter table referrals
  add column if not exists created_at timestamptz not null default now();

create table if not exists affiliate_commissions (
  id bigserial primary key,
  affiliate_code  text not null,
  referrer_wallet text not null,
  referred_wallet text not null,
  game_key        text,
  round_id        bigint,
  ngr_lamports    bigint not null default 0,
  rakeback_lamports bigint not null default 0,
  affiliate_commission_lamports bigint not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_aff_comm_ref on affiliate_commissions(referred_wallet);
create index if not exists idx_aff_comm_code on affiliate_commissions(affiliate_code);
create index if not exists idx_aff_comm_created on affiliate_commissions(created_at);

create table if not exists deposits (
  id bigserial primary key,
  user_wallet     text not null,
  amount_lamports bigint not null,
  tx_sig          text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_deposits_user on deposits(user_wallet);

-- keep as a TABLE (not a view)
create table if not exists welcome_bonus_states (
  id bigserial primary key,
  user_wallet        text not null,
  name               text not null,
  bonus_amount_usd   numeric not null default 0,
  wr_required_units  numeric not null default 0,
  wr_progress_units  numeric not null default 0,
  coefficient        numeric not null default 0.2,
  expires_at         timestamptz,
  max_bet_usd        numeric not null default 5,
  status             text not null default 'active' check (status in ('active','cleared','expired','forfeited')),
  fs_count           int     not null default 0,
  fs_value_usd       numeric not null default 0,
  fs_max_win_usd     numeric not null default 0,
  created_at         timestamptz not null default now(),
  unique(user_wallet, name)
);
create index if not exists idx_welcome_states_wallet on welcome_bonus_states(user_wallet);
create index if not exists idx_welcome_states_status on welcome_bonus_states(status);

alter table welcome_bonus_states
  add column if not exists name text,
  add column if not exists bonus_amount_usd numeric not null default 0,
  add column if not exists wr_required_units numeric not null default 0,
  add column if not exists wr_progress_units numeric not null default 0,
  add column if not exists coefficient numeric not null default 0.2,
  add column if not exists expires_at timestamptz,
  add column if not exists max_bet_usd numeric not null default 5,
  add column if not exists status text not null default 'active',
  add column if not exists fs_count int not null default 0,
  add column if not exists fs_value_usd numeric not null default 0,
  add column if not exists fs_max_win_usd numeric not null default 0,
  add column if not exists created_at timestamptz not null default now();

create table if not exists welcome_bonuses (
  user_wallet            text primary key,
  first_deposit_lamports bigint not null default 0,
  claimed                boolean not null default false,
  claimed_at             timestamptz
);

create table if not exists welcome_wr_events (
  id bigserial primary key,
  user_wallet    text not null,
  game_key       text,
  stake_usd      numeric not null default 0,
  contribution_usd numeric not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_welcome_wr_user on welcome_wr_events(user_wallet, created_at);

create table if not exists promos_claims (
  id bigserial primary key,
  type       text not null check (type in ('daily','weekly')),
  user_wallet text not null,
  date_utc   text not null,
  ip         text,
  device_id  text,
  prize_key  text not null,
  details    jsonb not null default '{}'::jsonb,
  week_key   text,
  created_at timestamptz not null default now()
);
create index if not exists idx_promos_claims_user on promos_claims(user_wallet);
create index if not exists idx_promos_claims_type on promos_claims(type);
create index if not exists idx_promos_claims_date on promos_claims(date_utc);
create index if not exists idx_promos_claims_created on promos_claims(created_at);

do $$
begin
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='uniq_daily_claim') then
    execute 'create unique index uniq_daily_claim on promos_claims(user_wallet, date_utc) where type = ''daily''';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='uniq_weekly_claim') then
    execute 'create unique index uniq_weekly_claim on promos_claims(user_wallet, week_key) where type = ''weekly''';
  end if;
end$$;

create table if not exists daily_chests ( user_wallet text primary key, last_claimed_at timestamptz );
create table if not exists weekly_chests(user_wallet text primary key, last_claimed_at timestamptz);

create table if not exists device_fingerprints (
  device_id   text primary key,
  user_wallet text,
  bound_at    timestamptz not null default now()
);
create index if not exists idx_device_fps_user on device_fingerprints(user_wallet);

create table if not exists affiliate_quick_bonuses (
  id bigserial primary key,
  affiliate_wallet text not null,
  referred_wallet  text not null,
  amount_usd       numeric not null,
  tx_sig           text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_aff_quick_wallet on affiliate_quick_bonuses(affiliate_wallet);
create index if not exists idx_aff_quick_ref on affiliate_quick_bonuses(referred_wallet);

alter table affiliate_quick_bonuses
  add column if not exists affiliate_wallet text,
  add column if not exists referred_wallet  text,
  add column if not exists amount_usd       numeric not null default 0,
  add column if not exists tx_sig           text,
  add column if not exists created_at       timestamptz not null default now();

-- ======================================================================
-- Click tracking (STRICT de-dup without expression indexes)
-- ======================================================================

create table if not exists affiliate_link_clicks (
  id bigserial primary key,
  code text not null,
  affiliate_wallet text not null,
  clicked_wallet text null,
  device_id text null,
  ip inet null,
  user_agent text null,
  referer text null,
  landing_url text null,
  created_at timestamptz not null default now()
);

-- Standard helper indexes
create index if not exists idx_aff_clicks_aff on affiliate_link_clicks(affiliate_wallet);
create index if not exists idx_aff_clicks_code on affiliate_link_clicks(code);
create index if not exists idx_aff_clicks_created on affiliate_link_clicks(created_at);

-- Legacy expression indexes cleanup (if any existed previously)
drop index if exists uniq_click_code_device_day;
drop index if exists uniq_click_code_clicked_wallet_day;
drop index if exists uniq_click_code_ipua_day;

-- Materialized derived columns for unique keys (no functions in indexes)
alter table affiliate_link_clicks
  add column if not exists day_bucket bigint,
  add column if not exists ua64 text,
  add column if not exists ip_text text,
  add column if not exists device_id_nn text;

-- Trigger function to fill derived columns
create or replace function fill_affiliate_clicks_derived()
returns trigger
language plpgsql
as $$
begin
  if new.created_at is null then
    new.created_at := now();
  end if;

  -- Day bucket (UTC day, as integer)
  new.day_bucket := floor(extract(epoch from new.created_at)::numeric / 86400.0)::bigint;

  -- UA capped to 64 chars (plain column)
  new.ua64 := left(coalesce(new.user_agent, ''), 64);

  -- IP as text (plain column)
  new.ip_text := coalesce(new.ip::text, '');

  -- Device id normalized
  new.device_id_nn := coalesce(new.device_id, '');

  return new;
end
$$;

drop trigger if exists trg_fill_affiliate_clicks_derived on affiliate_link_clicks;
create trigger trg_fill_affiliate_clicks_derived
before insert or update on affiliate_link_clicks
for each row
execute function fill_affiliate_clicks_derived();

-- Backfill any existing rows
update affiliate_link_clicks
set
  created_at   = coalesce(created_at, now()),
  day_bucket   = floor(extract(epoch from coalesce(created_at, now()))::numeric / 86400.0)::bigint,
  ua64         = left(coalesce(user_agent, ''), 64),
  ip_text      = coalesce(ip::text, ''),
  device_id_nn = coalesce(device_id, '')
where day_bucket is null
   or ua64 is null
   or ip_text is null
   or device_id_nn is null;

-- Deduplicate BEFORE adding unique indexes
-- 1) (code, device_id_nn, day_bucket)
with d as (
  select id,
         row_number() over (partition by code, device_id_nn, day_bucket order by id) as rn
  from affiliate_link_clicks
)
delete from affiliate_link_clicks a
using d
where a.id = d.id and d.rn > 1;

-- 2) (code, clicked_wallet, day_bucket) where clicked_wallet is not null
with d as (
  select id,
         row_number() over (partition by code, clicked_wallet, day_bucket order by id) as rn
  from affiliate_link_clicks
  where clicked_wallet is not null
)
delete from affiliate_link_clicks a
using d
where a.id = d.id and d.rn > 1;

-- 3) (code, ip_text, ua64, day_bucket) where ip_text <> ''
with d as (
  select id,
         row_number() over (partition by code, ip_text, ua64, day_bucket order by id) as rn
  from affiliate_link_clicks
  where ip_text <> ''
)
delete from affiliate_link_clicks a
using d
where a.id = d.id and d.rn > 1;

-- Unique indexes on plain columns only (no IMMUTABLE functions needed)
create unique index if not exists uniq_click_code_device_day_cols
  on affiliate_link_clicks (code, device_id_nn, day_bucket);

create unique index if not exists uniq_click_code_clicked_wallet_day_cols
  on affiliate_link_clicks (code, clicked_wallet, day_bucket)
  where clicked_wallet is not null;

create unique index if not exists uniq_click_code_ipua_day_cols
  on affiliate_link_clicks (code, ip_text, ua64, day_bucket)
  where ip_text <> '';

-- ======================================================================
-- XP / Levels / Claims
-- ======================================================================

create table if not exists xp_levels ( lvl int primary key, xp_required bigint not null );
insert into xp_levels(lvl, xp_required)
select x, case when x=1 then 0 else ((x-1)*(x-1)*1000)::bigint end
from generate_series(1, 41) x
on conflict do nothing;

create table if not exists user_xp (
  user_wallet text primary key,
  xp          bigint not null default 0,
  lvl         int not null default 1,
  updated_at  timestamptz not null default now()
);

create table if not exists xp_rewards_claims (
  id bigserial primary key,
  user_wallet text not null,
  lvl         int not null,
  claimed_at  timestamptz not null default now(),
  unique(user_wallet, lvl)
);

-- ======================================================================
-- Views / analytics helpers
-- ======================================================================

create or replace view v_player_ngr_lamports as
with a as (
  select player as wallet, sum(stake_lamports - payout_lamports)::bigint as ngr
  from game_rounds group by player
),
b as (
  select coalesce(player_a,'') as wallet, sum((bet_lamports*2) - payout_lamports)::bigint as ngr
  from coinflip_matches group by player_a
)
select wallet,
       coalesce((select ngr from a where a.wallet = u.wallet), 0) +
       coalesce((select ngr from b where b.wallet = u.wallet), 0) as ngr
from (
  select player as wallet from game_rounds
  union
  select player_a as wallet from coinflip_matches
) u;

-- ================================
-- ADMIN REFERRALS EXTENSION
-- (append after your current schema)
-- ================================

-- Add status to affiliates if missing
alter table affiliates
  add column if not exists status text not null default 'active'
  check (status in ('active','suspended','banned'));

-- Payout settings (singleton)
create table if not exists affiliate_payout_settings (
  id                               int primary key default 1,
  auto_payout_enabled              boolean not null default true,
  auto_payout_threshold_lamports   bigint  not null default 50000000,
  auto_payout_max_amount_lamports  bigint  not null default 5000000000,
  default_network                  text    not null default 'SOL',
  fraud_score_threshold            numeric not null default 0.30,
  manual_review_above_lamports     bigint  not null default 1000000000,
  updated_at                       timestamptz not null default now()
);

-- Payout requests
create table if not exists affiliate_payout_requests (
  id bigserial primary key,
  affiliate_code   text not null references affiliates(code) on delete cascade,
  affiliate_wallet text not null,
  amount_lamports  bigint not null check (amount_lamports > 0),
  network          text not null check (network in ('SOL','USDT','ETH','BTC')),
  status           text not null default 'pending'
                   check (status in ('pending','approved','rejected','completed','processing')),
  is_automatic            boolean not null default false,
  requires_manual_review  boolean not null default false,
  fraud_score             numeric not null default 0,
  tx_hash                 text,
  notes                   text,
  requested_at            timestamptz not null default now(),
  processed_at            timestamptz
);
create index if not exists idx_aff_payouts_code on affiliate_payout_requests(affiliate_code);
create index if not exists idx_aff_payouts_status on affiliate_payout_requests(status);

-- Commission rules (store UI config as JSON)
create table if not exists affiliate_commission_rules (
  id bigserial primary key,
  name text not null,
  game_type text not null default 'all'
           check (game_type in ('all','crash','slots','mines','dice','plinko')),
  is_global boolean not null default true,
  config jsonb not null default '{}',
  start_date timestamptz not null default now(),
  end_date   timestamptz,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Fraud alerts (manual + automated inserts)
create table if not exists affiliate_fraud_alerts (
  id bigserial primary key,
  affiliate_code text not null references affiliates(code) on delete cascade,
  alert_type text not null
            check (alert_type in ('multiple_ips','self_referral','no_wagering','suspicious_pattern')),
  description text not null,
  severity text not null check (severity in ('low','medium','high')),
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_aff_fraud_code on affiliate_fraud_alerts(affiliate_code);

-- Balances view (earnings, available, paid)
create or replace view v_affiliate_balances as
with commissions as (
  select affiliate_code, sum(affiliate_commission_lamports)::bigint as earned
  from affiliate_commissions
  group by affiliate_code
), paid as (
  select affiliate_code,
         sum(case when status in ('approved','processing','completed') then amount_lamports else 0 end)::bigint as locked_or_paid,
         sum(case when status = 'completed' then amount_lamports else 0 end)::bigint as paid
  from affiliate_payout_requests
  group by affiliate_code
)
select a.code as affiliate_code,
       coalesce(c.earned,0)::bigint as lifetime_earned_lamports,
       greatest(coalesce(c.earned,0) - coalesce(p.locked_or_paid,0), 0)::bigint as current_balance_lamports,
       coalesce(p.paid,0)::bigint as lifetime_paid_lamports
from affiliates a
left join commissions c on c.affiliate_code = a.code
left join paid p on p.affiliate_code = a.code;

-- ==============================
-- RANGES & LEVELS (Rewards)
-- ==============================

create table if not exists ranges (
  id         serial primary key,
  name       varchar(100) not null unique,
  quote      text not null,
  image      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists levels (
  id            serial primary key,
  range_id      int not null references ranges(id) on delete cascade,
  level_number  int not null unique,
  title         varchar(100) not null,
  reward        varchar(255),
  wagering      varchar(255),
  bonus         varchar(255),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- touch updated_at
create or replace function trg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_ranges_touch on ranges;
create trigger trg_ranges_touch before update on ranges
for each row execute function trg_touch_updated_at();

drop trigger if exists trg_levels_touch on levels;
create trigger trg_levels_touch before update on levels
for each row execute function trg_touch_updated_at();

-- Seed data (idempotent)
insert into ranges(id, name, quote)
values
 (1,'STREET DEALER','First you hustle. Then you conquer.')
,(2,'CHIP RUNNER','You don’t exist… until something goes missing.')
,(3,'PIT HOUND','The table fears who guards it.')
,(4,'BACKROOM FIXER','Winners don’t get lucky. They get chosen.')
,(5,'CRYPTO SHADOW','Anonymous. Untouchable. Ultra-rich.')
,(6,'HOUSE MANAGER','The house always wins. Because you are the house.')
,(7,'LOUNGE OVERLORD','Power walks in silence... with Cuban heels.')
,(8,'JACKPOT DRAGON','Legends don''t hit the jackpot. They are the jackpot.')
,(9,'ZOGGY’S INNER CIRCLE','One message from you, and the chips fall.')
,(10,'THE UNDERWORLD DON','The casino is your empire. The city, your board.')
,(11,'ZOGGY IMMORTAL','You''re no longer a player. You''re the myth every gambler whispers about.')
on conflict (id) do nothing;

insert into levels(range_id, level_number, title, reward, wagering, bonus)
values
 (1, 1, 'Street Dealer I', '-', '-', NULL),
 (1, 2, 'Street Dealer II', '10 FS x $0.25 = $2.50', '$25', NULL),
 (1, 3, 'Street Dealer III', '20 FS x $0.25 = $5.00', '$50', NULL),
 (1, 4, 'Street Dealer IV', '30 FS x $0.25 = $7.50', '$75', NULL),
 (2, 5, 'Chip Runner I', '40 FS x $0.25 = $10.00', '$100', NULL),
 (2, 6, 'Chip Runner II', '50 FS x $0.25 = $12.50', '$125', NULL),
 (2, 7, 'Chip Runner III', '15 USDT', '$150', NULL),
 (2, 8, 'Chip Runner IV', '20 USDT', '$200', NULL),
 (3, 9, 'Pit Hound I', '25 USDT', '$250', NULL),
 (3,10, 'Pit Hound II', '30 USDT', '$300', NULL),
 (3,11, 'Pit Hound III', '40 USDT', '$400', NULL),
 (3,12, 'Pit Hound IV', '50 USDT', '$500', NULL),
 (4,13, 'Backroom Fixer I', '60 USDT', '$600', NULL),
 (4,14, 'Backroom Fixer II', '70 USDT', '$700', NULL),
 (4,15, 'Backroom Fixer III', '80 USDT', '$800', NULL),
 (4,16, 'Backroom Fixer IV', '100 USDT', '$1000', NULL),
 (5,17, 'Crypto Shadow I', '120 USDT', '$1200', NULL),
 (5,18, 'Crypto Shadow II', '140 USDT', '$1400', NULL),
 (5,19, 'Crypto Shadow III', '160 USDT', '$1600', NULL),
 (5,20, 'Crypto Shadow IV', '180 USDT', '$1800', NULL),
 (6,21, 'House Manager I', '200 USDT', '$2000', NULL),
 (6,22, 'House Manager II', '250 USDT', '$2500', NULL),
 (6,23, 'House Manager III', '300 USDT', '$3000', NULL),
 (6,24, 'House Manager IV', '350 USDT', '$3500', NULL),
 (7,25, 'Lounge Overlord I', '400 USDT', '$4000', NULL),
 (7,26, 'Lounge Overlord II', '500 USDT', '$5000', NULL),
 (7,27, 'Lounge Overlord III', '600 USDT', '$6000', NULL),
 (7,28, 'Lounge Overlord IV', '700 USDT', '$7000', NULL),
 (8,29, 'Jackpot Dragon I', '800 USDT', '$8000', NULL),
 (8,30, 'Jackpot Dragon II', '1000 USDT', '$10000', NULL),
 (8,31, 'Jackpot Dragon III', '1200 USDT', '$12000', NULL),
 (8,32, 'Jackpot Dragon IV', '1400 USDT', '$14000', NULL),
 (9,33, 'Inner Circle I', '1600 USDT', '$16000', NULL),
 (9,34, 'Inner Circle II', '1800 USDT', '$18000', NULL),
 (9,35, 'Inner Circle III', '2000 USDT', '$20000', NULL),
 (9,36, 'Inner Circle IV', '2500 USDT', '$25000', NULL),
 (10,37, 'Underworld Don I', '3000 USDT', '$30000', NULL),
 (10,38, 'Underworld Don II', '3500 USDT', '$35000', NULL),
 (10,39, 'Underworld Don III', '5000 USDT', '$50000', NULL),
 (10,40, 'Underworld Don IV', '10000 USDT', '$100000', NULL),
 (11,41, 'Zoggy Immortal', '20000 USDT', '$20000x1', 'Animated badge + Exclusive skin')
on conflict (level_number) do nothing;

-- Claims
create table if not exists reward_claims (
  id bigserial primary key,
  user_id   text not null,
  level_id  int  not null references levels(id) on delete cascade,
  amount    numeric not null default 0,
  transaction_id text,
  claimed_at timestamptz not null default now(),
  unique(user_id, level_id)
);
create index if not exists idx_reward_claims_user on reward_claims(user_id);
create index if not exists idx_reward_claims_level on reward_claims(level_id);



-- ===========================
-- Wallet ledger (optional)
-- ===========================
create table if not exists wallet_events (
  id               bigserial primary key,
  user_wallet      text not null,
  kind             text not null check (kind in ('deposit','withdrawal')),
  amount_sol       numeric not null check (amount_sol > 0),
  pda_balance_sol  numeric not null,
  tx_sig           text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_wallet_events_user on wallet_events (user_wallet, created_at desc);

-- Idempotency for replays: unique by (tx,kind,user,amount) when a tx_sig exists
create unique index if not exists uniq_wallet_events_sig_kind_user_amt
  on wallet_events (tx_sig, kind, user_wallet, amount_sol)
  where tx_sig is not null;


-- Fix 1: add updated_at used by welcome_bonus_states updates
alter table welcome_bonus_states
  add column if not exists updated_at timestamptz not null default now();

-- Fix 2: add aux_json payload column for WR events
alter table welcome_wr_events
  add column if not exists aux_json jsonb;


ALTER TABLE welcome_bonuses
  ADD COLUMN IF NOT EXISTS first_deposit_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS first_deposit_lamports BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;



-- promotions_table.sql
CREATE TABLE IF NOT EXISTS promotions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  type TEXT NOT NULL,          -- e.g. welcome, reload, free_spins, vip, rakeback, etc.
  status TEXT NOT NULL,        -- active, inactive, scheduled, draft
  trigger TEXT,                -- signup, deposit, wager, code, loss, etc.
  reward_type TEXT,            -- bonus, cashback, free_spins, other
  reward_value NUMERIC DEFAULT 0, -- numeric value (percent or USD or spins count depending on reward_unit)
  reward_unit TEXT DEFAULT 'USD', -- "percentage" | "USD" | "spins"
  max_reward NUMERIC DEFAULT 0,
  min_deposit NUMERIC DEFAULT 0,
  wagering NUMERIC DEFAULT 0,  -- wagering or WR units
  valid_from TIMESTAMP WITH TIME ZONE,
  valid_to TIMESTAMP WITH TIME ZONE,
  usage_count INTEGER DEFAULT 0,
  usage_limit INTEGER,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- optional index for faster search by name/code
CREATE INDEX IF NOT EXISTS promotions_name_idx ON promotions (lower(name));
CREATE INDEX IF NOT EXISTS promotions_code_idx ON promotions (lower(code));

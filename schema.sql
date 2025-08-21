-- -- Game rules table
-- create table if not exists game_rules (
--   id serial primary key,
--   rtp_bps int not null default 9900,       -- 99.00% RTP
--   house_edge_bps int not null default 100, -- 1.00% edge
--   min_bet_lamports bigint not null default 50000,
--   max_bet_lamports bigint not null default 5000000000,
--   updated_at timestamptz not null default now()
-- );

-- -- insert default rules if not exists
-- insert into game_rules (rtp_bps, house_edge_bps)
-- select 9900, 100
-- where not exists (select 1 from game_rules);

-- -- Slots spins storage (used by slots_ws)
-- create table if not exists slots_spins (
--   id bigserial primary key,
--   player text not null,
--   bet_amount numeric not null,
--   client_seed text not null default '',
--   server_seed_hash text not null,
--   server_seed text,
--   nonce bigint not null unique,
--   grid_json jsonb,
--   payout numeric not null default 0,
--   status text not null default 'prepared',
--   created_at timestamptz not null default now()
-- );

-- -- Bets table (for other games)
-- create table if not exists bets (
--   id bigserial primary key,
--   player text not null,
--   bet_amount_lamports bigint not null,
--   bet_type smallint not null,  -- 0 under, 1 over
--   target int not null,
--   roll int not null,
--   payout_lamports bigint not null,
--   nonce bigint not null unique,
--   expiry_unix bigint not null,
--   signature_base58 text not null,
--   status text not null default 'prepared',
--   tx_sig text,
--   created_at timestamptz not null default now()
-- );
-- ===========================
-- Game configuration & rules
-- ===========================
create table if not exists game_rules (
  id serial primary key,
  rtp_bps int not null default 9900,        -- 99.00% RTP
  house_edge_bps int not null default 100,  -- 1.00% edge
  min_bet_lamports bigint not null default 50000,
  max_bet_lamports bigint not null default 5000000000,
  updated_at timestamptz not null default now()
);

-- Ensure only a single row ever exists (singleton rules row)
create unique index if not exists ux_game_rules_singleton on game_rules ((true));

-- Insert defaults once
insert into game_rules (rtp_bps, house_edge_bps)
values (9900, 100)
on conflict do nothing;

-- ===========================
-- Slots spins storage (used by slots_ws)
-- ===========================
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
  created_at timestamptz not null default now()
);

-- Add any columns expected by code but missing in older schemas
alter table slots_spins
  add column if not exists fee_pct numeric not null default 0;

-- Helpful indexes
create index if not exists idx_slots_spins_player on slots_spins (player);
create index if not exists idx_slots_spins_created_at on slots_spins (created_at);

-- ===========================
-- Generic bets table (dice / others)
-- ===========================
create table if not exists bets (
  id bigserial primary key,
  player text not null,
  bet_amount_lamports bigint not null,
  bet_type smallint not null,                -- 0 = under, 1 = over (for dice)
  target int not null,                       -- dice: 2..98 (validated in app)
  roll int not null default 0,
  payout_lamports bigint not null default 0,
  nonce bigint not null unique,
  expiry_unix bigint not null,
  signature_base58 text not null default '',
  status text not null default 'prepared_lock', -- aligns with server defaults/updates
  tx_sig text,
  created_at timestamptz not null default now()
);

-- Helpful indexes for lookups & dashboards
create index if not exists idx_bets_nonce on bets (nonce);
create index if not exists idx_bets_player on bets (player);
create index if not exists idx_bets_created_at on bets (created_at);

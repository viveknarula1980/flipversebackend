-- Game rules table
create table if not exists game_rules (
  id serial primary key,
  rtp_bps int not null default 9900,       -- 99.00% RTP
  house_edge_bps int not null default 100, -- 1.00% edge
  min_bet_lamports bigint not null default 50000,
  max_bet_lamports bigint not null default 5000000000,
  updated_at timestamptz not null default now()
);

-- insert default rules if not exists
insert into game_rules (rtp_bps, house_edge_bps)
select 9900, 100
where not exists (select 1 from game_rules);

-- Slots spins storage (used by slots_ws)
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

-- Bets table (for other games)
create table if not exists bets (
  id bigserial primary key,
  player text not null,
  bet_amount_lamports bigint not null,
  bet_type smallint not null,  -- 0 under, 1 over
  target int not null,
  roll int not null,
  payout_lamports bigint not null,
  nonce bigint not null unique,
  expiry_unix bigint not null,
  signature_base58 text not null,
  status text not null default 'prepared',
  tx_sig text,
  created_at timestamptz not null default now()
);

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

insert into game_rules (rtp_bps, house_edge_bps)
select 9900, 100
where not exists (select 1 from game_rules);

-- Admin-editable per-game config
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

-- seed defaults for all games we use
insert into game_configs (game_key, fee_bps, rtp_bps)
values
 ('coinflip', 600, 9900),
 ('slots',    500, 8500),
 ('plinko',   500, 9400),
 ('crash',    500, 9900),
 ('mines',    500, 9800),
 ('dice',     500, 9900)
on conflict (game_key) do nothing;

-- ===========================
-- Slots spins storage
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
  fee_pct numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_slots_spins_player on slots_spins (player);
create index if not exists idx_slots_spins_created_at on slots_spins (created_at);

-- ===========================
-- Generic bets table (dice / others)
-- ===========================
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

-- ===========================
-- Generic game rounds + activity log
-- ===========================
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

-- ===========================
-- Coinflip match detail
-- ===========================
create table if not exists coinflip_matches (
  id bigserial primary key,
  nonce bigint not null unique,
  player_a text not null,
  player_b text,
  side_a int not null,
  side_b int not null,
  bet_lamports bigint not null,
  outcome int not null,             -- 0=heads,1=tails
  winner text not null,
  payout_lamports bigint not null default 0,  -- paid to winner (net of fee)
  fee_bps int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_coinflip_created on coinflip_matches (created_at);
create index if not exists idx_coinflip_winner on coinflip_matches (winner);


-- ===========================
-- Admin-facing user directory
-- ===========================
create table if not exists app_users (
  user_id       text primary key,                                   -- wallet address (also used as "id")
  username      text not null,                                       -- display name
  status        text not null default 'active'                       -- 'active' | 'disabled' | 'banned'
               check (status in ('active','disabled','banned')),
  pda_balance   numeric not null default 0,                          -- optional; fill from integration/cron
  favorite_game text,
  joined_at     timestamptz not null default now(),
  last_active   timestamptz not null default now()
);
create index if not exists idx_app_users_status on app_users(status);
create index if not exists idx_app_users_last_active on app_users(last_active);

-- (Optional) seed a few users if you want immediate data:
-- insert into app_users(user_id, username, status, pda_balance, favorite_game, joined_at, last_active)
-- values
-- ('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU','CryptoGamer1','active', 1250.50,'coinflip','2024-01-15','2024-01-20'),
-- ('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM','SolanaWhale','active', 5420.75,'crash','2024-01-10','2024-01-20'),
-- ('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh','DiceRoller99','disabled', 89.25,'dice','2024-01-18','2024-01-19'),
-- ('5KKsLVU6TcbVDK4BS6K1DGDxnh4Q2UuoTAoWRhwm5tn','PlinkoMaster','banned', 0,'plinko','2024-01-12','2024-01-17')
-- on conflict (user_id) do nothing;

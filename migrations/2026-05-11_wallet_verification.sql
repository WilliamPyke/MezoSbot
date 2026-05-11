-- Wallet ownership verification via a tiny deposit to the user's personal
-- deposit address. The bot records the actual sender wallet from the on-chain
-- transfer and only verified wallets should be used for on-chain quest checks.

CREATE TABLE IF NOT EXISTS wallet_verification_challenges (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  challenge_sats DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | verified | expired
  tx_hash TEXT,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS verified_wallets (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  verification_tx_hash TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_verification_pending
  ON wallet_verification_challenges (discord_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_verified_wallets_discord
  ON verified_wallets (discord_id);

BEGIN;

-- Preserve every address that may already have been shown to a user. New
-- background registrations remain disabled until an authorized interaction
-- explicitly enables the address.
ALTER TABLE deposit_addresses ADD COLUMN IF NOT EXISTS deposits_enabled BOOLEAN;
UPDATE deposit_addresses SET deposits_enabled = TRUE WHERE deposits_enabled IS NULL;
UPDATE deposit_addresses SET last_checked_balance = '0' WHERE last_checked_balance IS NULL;
ALTER TABLE deposit_addresses ALTER COLUMN last_checked_balance SET DEFAULT '0';
ALTER TABLE deposit_addresses ALTER COLUMN last_checked_balance SET NOT NULL;
ALTER TABLE deposit_addresses ALTER COLUMN deposits_enabled SET DEFAULT FALSE;
ALTER TABLE deposit_addresses ALTER COLUMN deposits_enabled SET NOT NULL;
ALTER TABLE deposit_addresses
  ADD COLUMN IF NOT EXISTS native_sweep_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS native_sweep_balance TEXT,
  ADD COLUMN IF NOT EXISTS native_sweep_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deposit_addresses_enabled
  ON deposit_addresses(discord_id) WHERE deposits_enabled = TRUE;

-- The checkpoint compare-and-swap, audit row, and user balance change commit as
-- one transaction. A failed/ambiguous database call can therefore be retried
-- without either losing or duplicating the credit.
CREATE OR REPLACE FUNCTION credit_native_deposit(
  p_discord_id TEXT,
  p_expected_balance TEXT,
  p_observed_balance TEXT,
  p_amount_sats DOUBLE PRECISION,
  p_tx_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_amount_sats <= 0 OR p_expected_balance !~ '^[0-9]+$'
     OR p_observed_balance !~ '^[0-9]+$'
     OR p_observed_balance::NUMERIC <= p_expected_balance::NUMERIC THEN
    RETURN FALSE;
  END IF;

  INSERT INTO users(discord_id) VALUES(p_discord_id)
    ON CONFLICT(discord_id) DO NOTHING;

  UPDATE deposit_addresses
    SET last_checked_balance = p_observed_balance
    WHERE discord_id = p_discord_id
      AND deposits_enabled = TRUE
      AND last_checked_balance = p_expected_balance;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN FALSE; END IF;

  INSERT INTO deposits(discord_id, tx_hash, amount_sats, block_number, token)
    VALUES(p_discord_id, p_tx_hash, p_amount_sats, 0, 'SATS');
  UPDATE users
    SET balance_sats = balance_sats + p_amount_sats, updated_at = now()
    WHERE discord_id = p_discord_id;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION begin_native_deposit_sweep(
  p_discord_id TEXT,
  p_expected_balance TEXT,
  p_tx_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE deposit_addresses
    SET native_sweep_tx_hash = p_tx_hash,
        native_sweep_balance = p_expected_balance,
        native_sweep_started_at = now()
    WHERE discord_id = p_discord_id
      AND last_checked_balance = p_expected_balance
      AND native_sweep_tx_hash IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION finish_native_deposit_sweep(
  p_discord_id TEXT,
  p_tx_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE deposit_addresses
    SET last_checked_balance = '0',
        native_sweep_tx_hash = NULL,
        native_sweep_balance = NULL,
        native_sweep_started_at = NULL
    WHERE discord_id = p_discord_id
      AND native_sweep_tx_hash = p_tx_hash;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cancel_native_deposit_sweep(
  p_discord_id TEXT,
  p_tx_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE deposit_addresses
    SET native_sweep_tx_hash = NULL,
        native_sweep_balance = NULL,
        native_sweep_started_at = NULL
    WHERE discord_id = p_discord_id
      AND native_sweep_tx_hash = p_tx_hash;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;

-- Wallet-verification deposits intentionally receive no user balance credit,
-- but their checkpoint still needs the same retry-safe compare-and-swap.
CREATE OR REPLACE FUNCTION advance_native_deposit_checkpoint(
  p_discord_id TEXT,
  p_expected_balance TEXT,
  p_observed_balance TEXT
) RETURNS BOOLEAN AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE deposit_addresses
    SET last_checked_balance = p_observed_balance
    WHERE discord_id = p_discord_id
      AND deposits_enabled = TRUE
      AND last_checked_balance = p_expected_balance;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$ LANGUAGE plpgsql;

-- The dedicated sponsor is also allowed to fund treasury gas for an ERC-20
-- withdrawal. It never funds the token amount itself.
ALTER TABLE protocol_gas_operations
  DROP CONSTRAINT IF EXISTS protocol_gas_operations_operation_type_check;
ALTER TABLE protocol_gas_operations
  ADD CONSTRAINT protocol_gas_operations_operation_type_check
  CHECK (operation_type IN ('erc20_sweep_funding', 'erc20_withdrawal_funding'));

COMMIT;

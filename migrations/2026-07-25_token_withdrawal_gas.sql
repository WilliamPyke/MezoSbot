-- Atomically reserve an ERC-20 withdrawal and its native network fee.
CREATE OR REPLACE FUNCTION reserve_token_withdrawal(
  p_discord_id TEXT,
  p_token TEXT,
  p_token_amount DOUBLE PRECISION,
  p_gas_sats DOUBLE PRECISION
) RETURNS TEXT AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_token NOT IN ('MUSD', 'MEZO', 'MUSDC') OR p_token_amount <= 0 OR p_gas_sats <= 0 THEN
    RAISE EXCEPTION 'invalid token withdrawal reservation';
  END IF;
  UPDATE user_token_balances SET balance = balance - p_token_amount, updated_at = now()
  WHERE discord_id = p_discord_id AND token = p_token AND balance >= p_token_amount;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN 'insufficient_token'; END IF;
  UPDATE users SET balance_sats = balance_sats - p_gas_sats, updated_at = now()
  WHERE discord_id = p_discord_id AND balance_sats >= p_gas_sats;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'insufficient_sats'; END IF;
  RETURN 'ok';
EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN 'insufficient_sats';
END;
$$ LANGUAGE plpgsql;

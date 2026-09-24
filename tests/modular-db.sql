\set ON_ERROR_STOP on

-- Money and state invariants for the modular *_v1 RPCs. Everything runs in one
-- transaction that is rolled back, and every id carries a per-run suffix, so
-- the file is safe to re-run against the same database.
BEGIN;

CREATE FUNCTION pg_temp.check(p_ok BOOLEAN, p_message TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'modular-db check failed: %', p_message; END IF;
END;
$$;

CREATE FUNCTION pg_temp.bal(p_id TEXT) RETURNS DOUBLE PRECISION LANGUAGE sql AS $$
  SELECT balance_sats FROM users WHERE discord_id = p_id;
$$;

CREATE FUNCTION pg_temp.code(p_result JSONB) RETURNS TEXT LANGUAGE sql AS $$
  SELECT COALESCE(p_result->>'code', CASE WHEN (p_result->>'ok')::BOOLEAN THEN 'ok' ELSE 'error' END);
$$;

-- Seats both players, readies them and plays one validated draft move each.
CREATE FUNCTION pg_temp.start_match(p_match BIGINT, p_a TEXT, p_b TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.check(pg_temp.code(mark_arcade_ready_v1(p_match, p_a)) = 'ok', 'ready a');
  PERFORM pg_temp.check(pg_temp.code(mark_arcade_ready_v1(p_match, p_b)) = 'ok', 'ready b');
END;
$$;

DO $$
DECLARE
  s TEXT := substr(md5(gen_random_uuid()::text), 1, 10);
  a TEXT := 'dbt-a-' || s;
  b TEXT := 'dbt-b-' || s;
  c TEXT := 'dbt-c-' || s;
  poor TEXT := 'dbt-poor-' || s;
  v_match BIGINT;
  v_other BIGINT;
  v_result JSONB;
  v_pool DOUBLE PRECISION;
  v_version BIGINT;
BEGIN
  INSERT INTO users(discord_id, balance_sats) VALUES (a, 1000), (b, 1000), (c, 1000), (poor, 10);

  -- 1. Staked happy path: create debits the creator atomically and is idempotent.
  v_result := create_arcade_match_v1('staked_pvp', a, NULL, 100, NULL, 180, 'create-1-' || s);
  PERFORM pg_temp.check((v_result->>'ok')::BOOLEAN, 'create staked: ' || v_result::text);
  v_match := (v_result->'match'->>'id')::BIGINT;
  PERFORM pg_temp.check(pg_temp.bal(a) = 900, 'creator debited once on create');
  PERFORM pg_temp.check((create_arcade_match_v1('staked_pvp', a, NULL, 100, NULL, 180, 'create-1-' || s)->'match'->>'id')::BIGINT = v_match, 'create retry returns same match');
  PERFORM pg_temp.check(pg_temp.bal(a) = 900, 'create retry does not debit again');
  PERFORM pg_temp.check((SELECT rake_amount_sats FROM arcade_matches WHERE id = v_match) = 20, 'rake = floor(200 * 10%)');
  PERFORM pg_temp.check(pg_temp.code(fund_arcade_match_v1(v_match, a, 100, 'fund-retry-' || s)) = 'ok', 'legacy fund retry is a no-op');
  PERFORM pg_temp.check(pg_temp.bal(a) = 900, 'legacy fund retry did not debit');

  -- 2. Open-lobby race: winner is debited in join, loser never is.
  PERFORM pg_temp.check(pg_temp.code(fund_arcade_match_v1(v_match, c, 100, 'fund-c-' || s)) = 'not_a_player', 'unseated user cannot pre-fund');
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, b)) = 'ok', 'join b');
  PERFORM pg_temp.check(pg_temp.bal(b) = 900, 'joiner debited in join');
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, c)) = 'match_not_waiting', 'race loser rejected');
  PERFORM pg_temp.check(pg_temp.bal(c) = 1000, 'race loser not debited');
  PERFORM pg_temp.check((join_arcade_match_v1(v_match, b)->>'already_joined')::BOOLEAN, 'join retry is idempotent');
  PERFORM pg_temp.check(pg_temp.bal(b) = 900, 'join retry not debited');

  -- 3. Played matches cannot be cancelled.
  PERFORM pg_temp.check(pg_temp.code(refund_arcade_match_v1(v_match, a, 'cancel-active-' || s)) = 'match_not_cancellable', 'cancel active rejected');
  PERFORM pg_temp.check(pg_temp.bal(a) = 900 AND pg_temp.bal(b) = 900, 'cancel active moved no money');

  -- 5/6. Clock and draft compare-and-set.
  PERFORM pg_temp.check(pg_temp.code(save_arcade_draft_v1(v_match, a, '[{"kind":"bank"}]', 3, 0)) = 'not_started', 'draft before ready rejected');
  PERFORM pg_temp.check(pg_temp.code(submit_and_settle_arcade_match_v1(v_match, a, '[]', 0, 0, TRUE)) = 'not_started', 'submit before ready rejected');
  PERFORM pg_temp.start_match(v_match, a, b);
  PERFORM pg_temp.check(pg_temp.code(save_arcade_draft_v1(v_match, a, '[{"kind":"bank"}]', 3, 0)) = 'ok', 'first draft');
  PERFORM pg_temp.check(pg_temp.code(save_arcade_draft_v1(v_match, a, '[{"kind":"bank"}]', 4, 0)) = 'draft_conflict', 'stale draft rejected');
  PERFORM pg_temp.check(pg_temp.code(save_arcade_draft_v1(v_match, a, '[{"kind":"bank"},{"kind":"bank"},{"kind":"bank"}]', 9, 1)) = 'bad_draft', 'draft must extend by one move');
  PERFORM pg_temp.check(pg_temp.code(submit_and_settle_arcade_match_v1(v_match, a, '[{"kind":"bank"}]', 10, 10, TRUE, NULL, 'submit-a-' || s)) = 'ok', 'submit a');
  PERFORM pg_temp.check((submit_and_settle_arcade_match_v1(v_match, a, '[]', 999, 999, TRUE, NULL, 'submit-a2-' || s)->>'already_submitted')::BOOLEAN, 'second submit is ignored');
  PERFORM pg_temp.check((SELECT player_a_score FROM arcade_matches WHERE id = v_match) = 10, 'submitted score is frozen');
  PERFORM pg_temp.check(pg_temp.code(save_arcade_draft_v1(v_match, a, '[{"kind":"bank"},{"kind":"bank"}]', 50, 1)) = 'already_submitted', 'draft frozen after submit');
  PERFORM pg_temp.check(pg_temp.code(submit_and_settle_arcade_match_v1(v_match, b, '[]', 5, 5, TRUE, NULL, 'submit-b-' || s)) = 'ok', 'submit b');
  PERFORM pg_temp.check(pg_temp.code(submit_and_settle_arcade_match_v1(v_match, b, '[]', 5, 5, TRUE, NULL, 'submit-b-retry-' || s)) = 'ok', 'submit b retry');
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080, 'winner paid exactly once: ' || pg_temp.bal(a));
  PERFORM pg_temp.check(pg_temp.bal(b) = 900, 'loser stake kept');
  PERFORM pg_temp.check((SELECT count(*) FROM ledger_entries WHERE transaction_id = 'arcade-rake:' || v_match AND type = 'arcade_rake' AND amount_sats = 20) = 1, 'rake ledger entry');
  PERFORM pg_temp.check((SELECT count(*) FROM integration_events WHERE deduplication_key = 'arcade.match_settled:' || v_match) = 1, 'one settlement event');
  PERFORM pg_temp.check((SELECT count(*) FROM arcade_escrow WHERE match_id = v_match AND status = 'released') = 2, 'escrow released');

  -- 1. Staked rematch is never playable unfunded.
  PERFORM pg_temp.check((request_arcade_rematch_v1(v_match, a)->>'status') = 'pending', 'rematch pending');
  UPDATE users SET balance_sats = 50 WHERE discord_id = b;
  v_result := request_arcade_rematch_v1(v_match, b);
  PERFORM pg_temp.check(pg_temp.code(v_result) = 'insufficient_balance' AND v_result->>'user_id' = b, 'underfunded rematch rejected');
  PERFORM pg_temp.check((SELECT next_match_id IS NULL FROM arcade_matches WHERE id = v_match), 'no child for underfunded rematch');
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080 AND pg_temp.bal(b) = 50, 'underfunded rematch moved no money');
  UPDATE users SET balance_sats = 900 WHERE discord_id = b;
  v_result := request_arcade_rematch_v1(v_match, b);
  PERFORM pg_temp.check(v_result->>'status' = 'created', 'rematch created: ' || v_result::text);
  v_other := (v_result->>'next_match_id')::BIGINT;
  PERFORM pg_temp.check((SELECT status = 'active' AND escrow_status = 'funded' FROM arcade_matches WHERE id = v_other), 'rematch child funded');
  PERFORM pg_temp.check(pg_temp.bal(a) = 980 AND pg_temp.bal(b) = 800, 'both rematch stakes debited');
  PERFORM pg_temp.check((request_arcade_rematch_v1(v_match, a)->>'next_match_id')::BIGINT = v_other, 'rematch retry idempotent');

  -- 4. Tie refunds both stakes.
  PERFORM pg_temp.start_match(v_other, a, b);
  PERFORM submit_and_settle_arcade_match_v1(v_other, a, '[]', 7, 7, TRUE);
  v_result := submit_and_settle_arcade_match_v1(v_other, b, '[]', 7, 7, TRUE);
  PERFORM pg_temp.check(v_result->>'status' = 'tie', 'tie status');
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080 AND pg_temp.bal(b) = 900, 'tie refunded both');

  -- 1. Unfunded creator: nothing is created.
  PERFORM pg_temp.check(pg_temp.code(create_arcade_match_v1('staked_pvp', poor, NULL, 100, NULL, 180, 'create-poor-' || s)) = 'insufficient_balance', 'poor creator rejected');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM arcade_matches WHERE created_by_id = poor), 'no match row for poor creator');
  PERFORM pg_temp.check(pg_temp.bal(poor) = 10, 'poor creator untouched');
  PERFORM pg_temp.check(pg_temp.code(create_arcade_match_v1('staked_pvp', a, NULL, 'NaN', NULL, 180, 'create-nan-' || s)) = 'bad_stake', 'NaN stake rejected');

  -- 3/4. Cancel then submit: refund once, no payout, no re-funding.
  v_result := create_arcade_match_v1('staked_pvp', a, b, 100, NULL, 180, 'create-cancel-' || s);
  v_match := (v_result->'match'->>'id')::BIGINT;
  PERFORM pg_temp.check(pg_temp.bal(a) = 980, 'cancel-case stake debited');
  PERFORM pg_temp.check(pg_temp.code(refund_arcade_match_v1(v_match, b, 'cancel-b-' || s)) = 'not_creator', 'only creator cancels');
  PERFORM pg_temp.check(pg_temp.code(refund_arcade_match_v1(v_match, a, 'cancel-a-' || s)) = 'ok', 'creator cancels waiting');
  PERFORM pg_temp.check((refund_arcade_match_v1(v_match, a, 'cancel-a2-' || s)->>'already_cancelled')::BOOLEAN, 'cancel retry idempotent');
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080, 'cancel refunded exactly once');
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, b)) = 'match_not_waiting', 'cannot join cancelled');
  PERFORM pg_temp.check(pg_temp.code(submit_and_settle_arcade_match_v1(v_match, a, '[]', 50, 50, TRUE)) = 'match_not_active', 'submit after cancel rejected');
  PERFORM pg_temp.check(pg_temp.code(fund_arcade_match_v1(v_match, a, 100, 'fund-after-refund-' || s)) = 'match_not_waiting', 'fund after refund rejected');
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080 AND pg_temp.bal(b) = 900, 'cancel-then-submit moved no money');
  PERFORM pg_temp.check((SELECT status FROM arcade_escrow WHERE match_id = v_match AND user_id = a) = 'refunded', 'escrow stays refunded');

  -- 4. A refunded escrow row is never flipped back, even while waiting.
  v_result := create_arcade_match_v1('staked_pvp', a, NULL, 100, NULL, 180, 'create-closed-' || s);
  v_match := (v_result->'match'->>'id')::BIGINT;
  UPDATE arcade_escrow SET status = 'refunded' WHERE match_id = v_match AND user_id = a;
  UPDATE users SET balance_sats = balance_sats + 100 WHERE discord_id = a;
  PERFORM pg_temp.check(pg_temp.code(fund_arcade_match_v1(v_match, a, 100, 'fund-closed-' || s)) = 'escrow_closed', 'refunded escrow not reopened');
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080, 'escrow_closed moved no money');
  -- ...and join requires the creator's escrow to be funded.
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, b)) = 'creator_not_funded', 'staked join needs funded creator');
  PERFORM pg_temp.check(pg_temp.bal(b) = 900, 'join against unfunded creator not debited');
  PERFORM refund_arcade_match_v1(v_match, a);

  -- 1. Tipfight join requires the creator's escrow.
  v_result := create_arcade_match_v1('tipfight', a, NULL, 100, NULL, 180, 'create-tip-unfunded-' || s);
  v_match := (v_result->'match'->>'id')::BIGINT;
  PERFORM pg_temp.check((SELECT escrow_status FROM arcade_matches WHERE id = v_match) = 'funded', 'tipfight funded on create');
  UPDATE arcade_escrow SET status = 'refunded' WHERE match_id = v_match;
  UPDATE users SET balance_sats = balance_sats + 100 WHERE discord_id = a;
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, b)) = 'creator_not_funded', 'tipfight unfunded join rejected');
  PERFORM refund_arcade_match_v1(v_match, a);
  PERFORM pg_temp.check(pg_temp.bal(a) = 1080, 'balances consistent after tipfight setup');

  -- 8. Tipfight: B strictly beats A -> B paid gross - rake.
  v_match := (create_arcade_match_v1('tipfight', a, NULL, 100, NULL, 180, 'create-tip-b-' || s)->'match'->>'id')::BIGINT;
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, b)) = 'ok', 'tipfight join');
  PERFORM pg_temp.check(pg_temp.bal(b) = 900, 'tipfight joiner not debited');
  PERFORM pg_temp.start_match(v_match, a, b);
  PERFORM submit_and_settle_arcade_match_v1(v_match, a, '[]', 3, 3, TRUE);
  v_result := submit_and_settle_arcade_match_v1(v_match, b, '[]', 4, 4, TRUE);
  PERFORM pg_temp.check(v_result->>'winner_id' = b, 'tipfight b wins');
  PERFORM pg_temp.check(pg_temp.bal(a) = 980 AND pg_temp.bal(b) = 990, 'tipfight payout 90 after 10 rake: ' || pg_temp.bal(a) || '/' || pg_temp.bal(b));

  -- 8. Tipfight: A holds (tie) -> A refunded, no rake.
  v_match := (create_arcade_match_v1('tipfight', a, NULL, 100, NULL, 180, 'create-tip-a-' || s)->'match'->>'id')::BIGINT;
  PERFORM join_arcade_match_v1(v_match, b);
  PERFORM pg_temp.start_match(v_match, a, b);
  PERFORM submit_and_settle_arcade_match_v1(v_match, a, '[]', 4, 4, TRUE);
  v_result := submit_and_settle_arcade_match_v1(v_match, b, '[]', 4, 4, TRUE);
  PERFORM pg_temp.check(v_result->>'winner_id' = a, 'tipfight defense holds');
  PERFORM pg_temp.check(pg_temp.bal(a) = 980 AND pg_temp.bal(b) = 990, 'tipfight defense refunded challenger');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = 'arcade-rake:' || v_match), 'no rake on refund');

  -- 1. Settlement pays only against a fully funded pot.
  v_match := (create_arcade_match_v1('staked_pvp', a, NULL, 100, NULL, 180, 'create-short-' || s)->'match'->>'id')::BIGINT;
  PERFORM join_arcade_match_v1(v_match, b);
  PERFORM pg_temp.start_match(v_match, a, b);
  UPDATE arcade_escrow SET amount_sats = 1 WHERE match_id = v_match AND user_id = b;
  PERFORM submit_and_settle_arcade_match_v1(v_match, a, '[]', 9, 9, TRUE);
  v_result := submit_and_settle_arcade_match_v1(v_match, b, '[]', 1, 1, TRUE);
  PERFORM pg_temp.check(v_result->>'status' = 'refunded', 'short pot refunded: ' || v_result::text);
  PERFORM pg_temp.check(pg_temp.bal(a) = 980 AND pg_temp.bal(b) = 891, 'short pot: stakes refunded, no payout');

  -- 5/7. Server clock and the expiry sweeper.
  v_match := (create_arcade_match_v1('staked_pvp', a, NULL, 100, NULL, 60, 'create-late-' || s)->'match'->>'id')::BIGINT;
  PERFORM join_arcade_match_v1(v_match, b);
  PERFORM pg_temp.start_match(v_match, a, b);
  PERFORM save_arcade_draft_v1(v_match, b, '[{"kind":"bank"}]', 12, 0);
  UPDATE arcade_matches SET started_at = now() - interval '10 minutes' WHERE id = v_match;
  PERFORM pg_temp.check(pg_temp.code(save_arcade_draft_v1(v_match, a, '[{"kind":"bank"}]', 3, 0)) = 'deadline_passed', 'late draft rejected');
  PERFORM pg_temp.check(pg_temp.code(submit_and_settle_arcade_match_v1(v_match, a, '[]', 99, 99, TRUE)) = 'deadline_passed', 'late submit rejected');
  v_other := (create_arcade_match_v1('staked_pvp', c, NULL, 100, NULL, 180, 'create-stale-' || s)->'match'->>'id')::BIGINT;
  UPDATE arcade_matches SET created_at = now() - interval '2 hours' WHERE id = v_other;
  PERFORM pg_temp.check(pg_temp.bal(c) = 900, 'stale creator debited');
  v_result := expire_stale_arcade_matches_v1(30, 60, 500);
  PERFORM pg_temp.check((SELECT status FROM arcade_matches WHERE id = v_other) = 'cancelled', 'stale waiting match cancelled');
  PERFORM pg_temp.check(pg_temp.bal(c) = 1000, 'stale waiting match refunded');
  PERFORM pg_temp.check((SELECT status = 'completed' AND winner_id = b FROM arcade_matches WHERE id = v_match), 'expired match settled from drafts');
  PERFORM pg_temp.check(pg_temp.bal(b) = 891 - 100 + 180 AND pg_temp.bal(a) = 880, 'expired match paid draft leader');
  v_result := expire_stale_arcade_matches_v1(30, 60, 500);
  PERFORM pg_temp.check(pg_temp.bal(b) = 971 AND pg_temp.bal(c) = 1000, 'sweeper is idempotent');

  -- Emulator round debit is idempotent.
  PERFORM pg_temp.check(acquire_service_lease_v1('emulator', 'holder-' || s, 30), 'emulator lease');
  PERFORM settle_emulator_round_v1(p_round_id => 'round-' || s, p_holder_id => 'holder-' || s, p_button => 'A',
    p_votes => jsonb_build_array(jsonb_build_object('user_id', c, 'amount_sats', 10)));
  PERFORM settle_emulator_round_v1(p_round_id => 'round-' || s, p_holder_id => 'holder-' || s, p_button => 'A',
    p_votes => jsonb_build_array(jsonb_build_object('user_id', c, 'amount_sats', 10)));
  PERFORM pg_temp.check(pg_temp.bal(c) = 990, 'emulator round debit idempotent');
  PERFORM pg_temp.check((SELECT count(*) FROM integration_events WHERE deduplication_key = 'emulator.round_resolved:round-' || s) = 1, 'one emulator event');

  -- 8. SatScape buy-in and action validation.
  SELECT balance_sats INTO v_pool FROM sat_prize_pool WHERE id = 1;
  PERFORM pg_temp.check(pg_temp.code(start_satscape_run_v1(c, 'NaN')) = 'bad_buyin', 'NaN buy-in rejected');
  PERFORM pg_temp.check(pg_temp.code(start_satscape_run_v1(c, -5)) = 'bad_buyin', 'negative buy-in rejected');
  PERFORM pg_temp.check(pg_temp.code(start_satscape_run_v1(c, 0)) = 'bad_buyin', 'zero buy-in rejected');
  PERFORM pg_temp.check(pg_temp.bal(c) = 990, 'rejected buy-ins moved no money');
  v_result := start_satscape_run_v1(c, 50);
  PERFORM pg_temp.check(pg_temp.code(v_result) = 'ok', 'start run');
  PERFORM pg_temp.check((start_satscape_run_v1(c, 50)->>'already_active')::BOOLEAN, 'start retry is a no-op');
  PERFORM pg_temp.check(pg_temp.bal(c) = 940, 'buy-in debited once');
  PERFORM pg_temp.check((SELECT balance_sats FROM sat_prize_pool WHERE id = 1) = v_pool + 50, 'buy-in seeds the prize pool');
  PERFORM pg_temp.check((SELECT receiver_id FROM ledger_entries WHERE type = 'satscape_buyin' AND sender_id = c) = 'sat_prize_pool', 'buy-in ledger receiver is the pool');
  v_version := (v_result->>'state_version')::BIGINT;
  v_result := commit_satscape_action_v1(c, v_version, '{"hp": 99999}'::jsonb);
  PERFORM pg_temp.check((v_result->>'ok')::BOOLEAN AND (SELECT hp FROM sat_players WHERE discord_id = c) = 250, 'hp clamped to max_hp');
  v_version := (v_result->>'state_version')::BIGINT;
  v_result := commit_satscape_action_v1(c, v_version, '{"hp": -5}'::jsonb);
  PERFORM pg_temp.check((SELECT hp FROM sat_players WHERE discord_id = c) = 0, 'hp clamped to zero');
  v_version := (v_result->>'state_version')::BIGINT;
  v_result := commit_satscape_action_v1(c, v_version, '{"x_coord": 1}'::jsonb, NULL, FALSE, '[{"item_id":"bread","quantity":-1}]'::jsonb);
  PERFORM pg_temp.check(v_result->>'code' = 'inventory_conflict', 'missing inventory is a conflict: ' || v_result::text);
  PERFORM pg_temp.check((SELECT state_version = v_version AND x_coord <> 1 FROM sat_players WHERE discord_id = c), 'conflict wrote nothing');
  PERFORM pg_temp.check((commit_satscape_action_v1(c, v_version - 1, '{}'::jsonb)->>'conflict')::BOOLEAN, 'stale version conflict');
END;
$$;

DO $$
DECLARE
  s TEXT := substr(md5(gen_random_uuid()::text), 1, 10);
  a TEXT := 'dbt-pa-' || s;
  newbie TEXT := 'dbt-new-' || s;
  v_match BIGINT;
  v_result JSONB;
BEGIN
  INSERT INTO users(discord_id, balance_sats) VALUES (a, 1000);

  -- Practice has no player B: ready and submit must not trip NOT NULL on player_b_*.
  v_match := (create_arcade_match_v1('practice', a, NULL, NULL, NULL, 180, 'create-practice-' || s)->'match'->>'id')::BIGINT;
  PERFORM pg_temp.check(pg_temp.code(mark_arcade_ready_v1(v_match, a)) = 'ok', 'practice ready');
  v_result := submit_and_settle_arcade_match_v1(v_match, a, '[]', 5, 5, TRUE);
  PERFORM pg_temp.check((SELECT status FROM arcade_matches WHERE id = v_match) = 'completed', 'practice submit completes: ' || v_result::text);
  PERFORM pg_temp.check(pg_temp.bal(a) = 1000, 'practice moves no money');

  -- Tipfight challenger with no users row still receives the payout.
  v_match := (create_arcade_match_v1('tipfight', a, NULL, 100, NULL, 180, 'create-tip-new-' || s)->'match'->>'id')::BIGINT;
  PERFORM pg_temp.check(pg_temp.code(join_arcade_match_v1(v_match, newbie)) = 'ok', 'rowless user joins tipfight');
  PERFORM pg_temp.start_match(v_match, a, newbie);
  PERFORM submit_and_settle_arcade_match_v1(v_match, a, '[]', 1, 1, TRUE);
  v_result := submit_and_settle_arcade_match_v1(v_match, newbie, '[]', 5, 5, TRUE);
  PERFORM pg_temp.check(v_result->>'winner_id' = newbie, 'rowless challenger wins');
  PERFORM pg_temp.check(pg_temp.bal(newbie) = 90, 'rowless winner credited 90: ' || COALESCE(pg_temp.bal(newbie)::text, 'no row'));
  PERFORM pg_temp.check(pg_temp.bal(a) = 900, 'creator lost stake');
END;
$$;

ROLLBACK;

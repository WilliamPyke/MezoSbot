# Modular deployment and rollout

All production changes are built from and pushed to `origin/TestingRender`.
Never deploy `main`.

## 1. Database

Apply these in order, to staging and then production, in the Supabase SQL editor:

1. `migrations/2026-09-21_developer_relay_channel_only.sql`
2. `migrations/2026-08-12_modular_runtime.sql`
3. `migrations/2026-09-24_swap_recovery.sql` (lets swap recovery park rows in
   `needs_review`; without it those rows are only flagged in metadata)

All three are additive, re-runnable, and keep the legacy code operational. Validate the four hot indexes with the queries in
`explain-hot-paths.sql` against production-like data before enabling remote
traffic.

What it guarantees (and CI asserts on a fresh Postgres):

- Every `*_v1` function is revoked from `PUBLIC`, `anon` and `authenticated`
  (Supabase's default privileges grant those roles EXECUTE on new functions;
  `REVOKE ... FROM PUBLIC` alone does not remove that) and granted only to
  `service_role`.
- `integration_events`, `integration_idempotency`, `integration_request_nonces`
  and `service_leases` have RLS enabled with no policies, and table grants to
  `anon`/`authenticated` are revoked. `service_role` bypasses RLS.
- `integration_events` is **not** in the `supabase_realtime` publication; the bot
  polls `claim_integration_events_v1` every 2 s. Events are dead-lettered
  (`status = 'dead'`) after 10 attempts, including events whose consumer died
  holding the lock. Inspect with
  `SELECT * FROM integration_events WHERE status = 'dead' ORDER BY created_at DESC;`
- Idempotency records are bound to a hash of the request
  (`idempotency_begin_v1` / `idempotency_finish_v1`). Reusing a key for a
  different request returns `{"ok":false,"code":"idempotency_conflict"}`.
  Records are kept 30 days; the bot's hourly, lease-guarded
  `purge_integration_state_v1` removes expired rows.
- `arcade_matches.runtime` (`legacy` | `remote`) records which runtime created
  a match. The bot routes accept/cancel/play/watch by this column, not by the
  current flag, so a match is always finished and settled by the runtime that
  created it.

## 2. Cloudflare Workers Paid

Create Worker secrets for `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`INTERNAL_SIGNING_SECRET` (games-only; the bot's `GAMES_SIGNING_SECRET` must be
the same value, and it must differ from the emulator's secret), and
`PLAY_TOKEN_SECRET`. Wrangler 4 needs Node 22+ locally. Deploy from
`apps/games-worker/wrangler.jsonc`, attach `arcade.mallard.sh` and
`satscape.mallard.sh`, and route `play.mallard.sh` to the same Worker during the
30-day redirect window. Configure a Workers usage notification before traffic is
enabled.

Run `npm run build:games-worker` for a dry-run bundle and
`npm run deploy --workspace @mezosbot/games-worker` to publish.

## 3. Northflank emulator

Create a second service from `deploy/Dockerfile.emulator`. Required variables:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `INTERNAL_SIGNING_SECRET`
(emulator-only). Route port 8787 to `emulator.mallard.sh`.

**ROM.** The image does not contain the ROM. Mount `pokeyellow.gbc` at runtime
at `ROM_PATH` (default `/app/pokeyellow.gbc`): either a Northflank secret file
mounted at that path, or a volume (e.g. mounted at `/app/rom`) with
`ROM_PATH=/app/rom/pokeyellow.gbc`. The process exits at startup if the file is
not readable.

**Lease and probes.** Every process starts as a standby and polls the
`emulator` lease in `service_leases`; only the holder starts the engine. Each
process uses a fresh holder id (`EMULATOR_INSTANCE_ID` or hostname plus a
per-run UUID), so a restart never inherits a previous lease. If a renewal
returns false, or renewals keep failing past `ttl - ttl/6`, the process stops
saving and exits with code 1 so Northflank restarts it as a standby.
Settlement is also fenced in SQL: `settle_emulator_round_v1` rejects any
caller that is not the current, unexpired holder.

- Liveness probe: `GET /livez` (always 200 while the process runs, standbys
  included). Do not point liveness at `/healthz`, or standbys get killed.
- Readiness probe: `GET /healthz` (200 only for the leaseholder with a running
  engine; 503 `standby`/`starting` otherwise), so traffic only reaches the
  active instance.
- Deployment strategy: **Recreate** (stop old, then start new) with one
  instance. A rolling deploy works but the new pod sits in standby until the old
  one releases the lease on SIGTERM.
- Termination grace period: at least 20 s. On SIGTERM the service drains
  pending settlements (≤3 s), waits for the engine's final save
  (`GB_SHUTDOWN_TIMEOUT_MS`, default 15 s, total), then releases the lease.

**Optional variables.** `STREAM_MAX_VIEWERS` (default 50),
`STREAM_MAX_BUFFERED_BYTES` (1000000; frames are skipped for a viewer above
this), `STREAM_SLOW_CLIENT_MAX_SKIPS` (600 skipped frames, then the viewer is
dropped), `STREAM_HEARTBEAT_MS` (15000 ping/pong), `EMULATOR_LEASE_TTL_SECONDS`
(30), `EMULATOR_STANDBY_POLL_MS` (5000), `GB_MAX_PENDING_ROUNDS` (120),
`GB_SAVES_DIR` (`/app/saves`, local fallback only). The `/stream` WebSocket is
unauthenticated, as before.

## 4. Northflank bot

Build the core service with `deploy/Dockerfile.bot` (build context: repo root,
Node 22). The image runs the full root `npm run build` — `build:packages`
first, then the Vite web build, `tsc`, and the SatScape chunk copy — so the
legacy browser server, SatScape assets and local emulator code are all present
and any feature flag can be set back to `false` without a different image.
`dist/` is not committed; every build (Docker, Render's `npm run build`)
regenerates it.

Keep all existing bot/EVM variables and add:

```text
MEZOSBOT_RUNTIME_ROLE=bot
GAMES_SERVICE_URL=https://arcade.mallard.sh
EMULATOR_SERVICE_URL=https://emulator.mallard.sh
GAMES_SIGNING_SECRET=<the Worker's INTERNAL_SIGNING_SECRET>
EMULATOR_SIGNING_SECRET=<the emulator's INTERNAL_SIGNING_SECRET>
ARCADE_REMOTE_ENABLED=false
SATSCAPE_REMOTE_ENABLED=false
EMULATOR_REMOTE_ENABLED=false
```

The two signing secrets are independent: there is no shared
`INTERNAL_SIGNING_SECRET` fallback in the bot. The bot refuses to boot if
`GAMES_SIGNING_SECRET` is empty while Arcade or SatScape is remote, if
`EMULATOR_SIGNING_SECRET` is empty while the emulator is remote, or if the two
are equal.

**Feature flags are read once at boot.** Flipping one means changing the
variable and redeploying/restarting the service; there is no live toggle. For
each feature the process runs exactly one path:

| Flag | `true` | `false` |
| --- | --- | --- |
| `ARCADE_REMOTE_ENABLED` | new matches are created by the Worker (`runtime='remote'`) | new matches are created locally (`runtime='legacy'`) |
| `SATSCAPE_REMOTE_ENABLED` | slash commands and old buttons hand out Worker links; mutating buttons reply "web-only" | legacy in-process SatScape |
| `EMULATOR_REMOTE_ENABLED` | votes go to the emulator service; the local emulator is not started; round events edit one throttled status message | local emulator; remote round events are ignored |

Existing arcade matches are always driven by the runtime that created them
(`arcade_matches.runtime`), so a flag flip never makes both paths settle the
same match. `/arcade matchmake` stays legacy-only.

**Discord retries.** Service calls carry an idempotency key derived from the
Discord interaction (or message) id plus the action. On timeout
(`INTERNAL_REQUEST_TIMEOUT_MS`, default 5000) the bot retries once with the
same key, then tells the user the request is still processing instead of
reporting an outage. Emulator votes are never resent.

Enable one feature at a time: SatScape, Arcade, then emulator. Until all three
are remote, the bot keeps the legacy HTTP server (`stream.ts`: `/healthz`,
`/arcade`, `/satscape`, web client, stream) running as a rollback path. A
rollback only sets that feature's flag to `false` and redeploys; no financial
migration is reverted. Once all three flags are true,
`MEZOSBOT_RUNTIME_ROLE=bot` starts only the lean `/healthz` + `/metrics`
server and does not load the legacy game server.

For a local-emulator rollback (`EMULATOR_REMOTE_ENABLED=false`) the ROM is not
in the image either: mount it and set `ROM_PATH` exactly as for the emulator
service. Local saves go to `GB_SAVES_DIR=/app/saves` (writable by the `node`
user); attach a volume there if they must survive restarts.

## Release gates

- Shadow-read mismatches must be zero for financial and state-version fields.
- Bot acknowledgement p95 < 500 ms; API p95 < 250 ms.
- Bot event-loop lag p99 < 50 ms.
- Emulator nominal delivery >= 55 FPS to 25 viewers and dropped frames < 2%.
- Duplicate debit, payout, reward, and notification tests remain zero.
- `modular-ci` is green: typecheck, unit/contract/worker/emulator tests, the bot
  image builds, the migration applies twice on a fresh Postgres, and the
  privilege/RLS assertions pass (no `*_v1` function executable by `anon` or
  `authenticated`).
- Zero rows with `status = 'dead'` in `integration_events` and zero
  `idempotency_conflict` responses during the observation window (either points
  at a caller bug, not load).

Observe for seven days after full cutover. Only then remove the old game routes,
the monolith emulator imports, and `render.yaml`.

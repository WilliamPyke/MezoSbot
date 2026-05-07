# PRD-02 — Slice Arcade Matchmaking v2

Author: handover doc, 2026-05-07
Branch in flight: `TestingRender` (matchmaking v1 already shipped — see `git log`)
Owner: tbd

## 0. How to use this doc

You're being asked to take over Slice Arcade matchmaking. Matchmaking v1 is
already deployed; this doc tells you what it does, what's wrong with it, and
what we want next. Read sections 1–3 for context, 4 for the problem set,
5 for the proposed scope, 6 for the technical map.

**First-day instruction:** ship section 5.1 (Ready-up timer + no-show
forfeit). It's the only fix that makes the existing feature work correctly.
Everything after is enhancement.

---

## 1. App context

### What is MezoSbot

A Discord bot + wallet web app for the Mezo Network ecosystem. Two main
features today:

1. **Slice Arcade** — a PvP block-puzzle game (think Tetris-meets-1010 on a
   9×9 grid). Players race the same deterministic piece sequence; highest
   server-validated score wins. Single repo, single Node process, two
   front-ends.
2. **Other Discord-native primitives** — sats balances, deposits/withdrawals,
   tipping, drops, a Pokemon Game Boy emulator. Mostly orthogonal to this PRD;
   referenced only where they intersect (the internal sats balance is what
   Discord-side stakes draw from).

### The two surfaces

The arcade has two distinct front-ends that share a server validator and a
deterministic game engine:

| Surface | Identity | Stake currency | Settlement |
|---|---|---|---|
| **Discord** | Discord snowflake | Internal `sats` balance in Supabase | Server-side balance updates |
| **Wallet / web** | EVM address | On-chain ERC20/native via `MallardGameEscrow` | On-chain settlement tx by a settler key |

These are deliberately separate. Discord users can link a wallet
(`src/commands/link.ts`) but matchmaking does not yet bridge surfaces —
Discord-vs-Discord and wallet-vs-wallet only.

### What "a match" is

- 9×9 board, 12 levels per match, 3 pieces per level.
- Both players receive the same seeded piece sequence. Highest validated
  score wins; tie refunds stakes.
- Match duration is configurable per match (default 3 min, max 5).
- Server validates by replaying the move log against the seed
  (`src/arcade/match.ts:replayMoves`). Cheating is not a concern on the
  Discord side because the server authoritatively scores. On the wallet
  side, a result hash is signed by a settler key and submitted on-chain.

### Game engine — invariants you must not break

- Determinism. Both players' boards are reproducible from `seed + moveLog`.
  All scoring is server-side. Don't add client-only state that affects
  scoring.
- Single-process state. The `runtime` registry (`src/arcade/runtime.ts`) is
  in-memory; it's rebuilt from persisted move logs on restart. Anything you
  add that needs survival across restarts must be persisted.

---

## 2. Matchmaking v1 (shipped, commit `6dfa22f`)

### Schema

`arcade_queue` table — one row per pending or recently-paired entry.
`user_id` is a Discord snowflake or lowercase EVM address depending on
surface. See `migrations/2026-05-07_arcade_queue.sql`.

Key columns: `surface ('discord' | 'wallet')`, `status ('waiting' | 'paired'
| 'cancelled' | 'expired')`, `chain_id`, `asset_address`,
`stake_amount_units`, `match_id`, `session_id`, `paired_with`, `joined_at`,
`expires_at`.

A unique partial index `(surface, user_id) WHERE status='waiting'` enforces
one active queue entry per user per surface.

### Pairing

FIFO within a bucket:

- Discord: bucket = `surface='discord'`. Free PvP only. Atomic claim via
  Postgres RPC `claim_oldest_discord_queue_entry` (uses `FOR UPDATE SKIP
  LOCKED`).
- Wallet: bucket = `(chain_id, asset_address, stake_amount_units)`. Older
  queued player becomes session creator (player A); newer becomes invited
  player B. Both then go through the existing escrow flow.

Pairing is triggered on enqueue — when player N+1 joins a non-empty queue,
they immediately pair against the oldest entry. There is also a 60s
background sweeper that expires stale `waiting` rows past their `expires_at`
(default 5 min TTL).

### User-facing surface

- `/arcade matchmake [minutes]` — Discord, free PvP only.
- `/arcade leave-queue` — Discord, cancels your waiting entry.
- Wallet "Quick Match" panel on the home view (`web/src/App.tsx`) — pick
  asset + stake, click "Find match", polls `/api/web/queue` every 3s for
  status. On pair, navigates to the existing `/session/:id` page.
- API: `POST /api/web/queue`, `GET /api/web/queue`, `DELETE /api/web/queue`.

### Notifications

When two Discord players pair, the *joiner* gets the slash-command reply
with their play link, and the *waiter* gets a DM with theirs. If the
waiter has DMs closed, they currently get nothing — silent failure.

---

## 3. Pre-existing match flow (relevant context)

Skim `src/arcade/db.ts` and `src/arcade/web.ts` for full details. The bits
you need to know:

- `createMatch` (Discord) and `createSessionDraft` (wallet) — how matches
  are born. Matchmaking calls these directly when pairing.
- `started_at` on `arcade_matches` is set the moment the second player
  is seated (either via `joinMatch` or via matchmaking creating the match
  with both players already attached).
- Match deadline is `started_at + duration_seconds`
  (`src/arcade/web.ts:deadlineAt`). Once it passes, the match auto-finishes
  via `finishOnTimer`.
- `web_arcade_sessions` has parallel `play_deadline` set at draft creation
  time, with longer windows configured by `WEB_JOIN_WINDOW_SECONDS` /
  `WEB_PLAY_WINDOW_SECONDS`.

---

## 4. Problems with v1

### 4.1 The timer starts before players are ready (P0 bug)

Today: when matchmaking pairs two Discord players, `createMatch` is called
with both `playerAId` and `playerBId`, which sets `status='active'` and
`started_at = now()` *immediately*. The deadline is fixed from that moment.

Failure mode: Alice queues, Bob queues 30s later → match created at T+30,
deadline = T+30 + 180s. Alice's DM takes 8s to deliver, she's AFK on
mobile, opens the link 45s after the DM. She has now lost 53s of her 3 min
before her first piece. She rage-quits. Or worse: her phone stays in pocket,
she "no-shows" the entire match, opponent wins by default but didn't really
earn it.

### 4.2 No fallback when DMs are closed

Discord users routinely block bot DMs. The waiter gets *nothing* if their
DMs are closed — not a channel ping, not a follow-up nudge. The match
exists in the DB but they don't know.

### 4.3 Empty-queue feel

If you're the first into the queue and nobody else shows up for two
minutes, the UI is a static "queued, will DM you" message. No queue depth,
no ETA, no signal that the system is alive. People bail.

### 4.4 No "play again" loop

Match settles, embed updates, both players go their separate ways. The
single-most-likely-to-want-another-match cohort (people who literally just
played) has no one-click path back into queue.

### 4.5 Free PvP only on Discord

Wallet matchmaking already supports stake-bucketed pairing. Discord
matchmaking does not — even though staked PvP via `/arcade challenge` and
`/arcade offer` works fine. Asymmetric and confusing.

### 4.6 No skill matching

FIFO. A first-time player can be paired against the rank-1 leaderboard
holder. Bad first experience for the new player, low-stakes win for the
veteran.

### 4.7 Single round = high variance

3 minutes of one game. One bad piece sequence on a tight board and the
match is decided by RNG, not skill. Best-of-N would feel substantially
more competitive.

---

## 5. Proposed scope — pick a slice and ship

Listed in priority order. **Section 5.1 is the only mandatory item; it
fixes 4.1.** Everything below it is value-add.

### 5.1 Ready-up timer + no-show forfeit (P0, ship first)

Goal: the gameplay timer doesn't start counting down until both players
have actually opened the playfield.

Schema change:
```sql
ALTER TABLE arcade_matches
  ADD COLUMN IF NOT EXISTS player_a_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS player_b_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS play_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ready_deadline TIMESTAMPTZ;
```

Behavior:
1. On match creation (matchmake or join), set `ready_deadline = now() +
   60s`. Do NOT set `play_started_at`.
2. First time each player hits `/arcade/api/state` for this match, set
   their `player_X_ready_at`.
3. Once both ready timestamps exist, set `play_started_at = now()`.
4. `deadlineAt` becomes `play_started_at + duration_seconds` (fall back to
   old behavior if `play_started_at IS NULL`, for backwards compatibility
   with non-matchmake matches — though those start with both players
   already ringing in fast, so the difference is small).
5. If `ready_deadline` passes and only one player has rung in, the
   other forfeits. Auto-settle: ringing-in player wins by walkover.
6. UI: while waiting for opponent ready-up, show a "Waiting for opponent
   to load (Xs left)" banner. Disable placement until both ready.

Apply same logic to `web_arcade_sessions` (`play_deadline` is already
loosely time-bounded; tighten it the same way).

### 5.2 Channel-based fallback notifications (P1)

Add `ARCADE_NOTIFY_CHANNEL_ID` config. When a match is paired:

- Try DM first.
- If DM fails *or* user has interacted with this channel within last 24h,
  also post `<@user> your match is ready — [Open playfield](url)` to the
  fallback channel.
- Add a Discord webhook for this so it doesn't spam if DMs work.

Acceptance: in a test guild with bot DMs blocked, a paired user still
sees a clickable play link via channel mention within 5s.

### 5.3 Persistent Arcade Lobby (P1, big UX win)

Goal: matchmaking is discoverable without remembering a slash command.

Add `/arcade lobby setup` (admin only) that posts a pinned embed in the
current channel with:

- Live queue depth (per surface, per stake tier).
- "Join free queue" button.
- "Top stakes" buttons (e.g. 100 sats, 1000 sats, 10000 sats — derived
  from `STAKE_TIERS`).
- "Active matches" count and a link to the live feed.

Embed is updated by a 10s server-side tick. Buttons fire the same code
paths as `/arcade matchmake` / `/arcade challenge stake:<n>`.

This replaces the slash command as the primary entry point. Slash commands
remain for power users.

### 5.4 "Play again" button on settled embeds (P1)

When a match settles, add a button to the result embed: "Re-queue at same
stake" that immediately calls the matchmake handler with the user's prior
duration + stake. One click → back in queue.

For the wallet side, the post-settlement view already has a "back to home"
flow; add a "Find another match" button that pre-fills the same asset/stake
in QuickMatch.

Empirically, this single button is worth more than any other engagement
feature on the list. Rematches are how arcade games keep people in.

### 5.5 Discord staked matchmaking (P2)

Extend `/arcade matchmake` with an optional `stake` argument. Bucket key
becomes `(surface='discord', stake_amount_sats)`. Reuse existing
`fundEscrowFromBalance` flow — debit on enqueue, refund on cancel/expire.

Acceptance: two players queueing with the same stake get paired into a
`staked_pvp` match with both escrows already funded, no extra clicks.

### 5.6 Queue depth visibility (P2)

`/arcade matchmake` reply and the QuickMatch waiting state both show:

- Number of players currently waiting in your bucket.
- Median wait time over the last hour (computed from `paired_at -
  joined_at` of completed pairings).

Cheap to compute, big "system feels alive" signal.

### 5.7 Skill-based pairing / MMR (P3)

Glicko-2 per `user_id` per surface. Persist to a new `arcade_ratings`
table. Pairing within ±100 rating; widen radius linearly with wait time
(e.g. +50 every 10s). Initial rating 1500, RD 350.

Don't ship this until daily volume is high enough to justify it; with
fewer than ~50 pairings/day FIFO + tier buckets is fine.

### 5.8 Best-of-3 rounds (P3)

Pair once, play 3 boards. New `arcade_match_sets` table with `match_id`,
`round_number`, `seed`. Aggregate score wins; ties go to fourth round.

Significant scope — only pursue when the underlying single-round
experience is solid.

### 5.9 Cross-surface bridge for linked accounts (P4, future)

A Discord user with a linked wallet can opt into the wallet stake queue.
Server escrows on their behalf from internal sats (or vice versa). Big
lift; defer until you have demand evidence.

### 5.10 Tournaments via Discord Events (P4, future)

Bot creates a Discord scheduled event ("Slice Hour Friday 8pm"), opens a
bracket queue 5 min before, runs single-elim, posts results. Discord
Events natively notifies attendees — minimum-friction recurring engagement.

---

## 6. Technical map for the new agent

### Where things live

| Path | What it is |
|---|---|
| `src/arcade/match.ts` | Pure game logic. Don't touch unless changing rules. |
| `src/arcade/runtime.ts` | In-memory match registry. Rebuilt from move log on restart. |
| `src/arcade/db.ts` | Discord-side match CRUD, escrow, settlement. |
| `src/arcade/web.ts` | Browser playfield rendering + state shape. |
| `src/arcade/matchmaking.ts` | Matchmaking v1 (this PRD's starting point). |
| `src/arcade/interactions.ts` | Discord button handlers (accept/cancel/play). |
| `src/commands/arcade.ts` | All `/arcade *` slash command handlers. |
| `src/web/routes.ts` | HTTP API for the wallet web app + queue endpoints. |
| `src/web/db.ts` | Wallet session CRUD. |
| `src/index.ts` | Entry point, gateway lifecycle, periodic sweepers. |
| `web/src/App.tsx` | Wallet web UI (single file — yes really). |
| `web/src/api.ts` | Web API types shared with `App.tsx`. |
| `supabase-schema.sql` | Source-of-truth for full schema. Idempotent. |
| `migrations/*.sql` | Per-change migrations. New work creates a new file here. |

### Schema you'll likely touch

- `arcade_matches` — needs `player_a_ready_at`, `player_b_ready_at`,
  `play_started_at`, `ready_deadline` for 5.1.
- `web_arcade_sessions` — same fields for the wallet side.
- `arcade_queue` — already exists; may need a `stake_amount_sats` column
  for 5.5 (Discord staked pairing).
- New: `arcade_ratings` (5.7), `arcade_match_sets` (5.8).

### Don't break

- `replayMoves` validation. The server is the source of truth for scores.
- The settlement signer flow on the wallet side. Result hash is signed and
  submitted on-chain — schema changes that affect what's hashed must
  bump the version.
- The deterministic seed → piece sequence. Two players in the same match
  must always see the same pieces.
- Idempotency of `supabase-schema.sql`. New tables/columns use `IF NOT
  EXISTS` / `OR REPLACE`. We replay it freely.

### Run / test loop

- `npm run dev` — tsx watch on the Node server.
- `npm run dev:web` — vite dev server for the wallet UI.
- `npm run build` — full prod build (server + web).
- No automated tests today. Manual verification: open two browsers / two
  Discord accounts, run through the flow.

### Hosting

Northflank free tier (per ops memory, migrated from Render 2026-05-06).
`render.yaml` still exists in the repo for reference but isn't the
deployment source.

### Migration policy

Every schema change ships with:
1. A new file in `migrations/YYYY-MM-DD_<slug>.sql`.
2. The same change appended to `supabase-schema.sql` so a fresh deploy
   gets it.

The bot does NOT auto-migrate. Migrations are run manually in the Supabase
SQL Editor by an operator.

---

## 7. Out of scope

- Anti-cheat beyond replay validation. Not a current threat vector.
- ELO/MMR for v2. (See 5.7 — wait for volume.)
- Mobile-native client. Browser is the form factor.
- Cross-chain wallet matchmaking (different chains can't share an escrow
  contract). Bucket by chain_id always.
- Discord guild-scoping. Matchmaking is global across all guilds the bot
  is in. Not changing this.

---

## 8. Open questions

1. **No-show forfeit on staked matches** — does the no-show forfeit still
   pay out the present player? Current intuition: yes, because they showed
   up and the AFK player accepted the stake. But this may anger people
   whose internet died. Consider: forfeit refunds the stake but counts as
   a loss in MMR. Decide before shipping 5.1 + 5.5.
2. **Lobby channel cardinality** — one global lobby channel per guild, or
   one per stake tier? Probably one global with tier buttons, but verify
   with a small community first.
3. **Rematch staking** — if Alice loses 1000 sats and clicks "Rematch",
   does the rematch button automatically re-stake 1000 sats, or default
   to free? Default to *same as the match that just ended* but require
   one explicit confirm tap.
4. **DM rate limits** — at scale, Discord rate-limits DM creation. We may
   need to batch DMs through a worker rather than fire-and-forget. Not a
   problem at current volume.

---

## 9. Definition of done — first slice (5.1)

- [ ] Migration shipped, schema additive.
- [ ] Match deadline derives from `play_started_at` once both players
      ringed in; falls back to `started_at` for non-matchmake matches.
- [ ] Players see a "Waiting for opponent..." state with a countdown to
      `ready_deadline` (default 60s).
- [ ] If `ready_deadline` passes with only one ready, the present player
      wins by walkover and the AFK player gets no settlement (free
      matches) or stake refunded with loss recorded (staked matches —
      pending decision in §8.1).
- [ ] Same logic applied to `web_arcade_sessions`.
- [ ] Manual test: create a match, only one player opens it within 60s,
      verify forfeit flow on both Discord and wallet sides.

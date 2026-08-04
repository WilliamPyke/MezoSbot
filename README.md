# MezoSbot

A Discord bot for depositing and using native SATS, MUSD, MEZO, and mUSDC on Mezo.

## Features

- **Link wallet**: Link your EVM address so deposits are credited to your Discord account
- **Deposit**: Send tBTC (or configured token) from your linked wallet to the bot's treasury
- **Withdraw**: Withdraw sats to any EVM address
- **Tip**: Send sats to another user
- **Distribute**: Split sats among multiple users (e.g. `@user1 @user2 @user3`)
- **Drop**: Create a drop — first N users to `/claim` get sats (rain/airdrop style)
- **Browser stream**: Built-in WebRTC viewer endpoint for low-latency cloud play
- **Auto snapshot recovery**: Emulator saves full state snapshots plus SRAM fallback and resumes from the latest snapshot after restarts/redeploys
- **imgnAI generation**: Generate SFW images with Katana and pay the exact model cost from your MUSD balance
- **Developer link relay**: Authorized developers can DM links to Mezo SBOT for attributed forwarding to their private thread or developer channel

## Setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → Create a Bot
3. Copy the **Bot Token** and **Application ID**
4. Enable **MESSAGE CONTENT INTENT** if needed
5. Invite the bot with scopes: `bot`, `applications.commands`

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID |
| `RPC_URL` | EVM RPC (e.g. `https://rpc.mezo.org`) |
| `CHAIN_ID` | Chain ID (Mezo mainnet: 31612) |
| `TOKEN_CONTRACT` | ERC20 token address (tBTC on Mezo: `0x18084fbA666a33d37592fA2633fD49a74DD93a88`) |
| `TOKEN_DECIMALS` | Token decimals (tBTC: 18) |
| `TREASURY_PRIVATE_KEY` | Private key of wallet that holds and sends funds |
| `STREAM_PORT` / `PORT` | HTTP port for viewer + signaling (Render sets `PORT`) |
| `STREAM_TARGET_FPS` | Stream encode target FPS (default `30`) |
| `STREAM_MIN_FPS` / `STREAM_MAX_FPS` | Auto-tuning floor/ceiling |
| `STREAM_AUTO_TUNE` | Enables adaptive FPS under load (`true`/`false`) |
| `STUN_SERVERS` | Comma-separated STUN servers for WebRTC |
| `PUBLIC_BASE_URL` | Public URL of this bot's HTTP server (used for Slice Arcade browser-play links). E.g. `https://mezosbot.example.com` or `mezosbot.example.com`. Defaults to `http://localhost:<STREAM_PORT>` for local dev. |
| `ARCADE_TOKEN_SECRET` | Optional HMAC secret for Slice Arcade browser tokens. Falls back to `TREASURY_PRIVATE_KEY` if unset. |
| `DEPOSIT_POLL_MS` | Deposit wallet chain polling interval (default `60000`) |
| `DEPOSIT_ALLOWED_ROLE_IDS` | Comma-separated Discord role IDs allowed to request/enable deposits; admins always bypass this check |
| `DEPOSIT_ADDRESS_REFRESH_MS` | Supabase address/checkpoint cache refresh interval (default `900000`) |
| `DEPOSIT_RPC_REQUESTS_PER_SECOND` | Maximum deposit balance reads per second across all poll workers (default `8`, below Mezo's public RPC limit) |
| `SWEEP_GAS_SPONSOR_PRIVATE_KEY` | Optional dedicated hot key for ERC-20 sweep and withdrawal gas; otherwise a separate wallet is deterministically derived from the treasury key |
| `PROTOCOL_GAS_RESERVE_MIN_SATS` | Protected operational SATS reserve; ERC-20 operations stop before crossing it (default `1000`) |
| `ERC20_SWEEP_DELAY_MS` | Delay before sweeping an ERC-20 deposit so nearby deposits can be combined (default `300000`) |
| `MUSD_MIN_DEPOSIT` | Public-user MUSD minimum; smaller deposits accumulate uncredited until the threshold (default `0.10`) |
| `MEZO_MIN_DEPOSIT` | Public-user MEZO minimum (default `1.00`) |
| `MUSDC_MIN_DEPOSIT` | Public-user mUSDC minimum (default `0.10`) |
| `IMGNAI_BASE_URL` | Katana agent API base URL (default `https://kat.imgnai.com`) |
| `IMGNAI_X402_TARGET_MUSD` | Target prepaid Katana wallet balance funded from treasury (default `1.00`) |
| `IMGNAI_MODEL_CACHE_MS` | Live model catalog cache duration (default `300000`) |
| `IMGNAI_IMAGE_TIMEOUT_MS` | Image polling deadline before background recovery (default `600000`) |
| `IMGNAI_PROMPT_MAX_LENGTH` | Maximum Discord prompt length (default `2000`) |

### 2.1 WebRTC Runtime Dependency

The browser stream server uses Node WebRTC (`@roamhq/wrtc`) at runtime.

```bash
npm install @roamhq/wrtc
```

If your host blocks native prebuilt downloads, install build tools or bake `@roamhq/wrtc` into your image during CI.

### 3. Fund the Treasury

The bot's treasury wallet must hold the token for withdrawals. Users deposit to this same address; the bot credits their balance when it sees transfers from **linked** wallets.

### 4. Install and Run

```bash
npm install
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `/link <address>` | Link your EVM wallet |
| `/deposit [token]` | Get your personal deposit address and token-specific instructions |
| `/balance` | Check all token balances |
| `/generate` | Configure and generate one Katana image paid from your MUSD balance |
| `/withdraw <amount> [address] [token]` | Withdraw a token to an address |
| `/swap <amount> <from> <to> [slippage] [onchain]` | Swap SATS ↔ MUSD ↔ mUSDC (inventory or Mezo Pools; on-chain gas from sats) |
| `/tip <user> <amount> [token] [message]` | Tip another user with an optional message |
| `/distribute <amount> <@users> [token]` | Split a token among multiple users |
| `/rain <amount> <count> [token] [role] [message]` | Rain a token on recently active users (optionally role-filtered) |
| `/rainban` | Manage server-wide banned words and phrases excluded from rain recipient searches |
| `/developer-relay set\|show\|disable` | Manage developer DM-to-channel link relay routes |
| `/drop <total> <per_claim> <max_claims> [role]` | Create a claimable drop (optionally role-gated) |
| `/claim <drop_id>` | Claim from an active drop |
| `/arcade practice [minutes]` | Solo block-puzzle warm-up — no stake |
| `/arcade challenge <user> [stake] [minutes]` | Challenge a specific user (omit stake for free PvP) |
| `/arcade offer [stake] [minutes]` | Post an open match offer anyone can accept |
| `/arcade offers` | Browse open match offers |
| `/arcade rules` | How the game works |
| `/arcade tiers` | Stake tiers |
| `/arcade leaderboard` | Top validated scores |

Recipients receive DMs when they are credited from tips, rains, distributions, and drop claims.

Token arguments are optional and default to native SATS, preserving the original command behavior.
Rain banned-word filtering requires `DISCORD_MESSAGE_CONTENT_INTENT=true` and the Message Content privileged intent enabled in Discord Developer Portal.

## Token swaps (`/swap`)

Apply `migrations/2026-08-03_token_swaps.sql` before enabling swaps.

Hybrid routing:

1. **Internal** — when free treasury inventory of the *output* token covers the fill (after liabilities and the protected SATS gas reserve). Instant, no network fee. Serialized with a Postgres advisory lock so concurrent fills cannot over-promise inventory.
2. **On-chain** — Mezo Pools router (`swapExactTokensForTokens`) when inventory is thin or the user passes `onchain:true`. Gas is reserved from the user's **SATS** balance (same pattern as ERC-20 withdrawals); unused gas is refunded after the receipt.

Supported pairs: SATS ↔ MUSD, MUSD ↔ mUSDC, and multi-hop SATS ↔ mUSDC. MEZO is not swappable until a liquid pool exists.

Safety controls: quote TTL, confirm button, slippage floor, daily per-user count/volume caps, SatQuest combat lock on SATS, crash recovery for `reserved`/`submitted` swaps, and optional background inventory rebalance (`SWAP_REBALANCE_ENABLED`).

| Variable | Description |
|----------|-------------|
| `SWAP_ENABLED` | Master switch (default `false` — enable after applying the swap migration) |
| `MEZO_POOLS_ROUTER` | Router address (default mainnet Mezo Pools router) |
| `MEZO_POOLS_FACTORY` | Pool factory address |
| `SWAP_QUOTE_TTL_MS` | Quote validity (default `45000`) |
| `SWAP_MAX_INTERNAL_FRACTION` | Max fraction of free inventory usable per internal fill (default `0.5`) |
| `SWAP_MAX_PER_DAY` / `SWAP_MAX_VOLUME_SATS_PER_DAY` | Per-user daily limits |
| `PROTOCOL_GAS_RESERVE_MIN_SATS` | Protected SATS not available as internal inventory |

## Developer link relay

Apply `migrations/2026-07-28_developer_relay.sql` before configuring relay routes. The bot requires **View Channel**, **Send Messages**, and **Embed Links** in the developer channel, plus **Send Messages in Threads** and access to each configured private thread.

A server manager configures a developer with:

```text
/developer-relay set developer:@alice thread:#alice-private
```

The `channel:` destination posts to the selected private thread's parent text channel. That channel is saved with the developer's relay route when `/developer-relay set` is run.

The developer can then DM a message containing an `http://`, `https://`, or `www.` link to Mezo SBOT. A normal DM is forwarded to the configured private thread. Prefixing the DM with `channel:` sends it to the developer channel; `thread:` selects the private thread explicitly.

Forwarded messages identify the original developer, suppress all Discord mentions, are limited to five per minute per developer, and are recorded by source and destination message ID for duplicate-delivery protection. If the server's link filter also scans bot messages, exempt the Mezo SBOT role or the configured relay destinations.

## imgnAI Katana Generation

Apply `migrations/2026-07-13_imgnai_katana.sql`, then `migrations/2026-07-13_imgnai_atomic_musd.sql`, `migrations/2026-07-13_protocol_operations.sql`, `migrations/2026-07-16_imgnai_reconciliation_safety.sql`, and `migrations/2026-07-31_imgnai_musd_atomic_writes.sql`, after the multi-token migration before enabling `/generate`. The atomic migration backfills exact 18-decimal MUSD units and keeps the legacy floating columns only as compatibility mirrors. The operations migrations add delayed sweeps, gas-funding audit records, solvency metrics, and terminal-state safeguards for refunded generations. The final migration keeps older token balance and withdrawal RPCs on the atomic MUSD column. The bot uses the existing Mezo mainnet treasury signer and MUSD contract; no imgnAI API key is required.

- `/generate` opens a private setup with prompt, SFW model, aspect ratio, quality, live MUSD price, and balance.
- The confirmed amount is atomically reserved from the user's internal MUSD balance. The public progress message is edited into the final downloadable image.
- Katana's x402 wallet balance is checked before each job and replenished from swept treasury MUSD when it cannot cover the request.
- Katana quotes, reservations, top-ups, charges, and refunds use exact 18-decimal atomic MUSD integers end-to-end.
- x402 top-ups remain facilitator-sponsored. Ordinary ERC-20 deposit sweeps use the dedicated sweep-gas sponsor and stop if its protected reserve would be crossed.
- Public ERC-20 deposits enforce configured minimums and are swept after a durable delay; admins bypass the public minimums for testing.
- `/admin` → **imgnAI Models** lets Manage Server users disable or re-enable current and legacy SFW models for that server. New SFW catalog models default to enabled.
- Validation and pre-payment failures refund immediately. Paid provider failures remain pending until Katana confirms the refund; policy/Terms violations may remain charged.
- Jobs, polling, delivery, and refunds resume after restarts. Completed prompts are redacted from job records after 72 hours.

**All amounts use sats** and support decimals (e.g. `100.5`, `0.25`) for easier denomination. Precision: 6 decimal places.

## Slice Arcade — head-to-head block puzzle

A 9×9 block puzzle PvP game. **Matchmaking happens in Discord; the match itself plays in your browser.** Both players get the same seeded piece sequence; highest validated score wins.

- `/arcade practice` replies with a private link that opens the playfield in your browser. Matches default to 3 minutes; pass `minutes:5` for a longer game, up to 5 minutes.
- `/arcade challenge @opponent` posts a challenge card only that opponent can accept. Add `stake:1000` (or any positive sats amount) to escrow that amount from each player. Free PvP omits the stake. Add `minutes:1` through `minutes:5` to change the time limit.
- `/arcade offer stake:100` posts an open offer. `/arcade offers` shows current open offers with accept buttons. The first accepting user is matched; everyone else is locked out by the match status update.
- When the opponent accepts, each player gets a per-user signed link (DM if their DMs are open, plus the **Open browser playfield** button on the match card). Open the link and play: pick a piece, click a board cell to place. End-of-match auto-detects no-legal-moves or 12 levels complete.
- Every move is server-validated. The browser is a thin client that POSTs `{pieceIndex, rotation, row, col}` to `/arcade/api/move` — the server is the source of truth for board, score, multiplier, and the match timer.
- Stakes are debited from each player's `/balance`. On settle, the winner is credited and ties refund both stakes. Backend platform accounting is recorded in `arcade_fees`, with aggregate totals exposed by the `arcade_fee_totals` view. The public Discord match card refreshes automatically when the match settles.

The deterministic engine and scoring live in `src/arcade/`. Match runtime state is reconstructible from a seed + move log, so a bot restart can recover any in-progress match. Set `PUBLIC_BASE_URL` (e.g. `https://your-bot.example.com`) so the bot can build absolute browser-play URLs; defaults to `http://localhost:<STREAM_PORT>` for local dev.

## Wallet Arcade Escrow

`play.mallard.sh` is implemented as a wallet-first web app in `web/` and served by the existing Node HTTP server after `npm run build`. Discord arcade sessions remain separate from wallet sessions; wallet play uses `/api/web/*` routes and the `web_arcade_*` Supabase tables.

- New sessions can be created on Mezo mainnet chain `31612` or testnet chain `31611`; each session stores its own chain and escrow contract address.
- Supported escrow assets are native BTC, BTC precompile/ERC-20 path, MUSD, and MEZO.
- The frontend uses RainbowKit, wagmi, viem, and React Query for wallet connection, login signatures, session creation, joins, approvals, gameplay, and settlement links.
- The backend signer settles validated matches through `MallardGameEscrow`; ties and approved refunds call the refund path.

Additional environment:

| Variable | Description |
|----------|-------------|
| `MEZO_DEFAULT_NETWORK` | Default network selected by the wallet arcade UI: `mainnet` or `testnet` |
| `MEZO_MAINNET_RPC_URL` / `MEZO_TESTNET_RPC_URL` | RPC URLs used by the backend settlement signer |
| `ESCROW_MAINNET_CONTRACT_ADDRESS` / `ESCROW_TESTNET_CONTRACT_ADDRESS` | Deployed `MallardGameEscrow` address for each network |
| `ESCROW_CONTRACT_ADDRESS` | Backward-compatible fallback for single-network deployments |
| `ESCROW_ADMIN_ADDRESS` | Deploy-time admin address that can update contract config and roles |
| `ESCROW_SETTLER_ADDRESS` | Deploy-time public address for the backend settlement signer |
| `ESCROW_SETTLER_PRIVATE_KEY` | Private key with `SETTLER_ROLE` for validated settlement |
| `ESCROW_TREASURY_ADDRESS` | Treasury address receiving platform fees |
| `ESCROW_PLATFORM_FEE_BPS` | Platform fee in basis points, default `1000` |
| `WALLETCONNECT_PROJECT_ID` | WalletConnect project ID for RainbowKit |
| `WEB_SESSION_SECRET` | HMAC secret for wallet login cookies |

Contract package:

```bash
npm run test:contracts
npm run deploy:contracts -- --network mezoTestnet
```

## How Deposits Work

1. User runs `/link 0xYourAddress` to link their wallet
2. User runs `/deposit` to get the treasury address
3. User sends tokens **from their linked wallet** to the treasury
4. The bot watches for `Transfer` events to the treasury from linked addresses
5. When detected, the user's balance is credited

**Important**: Only transfers from **linked** wallets are credited. Unlinked transfers are ignored.

## Network Configuration

Default config targets **Mezo mainnet** (tBTC). To use another EVM chain:

- Set `RPC_URL` and `CHAIN_ID` for your chain
- Set `TOKEN_CONTRACT` to the ERC20 address (or native ETH with minor code changes)
- Adjust `TOKEN_DECIMALS` (8 for WBTC-style, 18 for most ERC20s)

## Browser Stream Endpoints

- Viewer: `/`
- Health: `/healthz`
- Metrics: `/metrics`
- Signaling: `POST /api/webrtc/offer`

## Cloud Fallback Split

If Render cannot reach your latency target, keep this bot/emulator service on Render and move only media publishing to a dedicated low-latency worker. See `docs/streaming-fallback.md`.

## License

MIT

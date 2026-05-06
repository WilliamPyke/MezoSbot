# MezoSbot

A Discord bot for depositing sats from an EVM network (Mezo), and tipping, distributing, and dropping them to other users.

## Features

- **Link wallet**: Link your EVM address so deposits are credited to your Discord account
- **Deposit**: Send tBTC (or configured token) from your linked wallet to the bot's treasury
- **Withdraw**: Withdraw sats to any EVM address
- **Tip**: Send sats to another user
- **Distribute**: Split sats among multiple users (e.g. `@user1 @user2 @user3`)
- **Drop**: Create a drop — first N users to `/claim` get sats (rain/airdrop style)
- **Browser stream**: Built-in WebRTC viewer endpoint for low-latency cloud play
- **Auto snapshot recovery**: Emulator saves full state snapshots plus SRAM fallback and resumes from the latest snapshot after restarts/redeploys

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
| `DEPOSIT_POLL_MS` | Deposit wallet chain polling interval (default `15000`) |
| `DEPOSIT_ADDRESS_REFRESH_MS` | Supabase address-list cache refresh interval (default `300000`) |

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
| `/deposit` | Get deposit address and instructions |
| `/balance` | Check your sats balance |
| `/withdraw <amount> <address>` | Withdraw sats to an address |
| `/tip <user> <amount> [message]` | Tip another user with an optional message |
| `/distribute <amount> <@users>` | Split sats among multiple users |
| `/rain <amount> <count> [role] [message]` | Rain sats on recently active users (optionally role-filtered) |
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

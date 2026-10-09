# Custody v2 runbook

This is the owner's checklist for moving MezoSBOT to custody v2 and running it
afterwards. Balances stay an off-chain ledger in Supabase; the chain is only
touched for deposits, withdrawals and imgnAI top-ups.

## How it fits together

| Piece | What it is | Where its key lives |
| --- | --- | --- |
| Vault (`VAULT_ADDRESS`) | Holds the reserves. Every deposit sweep lands here. | Offline: a Safe whose owners are hardware wallets, or a hardware wallet. Never on the server. |
| DepositFactory + forwarders | One CREATE2 deposit address per user. No key exists for it; its funds can only be swept to the vault. Anyone may trigger a sweep. | None |
| HotPayout (`HOT_PAYOUT_ADDRESS`) | A small withdrawal float with a per-transaction cap and a daily cap per token. The daily cap is a leaky bucket: spending drains back at the daily cap per 24 hours, so `remainingDaily(token)` is the authoritative headroom. Each withdrawal reference can be paid once. | Holds no key; roles below |
| Operator (`PAYOUT_OPERATOR_PRIVATE_KEY`) | Signs `payNative` / `payToken` for withdrawals, inside the caps. | Server. Holds gas only. |
| Sweep gas (`SWEEP_GAS_PRIVATE_KEY`) | Pays gas for `sweepNative` / `sweepToken`. | Server. Holds gas only. |
| Guardian (`PAYOUT_GUARDIAN_PRIVATE_KEY`, optional on the server) | Can only pause HotPayout and tighten caps. With its key on the server the watchdog pauses HotPayout automatically; a leaked guardian key can do no more than pause or tighten. | Server, or your own device (then pause by hand when the watchdog DMs you) |
| imgnAI payer (`IMGNAI_PAYER_PRIVATE_KEY`) | Pays x402 top-ups, capped per top-up and per 24h. It only ever signs an exact-amount MUSD transfer authorization (no approvals or permits). Without a valid, uncompromised key, image generation is paused; no other key is used instead. | Server. Small MUSD float. |
| Deployer (`DEPLOYER_PRIVATE_KEY`) | Deploys the two contracts once; has no role afterwards. | Your machine, once |

What the bot proves before it changes a balance:

- **Deposits are credited only from `Swept` events** of the configured factory,
  read `DEPOSIT_CONFIRMATIONS` blocks behind the head, once per
  (transaction, log index), and only when the event's vault is `VAULT_ADDRESS`
  and its salt belongs to a user with deposits enabled. Anything else is
  recorded in `custody_sweep_reviews` and never credited.
- **A withdrawal completes only** when a HotPayout `Paid` log for its
  reference shows exactly the token, recipient and amount the bot signed, in
  the transaction the bot recorded for that withdrawal (its own receipt, or a
  log search by reference). `paid(ref)` alone is never enough, and neither is
  a matching log in any other transaction. It is **refunded only** when
  nothing was broadcast, or the transaction reverted or was replaced, **and**
  `HotPayout.paid(ref)` reads false; `paid(ref)` is read before anything is
  signed. A paid reference without that proof is held for manual review and
  freezes custody (below). Each withdrawal has one
  reference for life; a stored signed transaction may be rebroadcast but is
  never re-signed with a new reference.
- **Withdrawals never go to** a deposit address (current or retired), the
  vault, the factory, its implementation, HotPayout, the operator or guardian
  wallet, or a known-compromised address. HotPayout itself also rejects those
  recipients and a zero reference.
- **Every signature by a custody key is recorded before broadcast**
  (`custody_signed_txs`, every signed hash kept). From nonce 0, every nonce a
  key has spent must have a record, and a recorded transaction for it must
  have a receipt. The watchdog freezes custody otherwise, or when HotPayout
  pays anything that does not match a pending or completed withdrawal's signed
  call in that withdrawal's own transaction.
- **Backing** is read only from the vault and HotPayout under v2 (from the
  treasury only in legacy mode with an uncompromised key). While custody is
  paused or v2 is not verified yet, nothing counts as backing, so instant
  swaps, imgnAI top-ups and SATS credits (`/credit`) refuse; `/treasury` and
  the imgnAI admin panel say so. Funds still sitting at old (v1) deposit
  addresses never count as backing outside legacy mode.
- **Deposits are credited once per (transaction, deposit address, token).**
  The same amount read again is a duplicate (whatever log index the node
  reports); a second event with that key but a different amount is not
  credited and goes to review.
- **The per-user daily withdrawal cap** (`WITHDRAWAL_USER_DAILY_MAX_SATS`) is a
  soft check that runs before the debit, outside `reserve_withdrawal_v2`;
  HotPayout's on-chain per-transaction and daily caps are the hard limit.

## 1. Generate keys offline

On a machine you trust, generate fresh keys for every server role and the
deployer. Do not reuse the old treasury key, any key derived from it, or any
key that was ever stored with it.

```
node scripts/generate-custody-keys.mjs --out <a path OUTSIDE the repository>
```

It writes `PAYOUT_OPERATOR_PRIVATE_KEY`, `SWEEP_GAS_PRIVATE_KEY`,
`PAYOUT_GUARDIAN_PRIVATE_KEY`, `IMGNAI_PAYER_PRIVATE_KEY` and
`DEPLOYER_PRIVATE_KEY` to that file and prints only the addresses. Move each
key into its Northflank secret (step 4), then delete the file. The custody
keys must be fresh: the watchdog checks every nonce from 0, so a key that sent
any transaction before custody started freezes custody ("used before custody
started"). Only fund them; never send from them. The bot refuses to start
custody v2 if two roles share a key, if a role key equals
`TREASURY_PRIVATE_KEY`, `ESCROW_SETTLER_PRIVATE_KEY`,
`IMGNAI_PAYER_PRIVATE_KEY`, `SWEEP_GAS_SPONSOR_PRIVATE_KEY` or the v1 sweep
sponsor derived from the treasury key, if any key is known to be compromised
(the imgnAI payer included), or if the vault is the address of any server key.

## 2. Choose the vault

Prefer a Safe on Mezo mainnet with two or more owners, each a hardware wallet.
A single hardware wallet also works. The vault:

- receives every deposit sweep (the factory has it fixed at deploy);
- is the only account that can unpause HotPayout, loosen caps, change the
  operator or guardian, change the allowlists, or pull the float back
  (`recover`, which can only send to the vault).

Write its address down; you need it for the deploy and for `VAULT_ADDRESS`.

## 3. Deploy the contracts

Fund the deployer address with a little BTC for gas, then dry-run:

```
VAULT_ADDRESS=0x... PAYOUT_OPERATOR_ADDRESS=0x... PAYOUT_GUARDIAN_ADDRESS=0x... \
DEPLOYER_PRIVATE_KEY=0x... npm run deploy:custody -- --network mezoMainnet
```

The dry run validates the roles (vault, operator and guardian must be three
different addresses; HotPayout always has a guardian even if its key never
goes on the server), checks the token contracts and prints the plan,
including the caps. Cap settings (defaults in brackets):

| Variable | Default |
| --- | --- |
| `PAYOUT_NATIVE_PER_TX_SATS` / `PAYOUT_NATIVE_DAILY_SATS` | 100000 / 300000 sats |
| `PAYOUT_MUSD_PER_TX` / `PAYOUT_MUSD_DAILY` | 50 / 150 MUSD |
| `PAYOUT_MUSDC_PER_TX` / `PAYOUT_MUSDC_DAILY` | 50 / 150 mUSDC |
| `PAYOUT_MEZO_PER_TX` / `PAYOUT_MEZO_DAILY` | 0 / 0 (MEZO not paid out) |

0/0 leaves a token out of payouts. Start small: the caps bound what the
operator key can ever move per day.

When the plan is right, run it again with `CONFIRM_DEPLOY=yes`. The script
reads everything back from chain and prints the bot environment:
`VAULT_ADDRESS`, `DEPOSIT_FACTORY_ADDRESS`, `DEPOSIT_FORWARDER_IMPLEMENTATION`,
`HOT_PAYOUT_ADDRESS` and `DEPOSIT_FACTORY_START_BLOCK` (the factory's deploy
block; HotPayout is deployed after it). If it reports a mismatch, do not
configure the bot with those contracts.

## 4. Database

Apply in the Supabase SQL editor, staging first, with
`SET lock_timeout = '5s';` and `deploy/preflight.sql` / `deploy/verify.sql`
around it (see `deploy/README.md`):

1. `migrations/2026-10-09_lockdown_public_access.sql`, if not applied yet.
2. `migrations/2026-10-10_custody_v2.sql`.

The custody migration is re-runnable. It moves every old deposit address to
`deposit_addresses.legacy_address` and clears `address` (NULL means no safe
address has been issued yet), so neither the bot nor the deposit page shows
an old address again. It expires wallet-verification challenges that point at
an old address, adds the custody tables (RLS on, service_role only), and only
then lets the deposit page read `deposit_addresses(discord_id, address)`
again. A user's new address appears the next time the bot registers them
(for example `/deposit`).

The migration refuses to run (and changes nothing) if `custody_signed_txs`,
`custody_forwarder_credits` or `custody_sweep_reviews` already exist with
different keys than it expects, for example from an earlier draft; the error
names the table. Migrate or drop such a table deliberately, then re-run.

## 5. Northflank environment

Set on the bot service:

| Variable | Value |
| --- | --- |
| `VAULT_ADDRESS` | the vault |
| `DEPOSIT_FACTORY_ADDRESS`, `DEPOSIT_FORWARDER_IMPLEMENTATION`, `HOT_PAYOUT_ADDRESS` | from the deploy |
| `DEPOSIT_FACTORY_START_BLOCK` | the factory deploy block |
| `PAYOUT_OPERATOR_PRIVATE_KEY`, `SWEEP_GAS_PRIVATE_KEY` | secrets from step 1 |
| `PAYOUT_GUARDIAN_PRIVATE_KEY` | optional secret; enables automatic pause on a freeze. You may instead keep the guardian key on your own device and pause by hand when the watchdog DMs you |
| `IMGNAI_PAYER_PRIVATE_KEY` | secret from step 1 |
| `WITHDRAWALS_ENABLED` | `false` for the first boot |
| `DEPOSIT_CONFIRMATIONS` (2), `DEPOSIT_V2_MIN_NATIVE_SATS` (1000), `CUSTODY_WATCHDOG_MS` (60000), `CUSTODY_LOW_GAS_SATS` (1000), `CUSTODY_LOG_CHUNK_BLOCKS` (2000), `CUSTODY_DEEP_RESCAN_PASSES` (60), `CUSTODY_DEEP_RESCAN_BLOCKS` (5000), `WITHDRAWAL_USER_DAILY_MAX_SATS` (200000), `IMGNAI_X402_MAX_TOPUP_MUSD` (5), `IMGNAI_X402_DAILY_MAX_MUSD` (20) | defaults shown; adjust if needed |
| `IMGNAI_X402_PAY_TO` | imgnAI's x402 payment address. **Set it before enabling image generation**: without it, the first top-up trusts whatever address imgnAI's server asks to be paid. When set, a top-up paying any other address is refused. When unset, the first completed top-up's address is recorded and any later top-up to a different address is refused (admins get a DM) |

Remove `TREASURY_PRIVATE_KEY` and `SWEEP_GAS_SPONSOR_PRIVATE_KEY`. Custody v2
never uses them; legacy rows that are still pending are then listed for
manual review instead of being observed. Point `ESCROW_TREASURY_ADDRESS` at
the vault.

## 6. Fund the wallets

From the vault:

- **Operator**: a little BTC for gas (each withdrawal is one contract call).
- **Sweep gas**: a little BTC for gas (one call per swept asset).
- **Guardian** (if its key is on the server): enough BTC for one `pause()`.
- **HotPayout float**: native BTC and the payout tokens, sized to roughly one
  or two days of withdrawals and never above what you can afford to lose. Send
  them to `HOT_PAYOUT_ADDRESS` like any transfer.
- **imgnAI payer**: a small MUSD float (a few top-ups). Set
  `IMGNAI_X402_PAY_TO` to imgnAI's published x402 payment address before
  funding it, so the first top-up cannot be sent elsewhere.

Admins get a DM when the operator, sweep-gas or guardian wallet drops below
`CUSTODY_LOW_GAS_SATS`. `/deposit sponsor:true` shows the sweep-gas address.

Backing is measured as vault + HotPayout balances against everything owed to
users. While SATS backing is short, SATS withdrawals and SATS credits
(`/credit`) stay blocked, and instant swaps cannot pay out a token whose
backing is short; `/treasury` shows the shortfall. The old treasury wallet is
not counted.

## 7. First boot and checks

Deploy the `TestingRender` build. The log must show `[Custody] Mode v2: vault
…`. If it shows `[Custody] PAUSED`, the reasons follow on the same line or the
next ones (missing or invalid variables, a shared key, or an on-chain mismatch
such as the wrong operator); fix them and restart. An unreachable RPC is
retried every minute.

Then, as an admin:

1. `/treasury` or `/custody status`: mode v2, vault and HotPayout balances,
   remaining daily limits, gas wallet balances.
2. `/deposit`: a small native deposit to the shown address. Within a few
   minutes the bot sweeps it (`[Deposits] Sweeping SATS ...`) and credits it
   from the `Swept` event (`[Deposits] Credited ...`). The vault balance grows.
   After its first sweep a deposit address is a small contract that needs
   about 24,000 gas to receive BTC; senders with a fixed 21,000 gas limit
   (some exchanges) fail and the BTC stays with the sender. `/deposit` tells
   users to send from a normal wallet. A sweep of an empty address does
   nothing and credits nothing.
3. Set `WITHDRAWALS_ENABLED=true`, restart, and withdraw a small amount to a
   wallet you control. `/withdraw` refuses with the remaining on-chain
   capacity when a cap or the float would be exceeded; nothing is debited then.

## Day-to-day operations

**Refill the float.** Send BTC or tokens from the vault to `HOT_PAYOUT_ADDRESS`.
`/treasury` shows the float and what each cap still allows today.

**Pull float back.** From the vault, call `HotPayout.recover(token, amount)`
(`token` is `0x0000000000000000000000000000000000000000` for BTC). It can only
send to the vault.

**Caps.** The vault calls `setCaps(token, perTx, daily)` to raise or lower
them; the guardian can only lower them with `tightenCaps`.

**Pause / unpause.** The guardian or the vault can call `pause()`; only the
vault can `unpause()`. While paused, `/withdraw` refuses before debiting.

**Rotate the operator.** Generate a new key, fund it with gas, have the vault
call `setOperator(newOperator)`, update `PAYOUT_OPERATOR_PRIVATE_KEY`, restart.
The boot check confirms `operator()` matches the key. Withdrawals signed by
the old operator are still recovered (each row stores its signer). Rotating
the guardian is the same with `setGuardian`. The sweep-gas key has no
contract role: swap the secret, fund the new address, restart.

**Watchdog freeze.** Custody freezes when a custody key spent a nonce the bot
never recorded, when a spent nonce's recorded transactions have no receipt
(another transaction took the nonce), when HotPayout paid something that does
not match a pending or completed withdrawal in that withdrawal's own
transaction (including any payment for an already refunded withdrawal), or
when a withdrawal's reference reads as paid without that proof (for example
another party paid that reference to a different address). The watchdog also
re-reads `paid(ref)` for each refunded HotPayout withdrawal until it has read
false at least 3 times over at least an hour; the row is then marked verified
in `custody_refund_checks` and not read again (a later payment for its
reference is still caught by the `Paid` scan). These reads go through
Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, 25 per call,
falling back to single calls), run after the nonce and `Paid` checks with a
10-second budget per pass, and failed reads are logged and retried. Every
anomaly has an id (`paid:<tx>:<log>`, `withdrawal:<id>`,
`nonce:<signer>:<n>`) that is DM'd to admins and recorded on the freeze,
including anomalies found while already frozen. A freeze blocks
every operator, sweep-gas, guardian and imgnAI payer signature in every bot
process (the flag is stored in `bot_settings` as `custody_frozen` and
survives restarts), DMs every `ADMIN_IDS` user, and, with the guardian key on
the server, pauses HotPayout. Deposits keep being credited
from `Swept` events; `/withdraw` refuses. To recover:

1. Read the reason in the DM or `/custody status`. Compare the key's
   transactions on the explorer with
   `SELECT * FROM custody_signed_txs WHERE signer = lower('0x…') ORDER BY nonce DESC;`.
2. If a key may be exposed, rotate it (above) before anything else.
3. Run `/custody unfreeze note:<what you found and fixed>`. It first re-runs
   every check up to the chain head (nonces, `Paid` events since the last
   checked block, refunded withdrawals) and compares the findings with the
   anomalies recorded on the freeze. If it finds anything that was not
   recorded (nobody was shown it), custody stays frozen and the reply lists
   each new anomaly (kind, withdrawal id, reference, transaction, block) with
   a confirmation code for exactly that set. Review them, then run
   `/custody unfreeze note:<…> confirm:<code>`; if the set changed in the
   meantime you get the new list and a new code instead. If a check cannot be
   read (RPC or database error), nothing is accepted. On success the reply
   lists every acknowledged anomaly id, and everything up to now is accepted
   so the same findings do not freeze custody again: each key's nonces up to
   its current nonce, HotPayout `Paid` events up to the head (by the regular,
   trailing and deep rescans alike), and the anomalies themselves, recorded in
   `custody_acknowledgements` with your note. Those stay held for manual
   review and are never refunded or completed automatically. Anything new
   after the unfreeze freezes custody again.
4. If HotPayout was paused, `unpause()` from the vault.

**Deposits held for review.**
`SELECT * FROM custody_sweep_reviews WHERE status = 'open';` lists swept funds
that were not credited: `unknown_salt` (no bot user), `unknown_token`,
`wrong_vault`, or `conflicting_event` (a second event for an already credited
transaction, address and token with a different amount). Admins
get a DM for each new one. The funds are in the vault. After checking, credit
the user with `/credit` if appropriate and mark the row `resolved` with a
note. A sweep of a registered user's address is always credited, even if
their deposits were never enabled: the deposit role gate controls who is
shown an address, not what is credited once funds have reached the vault.

**Log scanners.** The Swept and Paid scanners read each block range only once
the RPC node serves it, re-read a short trailing window every pass, and every
`CUSTODY_DEEP_RESCAN_PASSES` passes re-read the last
`CUSTODY_DEEP_RESCAN_BLOCKS` blocks. Re-reading is idempotent.

**Withdrawals held for review.** Recovery logs `MANUAL REVIEW withdrawal <id>`
for rows it will not settle automatically, for example a successful receipt
without the matching `Paid` log. Such rows are never refunded or completed
automatically; settle them by hand after checking the chain.

**Old deposit addresses.** Addresses issued before custody v2 are never shown
again and are not polled. Funds sent to one are not credited.

**Run a single bot instance.** Several safeguards serialize in-process: the
withdrawal and sweep signing locks, the imgnAI top-up lock and the rolling
imgnAI and per-user withdrawal caps (which read recent rows, then act). Two
instances at once (for example a deploy overlap) cannot double-pay a
withdrawal (HotPayout pays each reference once), but they can briefly exceed
the soft caps or make one instance's transaction replace the other's. Keep
Northflank at one replica for the bot service.

**Unfreeze edge cases.**

- If a new anomaly is recorded while `/custody unfreeze confirm:` is being
  accepted, custody stays frozen (and the new anomaly is DMed), but the scan
  cursors and the accepted floor have already moved to the head. Review the
  DMed anomaly, then unfreeze again.
- `Paid` anomaly ids include the log index. If the RPC behind a load balancer
  numbers logs differently between calls, the confirmation code can change
  between the dry run and the confirm; run the command again with the new code
  (or pin `RPC_URL` to a single node while unfreezing).
- Unfreeze re-checks every refunded withdrawal that is not yet verified. With
  very many of them (thousands) it can time out; wait for the watchdog to
  verify them (3 false reads over an hour each) and retry.
- When the per-pass refund-check budget runs out, the last batch read finishes
  in the background; at most one such read per pass.

## Legacy mode

Without any custody v2 variable, a valid `TREASURY_PRIVATE_KEY` that is not a
known-compromised address runs the previous single-hot-wallet behaviour. Use
it for development and testnet only. Any other configuration runs paused:
balances, tips and games work; on-chain deposits and withdrawals do not.

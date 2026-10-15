# Custody v2 runbook

This is the owner's checklist for moving MezoSBOT to custody v2 and running it
afterwards. Balances stay an off-chain ledger in Supabase; the chain is only
touched for deposits, withdrawals and imgnAI top-ups.

## How it fits together

| Piece | What it is | Where its key lives |
| --- | --- | --- |
| Vault (`VAULT_ADDRESS`) | Holds the reserves (or, with `DEPOSITS_TO_HOT_PAYOUT=true`, only administers HotPayout). It is HotPayout's admin and the DepositFactory's admin. Its own powers are delayed (see "Queued vault actions"). | Offline: a Safe whose owners are hardware wallets, a hardware wallet, or (direct mode) any wallet you own that is not on the server. Never on the server. |
| DepositFactory + forwarders | One CREATE2 deposit address per user. No key exists for it; its funds can only be swept to the deposit target. Anyone may trigger a sweep. The admin can add tokens to the sweep allowlist (never remove them) and hand tokens that are not allowlisted, sent to a deposit address by mistake, to itself. | None |
| HotPayout (`HOT_PAYOUT_ADDRESS`) | The withdrawal float with a per-transaction cap and a daily cap per token. The daily cap is a leaky bucket: spending drains back at the daily cap per 24 hours, so `remainingDaily(token)` is the authoritative headroom. Each withdrawal reference can be paid once. It never pays the factory, its implementation or a deployed deposit address. | Holds no key; roles below |
| Operator (`PAYOUT_OPERATOR_PRIVATE_KEY`) | Signs `payNative` / `payToken` for withdrawals, inside the caps. | Server. Holds gas only. |
| Sweep gas (`SWEEP_GAS_PRIVATE_KEY`) | Pays gas for `sweepNative` / `sweepToken`. | Server. Holds gas only. |
| Guardian (`PAYOUT_GUARDIAN_PRIVATE_KEY`, optional on the server) | Can only pause HotPayout, tighten caps and cancel queued vault actions (except a new guardian, which only the vault can cancel). With its key on the server the watchdog pauses HotPayout automatically and `/custody cancel` works; a leaked guardian key can do no more than pause, tighten or cancel. | Server, or your own device (then pause and cancel by hand when the watchdog DMs you) |
| imgnAI payer (`IMGNAI_PAYER_PRIVATE_KEY`) | Pays x402 top-ups, capped per top-up and per 24h. It only ever signs an exact-amount MUSD transfer authorization (no approvals or permits). Without a valid, uncompromised key, image generation is paused; no other key is used instead. | Server. Small MUSD float. |
| Deployer (`DEPLOYER_PRIVATE_KEY`) | Deploys the two contracts once; has no role afterwards. | Your machine, once |

What the bot proves before it changes a balance:

- **Deposits are credited only from `Swept` events** of the configured factory,
  read `DEPOSIT_CONFIRMATIONS` blocks behind the head, once per
  (transaction, log index), and only when the event's vault is the deposit
  target (`VAULT_ADDRESS`, or `HOT_PAYOUT_ADDRESS` with `DEPOSITS_TO_HOT_PAYOUT=true`)
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
- **Backing** is read only from the vault and HotPayout under v2 (HotPayout
  alone with `DEPOSITS_TO_HOT_PAYOUT=true`; from the treasury only in legacy mode with an uncompromised key). While custody is
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
  operator, guardian or vault, add factory tokens, or pull the float back
  (`proposeRecover` / `applyRecover`, which can only send to the vault).
  Everything that loosens control waits after it is queued: 2 days for a vault
  handover, 4 for a new guardian, 3 for anything else.

Write its address down; you need it for the deploy and for `VAULT_ADDRESS`.

### Option: deposits straight into HotPayout (no vault signing)

Deploy with `DEPOSITS_TO_HOT_PAYOUT=yes` to make HotPayout itself the factory's
deposit target. Deposits then refill withdrawals automatically, as the old
treasury did, and nobody signs anything day to day. `VAULT_ADDRESS` becomes
only the admin of HotPayout and the factory. It can be any wallet you own that
is not on the server, and its balance is not counted as backing.

The trade-off: every reserve sits in HotPayout. What the caps bound, exactly:

- The daily cap is the most the operator key can pay out at once, so set it to
  an amount you would accept losing, not to a day of normal withdrawals plus
  slack.
- Until HotPayout is paused, the bucket refills at the daily cap per 24 hours:
  up to 2 x the daily cap in any 24-hour window. Keep the guardian and the vault
  funded with a little gas so a pause always goes through.
- A stolen vault key cannot move anything quickly: every recovery, cap
  increase and role change is queued (2 days for a vault handover, 4 for a
  new guardian, 3 otherwise), and the
  guardian cancels at once any queued action no admin approved with
  `/custody expect`. Hand the vault to a fresh wallet once you notice (see
  "If the vault key may be exposed").
- A lost vault key cannot be replaced. Payouts continue within the caps, but a
  pause can then never be undone. Keep an offline backup of the vault key.

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
| `PAYOUT_NATIVE_PER_TX_SATS` / `PAYOUT_NATIVE_DAILY_SATS` | 80000 / 150000 sats |
| `PAYOUT_MUSD_PER_TX` / `PAYOUT_MUSD_DAILY` | 15 / 30 MUSD |
| `PAYOUT_MUSDC_PER_TX` / `PAYOUT_MUSDC_DAILY` | 0 / 0 (mUSDC not paid out) |
| `PAYOUT_MEZO_PER_TX` / `PAYOUT_MEZO_DAILY` | 0 / 0 (MEZO not paid out) |

0/0 leaves a token out of payouts. Start small: the daily cap is what a stolen
operator key can pay out at once, and twice it is the most it can pay in any
24 hours if nobody pauses.

The factory is deployed first, aimed at the address HotPayout will get from
the deployer's next nonce (with `DEPOSITS_TO_HOT_PAYOUT=yes`), and HotPayout
records the factory so it never pays the factory, its implementation or a
deployed deposit address. Send nothing from the deployer while the deploy runs.

When the plan is right, run it again with `CONFIRM_DEPLOY=yes`. The script
reads everything back from chain and prints the bot environment:
`VAULT_ADDRESS`, `DEPOSIT_FACTORY_ADDRESS`, `DEPOSIT_FORWARDER_IMPLEMENTATION`,
`HOT_PAYOUT_ADDRESS`, `DEPOSITS_TO_HOT_PAYOUT` and `DEPOSIT_FACTORY_START_BLOCK`
(the earlier of the two deploy blocks). If it reports a mismatch, do not
configure the bot with those contracts.

## 4. Database

Apply in the Supabase SQL editor, staging first, with
`SET lock_timeout = '5s';` and `deploy/preflight.sql` / `deploy/verify.sql`
around it (see `deploy/README.md`):

1. `migrations/2026-10-09_lockdown_public_access.sql`, if not applied yet.
2. `migrations/2026-10-10_custody_v2.sql`.
3. `migrations/2026-10-15_custody_v3_bot.sql`, before the bot build that uses it (the
   new withdrawal checks refuse when their tables are missing).

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

**When the DepositFactory changes** (a redeploy), every issued deposit address
changes. Once every `Swept` event of the old factory is credited (the bot only
reads the configured factory), run `SELECT retire_forwarder_addresses_v1('<note>');`
before the bot boots on the new factory. It records each old address in
`retired_deposit_addresses` (withdrawals to them stay refused and they are never
issued again), clears it, and expires wallet-verification challenges on it; each
user gets the new factory's address the next time the bot registers them.

## 5. Northflank environment

Set on the bot service:

| Variable | Value |
| --- | --- |
| `VAULT_ADDRESS` | the vault |
| `DEPOSIT_FACTORY_ADDRESS`, `DEPOSIT_FORWARDER_IMPLEMENTATION`, `HOT_PAYOUT_ADDRESS` | from the deploy |
| `DEPOSIT_FACTORY_START_BLOCK` | from the deploy |
| `DEPOSITS_TO_HOT_PAYOUT` | `true` if deployed with `DEPOSITS_TO_HOT_PAYOUT=yes`, otherwise unset. The boot check refuses a factory whose vault is not the matching address |
| `PAYOUT_OPERATOR_PRIVATE_KEY`, `SWEEP_GAS_PRIVATE_KEY` | secrets from step 1 |
| `PAYOUT_GUARDIAN_PRIVATE_KEY` | optional secret; enables automatic pause on a freeze. You may instead keep the guardian key on your own device and pause by hand when the watchdog DMs you |
| `IMGNAI_PAYER_PRIVATE_KEY` | secret from step 1 |
| `WITHDRAWALS_ENABLED` | `false` for the first boot |
| `DEPOSIT_CONFIRMATIONS` (2), `DEPOSIT_V2_MIN_NATIVE_SATS` (1000), `CUSTODY_WATCHDOG_MS` (60000), `CUSTODY_LOW_GAS_SATS` (1000), `CUSTODY_LOG_CHUNK_BLOCKS` (2000, at most 10000), `CUSTODY_DEEP_RESCAN_PASSES` (60), `CUSTODY_DEEP_RESCAN_BLOCKS` (5000, at most 10000), `WITHDRAWAL_USER_DAILY_MAX_SATS` (100000), `IMGNAI_X402_MAX_TOPUP_MUSD` (5), `IMGNAI_X402_DAILY_MAX_MUSD` (20) | defaults shown; adjust if needed |
| `IMGNAI_X402_PAY_TO` | imgnAI's x402 payment address. **Set it before enabling image generation**: without it, the first top-up trusts whatever address imgnAI's server asks to be paid. When set, a top-up paying any other address is refused. When unset, the first completed top-up's address is recorded and any later top-up to a different address is refused (admins get a DM) |

Remove `TREASURY_PRIVATE_KEY` and `SWEEP_GAS_SPONSOR_PRIVATE_KEY`. Custody v2
never uses them; legacy rows that are still pending are then listed for
manual review instead of being observed. Point `ESCROW_TREASURY_ADDRESS` at
the vault (at HotPayout with `DEPOSITS_TO_HOT_PAYOUT=true`).

## 6. Fund the wallets

From the vault:

- **Operator**: a little BTC for gas (each withdrawal is one contract call).
- **Sweep gas**: a little BTC for gas (one call per swept asset).
- **Guardian** (if its key is on the server): enough BTC for a few `pause()` and
  `cancel()` calls (about 1,000 sats).
- **Vault** (direct mode): about 2,000 sats, so you can pause, queue and apply
  admin actions in an emergency without first finding gas.
- **HotPayout float**: native BTC and the payout tokens, sized to roughly one
  or two days of withdrawals and never above what you can afford to lose. Send
  them to `HOT_PAYOUT_ADDRESS` like any transfer.
- **imgnAI payer**: a small MUSD float (a few top-ups). Set
  `IMGNAI_X402_PAY_TO` to imgnAI's published x402 payment address before
  funding it, so the first top-up cannot be sent elsewhere.

Admins get a DM when the operator, sweep-gas or guardian wallet drops below
`CUSTODY_LOW_GAS_SATS`, and an urgent hourly DM when the guardian cannot pay for
`pause()` at all. When HotPayout's native daily headroom falls below 20% of the
daily cap, admins get a DM (at most every 6 hours) with the top 5 SATS
withdrawers of the last 24 hours. `/deposit sponsor:true` shows the sweep-gas address.

Backing is measured as vault + HotPayout balances against everything owed to
users. While SATS backing is short, SATS withdrawals and SATS credits
(`/credit`) stay blocked, and instant swaps cannot pay out a token whose
backing is short; `/treasury` shows the shortfall. The old treasury wallet is
not counted.

## 7. First boot and checks

Deploy the `TestingRender` build. The log must show `[Custody] Mode v2: vault
…`. If it shows `[Custody] PAUSED`, the reasons follow on the same line or the
next ones (missing or invalid variables, a shared key, or an on-chain mismatch
such as the wrong operator, a HotPayout recording another factory, or a token
contract whose `decimals()` differs from the configured decimals); fix them and
restart. An unreachable RPC is retried every minute.

Then, as an admin:

1. `/treasury` or `/custody status`: mode v2, vault and HotPayout balances,
   remaining daily limits, gas wallet balances.
2. `/deposit`: a small native deposit to the shown address. Within a few
   minutes the bot sweeps it (`[Deposits] Sweeping SATS ...`) and credits it
   from the `Swept` event (`[Deposits] Credited ...`). The vault balance grows.
   After its first sweep a deposit address is a small contract that needs
   about 24,000 gas to receive BTC; senders with a fixed 21,000 gas limit
   (some exchanges) and contracts using Solidity `transfer()`/`send()` fail and
   the BTC stays with the sender. A transfer through the BTC token precompile
   (`0x7b7C000000000000000000000000000000000000`, `transfer(depositAddress,
   amount)`) always arrives. `/deposit` tells users to send from a normal
   wallet. A sweep of an empty address does nothing and credits nothing.
3. Set `WITHDRAWALS_ENABLED=true`, restart, and withdraw a small amount to a
   wallet you control. `/withdraw` refuses with the remaining on-chain
   capacity when a cap or the float would be exceeded; nothing is debited then.

## Day-to-day operations

**Refill the float.** Send BTC or tokens from the vault to `HOT_PAYOUT_ADDRESS`.
`/treasury` shows the float and what each cap still allows today.

**Queued vault actions.** Anything that loosens control is queued and can be
applied between its delay and 7 days after (`GRACE`; after that it lapses and
can be queued again). Several actions can be pending at once; each is keyed
by its exact content.

| Action | Queue (vault) | Apply | Delay | Who can cancel |
| --- | --- | --- | --- | --- |
| Pull float back to the vault | `proposeRecover(token, amount)` | `applyRecover(token, amount)` | 3 days | guardian |
| Raise caps (both values >= now) | `setCaps(token, perTx, daily)` | `applyCaps(token, perTx, daily)` | 3 days | guardian |
| New operator | `proposeOperator(address)` | `applyOperator(address)` | 3 days | guardian |
| New guardian | `proposeGuardian(address)` | `applyGuardian(address)` | 4 days | vault only |
| New vault | `proposeVault(address)` or `proposeVaultWithSig` | `acceptVault()` (sent by the new vault) | 2 days | the guardian in office when it was queued |

`token` is `0x0000000000000000000000000000000000000000` for BTC.

**Approve before you queue.** The watchdog reads every `ActionQueued` event.
An action that no admin approved beforehand is cancelled by the guardian at
once, and admins get a DM. To queue one on purpose, first run
`/custody expect action:<recover|caps|operator|guardian|vault> subject:<…>
[amount:<…>] [daily:<…>]` (subject is the token, `SATS`/`MUSD`/`MUSDC`/`MEZO` or
an address, for caps and recover; the new address for roles; amounts in sats
for SATS and whole tokens otherwise). The approval matches exactly one action
with those values and is usable for 24 hours. The bot then DMs when it was
queued and from when it can be applied. `/custody cancel id:<action id>`
makes the guardian cancel a queued action by hand.

A new guardian can only be cancelled by the vault, so a leaked guardian key
cannot block its own replacement. For an unapproved one the bot DMs the exact
`cancel(…)` call to send from the vault wallet, every 6 hours while it stays
queued. It waits 4 days. A vault handover can only be cancelled by the guardian
that was in office when it was queued, so one queued before an unwanted
guardian takes office cannot be cancelled by it (or by any guardian after it);
it lands within 2 days, before anything the old key queues afterwards (which
waits 3), and every handover drops all actions queued before it. Keep an
outgoing guardian key, with a little gas, for 9 days after a rotation so it
can still cancel handovers queued while it was in office.

**If the vault key may be exposed** (an unapproved action appeared): hand the
vault to a fresh wallet. Approve it (`/custody expect action:vault
subject:<fresh>`), then queue it from the vault, or sign an EIP-712
`ProposeVault(address next,uint256 vaultEpoch,uint256 deadline)` with the
vault key (domain: name `MezoSbot HotPayout`, version `1`, chain 31612,
HotPayout's address) and have anyone submit `proposeVaultWithSig(next,
deadline, signature)`; that works even when the vault wallet has no gas. Two
days later the fresh wallet calls `acceptVault()`. Update `VAULT_ADDRESS` and
restart.

**Caps.** The vault lowers caps at once with `setCaps` (both values no higher
than now); raising both or one (the other unchanged) is queued; lowering one
while raising the other is refused, so tighten first, then queue the raise.
The guardian can only lower caps with `tightenCaps`. A per-tx cap above the
daily cap is lowered to it, and a zero in either stops the token. Lowering
also lowers recorded spending to the new daily cap (a stop followed by a
restore starts with a full allowance) and drops every raise queued before it.

**Pause / unpause.** The guardian or the vault can call `pause()`; only the
vault can `unpause()`. Both apply at once. While paused, `/withdraw` refuses
before debiting. While custody is frozen, run `/custody unfreeze` before
unpausing: if HotPayout is found unpaused while custody is frozen, the
guardian pauses it again and sets every payout cap to 0, and caps then come
back only through a queued, approved raise (3 days).

**Rotate the operator.** Generate a new key, fund it with gas, approve it with
`/custody expect action:operator`, have the vault call
`proposeOperator(newOperator)` and, 3 days later, `applyOperator(newOperator)`
(pause first if the old key may be exposed), then update
`PAYOUT_OPERATOR_PRIVATE_KEY` and restart. The boot check confirms
`operator()` matches the key. Withdrawals signed by the old operator are still
recovered (each row stores its signer). Rotating the guardian is the same with
`proposeGuardian` / `applyGuardian` (4 days). The sweep-gas key has no
contract role: swap the secret, fund the new address, restart.

**Move the vault.** Approve it, then from the current vault
`proposeVault(newVault)` (or the signed form above); 2 days later the new
wallet calls `acceptVault()`, which also proves it can sign. The
DepositFactory's admin follows automatically. Update `VAULT_ADDRESS` and
restart.

**Other admin changes are announced.** Pauses, unpauses, cap changes,
allowlist changes, role changes, recoveries and factory rescues are DM'd to
admins as the watchdog sees them.

**Tokens sent to a deposit address by mistake.** The factory only sweeps
allowlisted tokens. For anything else, the vault calls
`DepositFactory.rescueToken(salt, token)` to receive it, then refunds the user
by hand. Allowlisted tokens can never be rescued this way. Funds that reached
the factory or its implementation directly are moved to the deposit target by
anyone calling `sweepStray(token)` (`address(0)` for BTC); they are never
credited.

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
get one digest DM at most every 10 minutes (counts by status and a few
examples; unknown-address events below the deposit minimum are only counted).
The funds are in the vault. After checking, credit
the user with `/credit` if appropriate and mark the row `resolved` with a
note. A sweep of a registered user's address is always credited, even if
their deposits were never enabled: the deposit role gate controls who is
shown an address, not what is credited once funds have reached the vault.

**Log scanners.** The Swept and Paid scanners read each block range only once
the RPC node serves it (a range the node refuses, for example for too many
results, is split in halves down to single blocks), re-read a short trailing window every pass, and every
`CUSTODY_DEEP_RESCAN_PASSES` passes re-read the last
`CUSTODY_DEEP_RESCAN_BLOCKS` blocks. Re-reading is idempotent.

**Withdrawal limits and holds.** Before any debit, `/withdraw` refuses (soft
checks, outside `reserve_withdrawal_v2`; HotPayout's caps are the hard limit):

- funds credited from deposits in the last 24 hours (the reply says how much is
  held and when it unlocks);
- more than `WITHDRAWAL_USER_DAILY_MAX_SATS` per user per rolling 24 hours;
- a user an admin put on hold with `/custody hold user:<user> on:true`;
- for 7 days, a destination whose HotPayout payout reverted on-chain because of
  the destination (it rejected the payment or ran out of gas); admins get a DM.

The bot signs payouts with at most 200,000 gas and refuses a withdrawal whose
estimate is higher. Each withdrawal gets a random HotPayout reference, stored
on its row before anything is signed and kept for life.

**Withdrawals held for review.** Recovery logs `MANUAL REVIEW withdrawal <id>`
for rows it will not settle automatically, for example a successful receipt
without the matching `Paid` log. Such rows are never refunded or completed
automatically; settle them by hand after checking the chain.

**Old deposit addresses.** Addresses issued before custody v2, and v2
addresses of a previous DepositFactory (retired with
`retire_forwarder_addresses_v1` when the factory changes), are never shown
again and are not polled; withdrawals to them are refused. Funds sent to one
are not credited automatically.

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

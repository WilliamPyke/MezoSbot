import { getLegacyTreasuryAddress, getTokenBalance, treasurySignerAvailable } from "../evm.js";
import { TOKEN_SYMBOLS, type TokenSymbol } from "../tokens.js";
import { sameAddress } from "./policy.js";
import { getCustodyMode, getV2Settings } from "./state.js";

/**
 * On-chain assets that back user balances: the vault plus the HotPayout float
 * in custody v2, the treasury hot wallet in legacy mode (uncompromised key
 * only), and nothing while custody is paused or v2 is not verified yet, so no
 * address someone else may control is ever counted as backing. Every
 * solvency, mint, swap-inventory and imgnAI backing check reads this.
 */

export type HoldingAccount = { label: "vault" | "payout" | "treasury"; address: string };

export function holdingAccounts(): HoldingAccount[] {
  const mode = getCustodyMode();
  const v2 = mode === "v2" ? getV2Settings() : null;
  if (v2) return [{ label: "vault", address: v2.vault }, { label: "payout", address: v2.payout }];
  const treasury = mode === "legacy" && treasurySignerAvailable() ? getLegacyTreasuryAddress() : null;
  return treasury ? [{ label: "treasury", address: treasury }] : [];
}

/**
 * Funds still at v1 deposit addresses (credited before their sweep) count as
 * assets only in legacy mode with an uncompromised key. In paused and v2
 * modes those addresses derive from a retired key, so they count as zero.
 */
export function legacyUnsweptCounts(): boolean {
  return getCustodyMode() === "legacy" && treasurySignerAvailable();
}

/** Plain reason backing-gated features refuse while no holdings are counted, or null. */
export function noBackingReason(): string | null {
  if (holdingAccounts().length > 0) return null;
  return "Custody is paused, so no on-chain balance is counted as backing: instant swaps, imgnAI top-ups " +
    "and SATS credits (/credit) refuse until custody v2 is active.";
}

export function isHoldingAccount(address: string): boolean {
  return holdingAccounts().some((account) => sameAddress(account.address, address));
}

/** Total holdings of one token in atomic units (wei for SATS). */
export async function getHoldingsUnits(token: TokenSymbol): Promise<bigint> {
  const balances = await Promise.all(holdingAccounts().map((account) => getTokenBalance(account.address, token)));
  return balances.reduce((sum, balance) => sum + balance, 0n);
}

export type HoldingBalances = HoldingAccount & { balances: Record<TokenSymbol, bigint> };

/** Per-account balances of every token, for /treasury and admin views. */
export async function getHoldingsBreakdown(): Promise<HoldingBalances[]> {
  return Promise.all(holdingAccounts().map(async (account) => {
    const entries = await Promise.all(TOKEN_SYMBOLS.map(async (token) => [token, await getTokenBalance(account.address, token)] as const));
    return { ...account, balances: Object.fromEntries(entries) as Record<TokenSymbol, bigint> };
  }));
}

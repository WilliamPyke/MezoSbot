/**
 * Addresses whose private keys are known to be in an attacker's hands. The bot
 * never signs with these keys for anything that moves funds, never shows
 * addresses derived from them, and never sends funds to them.
 */
const COMPROMISED_ADDRESSES = new Set<string>([
  // Old treasury hot wallet. An outside party signed transfers from it on
  // 2026-04-28 (nonce 385) and 2026-09-14 (nonce 861). Every v1 deposit key
  // and the derived sweep gas sponsor key were derived from its private key.
  "0xe05206bd0b57f0d3382aed6577391669c75ce40a",
]);

export function isCompromisedAddress(address: string | null | undefined): boolean {
  return !!address && COMPROMISED_ADDRESSES.has(address.trim().toLowerCase());
}

/** Shown wherever an on-chain action is refused because of the incident. */
export const CUSTODY_PAUSED_MESSAGE =
  "On-chain deposits and withdrawals are paused while MezoSBOT moves to new, safer wallets. " +
  "Do not send funds to any deposit address the bot showed you before. Balances in the bot are unaffected.";

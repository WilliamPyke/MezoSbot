/**
 * Reads many deposit forwarders' balances in one eth_call.
 *
 * The poller used to send one request per forwarder per asset every minute,
 * which was most of the bot's outbound traffic. The node instead runs
 * BalanceScan (contracts/contracts/BalanceScan.sol) from a state override, so
 * nothing is deployed, and one request covers a chunk of forwarders.
 *
 * Mezo's node stops an eth_call after about 21 calls to a token precompile
 * (MEZO, BTC), whatever gas is offered; measured on 2026-11-13, a scan with
 * MEZO among the tokens works for 20 forwarders and fails for 21. Hence the
 * chunks, and the halving when the node refuses one.
 */

/** Runtime code of BalanceScan. contracts/test/BalanceScan.ts fails if it no longer matches the compiled contract. */
export const BALANCE_SCAN_CODE =
  "0x6080604052348015600f57600080fd5b5060146000600160148235831a0260010160806370a0823160e01b8452815b368110156081578035606090811c8031845260045260209283019285905b85821015607857808560248a8535871c5afa601f3d118116606b578889fd5b509384019390880190604c565b5050508501602e565b50607f1981016080f3fea2646970667358221220822dcf294831cc0231c0e64ae1aa975e96681f166bcc780305e5016b2ef6b37d64736f6c63430008180033";

/** Where the override places the code. No account lives here; the address is only a name for the call. */
export const BALANCE_SCAN_ADDRESS = "0x00000000000000000000000000000000ba1a5ca9";

export const SCAN_CHUNK = 16;
export const SCAN_MIN_CHUNK = 4;
/** How long scanning stays off after the node refuses even the smallest chunk. */
export const SCAN_RETRY_MS = 30 * 60_000;

function packAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an address: ${address}`);
  return address.slice(2).toLowerCase();
}

/** Call data for BalanceScan: token count (one byte), the tokens, then the holders, 20 bytes each. */
export function encodeScan(holders: string[], tokens: string[]): string {
  if (tokens.length > 255) throw new Error("BalanceScan takes at most 255 tokens");
  return `0x${tokens.length.toString(16).padStart(2, "0")}${tokens.map(packAddress).join("")}${holders.map(packAddress).join("")}`;
}

class ScanShapeError extends Error {}

/** One row per holder: its native balance, then its balance of each token in order. */
export function decodeScan(raw: unknown, holderCount: number, tokenCount: number): bigint[][] {
  const width = tokenCount + 1;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw) || raw.length !== 2 + holderCount * width * 64) {
    // A node that ignores the override answers "0x": the call reached an empty account.
    throw new ScanShapeError(`balance scan returned ${typeof raw === "string" ? (raw.length - 2) / 2 : "no"} bytes for ${holderCount * width} values`);
  }
  const rows: bigint[][] = [];
  for (let h = 0; h < holderCount; h++) {
    const row: bigint[] = [];
    for (let w = 0; w < width; w++) {
      const at = 2 + (h * width + w) * 64;
      row.push(BigInt(`0x${raw.slice(at, at + 64)}`));
    }
    rows.push(row);
  }
  return rows;
}

/** For each holder, its balances, or null when the scan did not read it and the caller must. */
export type BalanceScanner = (holders: string[], tokens: string[]) => Promise<Array<bigint[] | null>>;

export function createBalanceScanner(options: {
  /** eth_call to BALANCE_SCAN_ADDRESS with BALANCE_SCAN_CODE placed there by a state override. */
  call: (data: string) => Promise<unknown>;
  /** True when the node answered with an error, false when the request never got an answer. */
  nodeAnswered: (error: unknown) => boolean;
  warn: (message: string) => void;
  now?: () => number;
}): BalanceScanner {
  const now = options.now ?? Date.now;
  let chunk = SCAN_CHUNK;
  let offUntil = 0;

  return async (holders, tokens) => {
    const result: Array<bigint[] | null> = holders.map(() => null);
    if (tokens.length > 255 || now() < offUntil) return result;
    if (offUntil > 0) {
      offUntil = 0;
      chunk = SCAN_CHUNK;
    }
    let at = 0;
    while (at < holders.length) {
      const slice = holders.slice(at, at + chunk);
      try {
        const rows = decodeScan(await options.call(encodeScan(slice, tokens)), slice.length, tokens.length);
        for (let i = 0; i < rows.length; i++) result[at + i] = rows[i]!;
        at += slice.length;
      } catch (error) {
        const message = String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 200);
        if (!(error instanceof ScanShapeError) && !options.nodeAnswered(error)) {
          options.warn(`[Deposits] Balance scan got no answer (${message}); reading the remaining forwarders one by one this poll`);
          return result;
        }
        if (chunk > SCAN_MIN_CHUNK) {
          // The node refuses a chunk this large. Smaller chunks stay in use from here on.
          chunk = Math.max(SCAN_MIN_CHUNK, Math.floor(chunk / 2));
          continue;
        }
        offUntil = now() + SCAN_RETRY_MS;
        options.warn(
          `[Deposits] Balance scan is not usable on this RPC (${message}); reading forwarders one by one for ${SCAN_RETRY_MS / 60_000} minutes. ` +
            "This sends far more requests and counts against outbound bandwidth.",
        );
        return result;
      }
    }
    return result;
  };
}

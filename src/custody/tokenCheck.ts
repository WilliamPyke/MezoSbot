import { ethers } from "ethers";
import { TOKEN_SYMBOLS, getTokenConfig } from "../tokens.js";
import { NATIVE_TOKEN } from "./abi.js";
import { BTC_PRECOMPILE_ADDRESS, tokenContractProblems, type TokenContractReading } from "./policy.js";
import { ethCall, isRevertError } from "./rpc.js";

/**
 * Token configuration check run when custody v2 activates (src/custody/state.ts):
 * every configured ERC-20 (MUSD, MUSDC, MEZO) must answer decimals() with its
 * *_TOKEN_DECIMALS, and none may be the zero address or Mezo's BTC
 * precompile (which also answers decimals()). Any problem keeps custody
 * paused. The rules themselves are tokenContractProblems in policy.ts.
 */

const ERC20_DECIMALS = new ethers.Interface(["function decimals() view returns (uint8)"]);

function isReservedAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === NATIVE_TOKEN || lower === BTC_PRECOMPILE_ADDRESS;
}

const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 2_000;

/** decimals() of `address`; null when it reverts or returns nothing decodable; throws when it cannot be read. */
async function readDecimals(address: string): Promise<number | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await ethCall(address, ERC20_DECIMALS.encodeFunctionData("decimals"));
      return Number(ERC20_DECIMALS.decodeFunctionResult("decimals", raw)[0]);
    } catch (error) {
      if (isRevertError(error) || ethers.isError(error, "BAD_DATA")) return null;
      if (attempt >= READ_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
    }
  }
}

/**
 * Reads decimals() of every configured token and returns the problems (empty
 * when all match). Throws when a read keeps failing (RPC trouble), so the
 * caller retries it with the other on-chain checks.
 */
export async function readTokenContractProblems(): Promise<string[]> {
  const readings: TokenContractReading[] = [];
  for (const symbol of TOKEN_SYMBOLS) {
    if (symbol === "SATS") continue;
    const token = getTokenConfig(symbol);
    const address = token.contractAddress?.trim() || null;
    let onChainDecimals: number | null = null;
    if (address && /^0x[0-9a-fA-F]{40}$/.test(address) && !isReservedAddress(address)) {
      try {
        onChainDecimals = await readDecimals(address);
      } catch (error) {
        throw new Error(`${symbol}_TOKEN_CONTRACT decimals() could not be read (${(error as Error).message})`);
      }
    }
    readings.push({ symbol, address, configuredDecimals: token.decimals, onChainDecimals });
  }
  return tokenContractProblems(readings);
}

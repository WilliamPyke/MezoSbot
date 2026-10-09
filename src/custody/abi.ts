/**
 * Interfaces of the custody contracts in contracts/contracts/{DepositFactory,HotPayout}.sol.
 * tests/custodyAbi.test.ts (via the contracts test suite) asserts the compiled
 * ABIs contain every fragment below, so the bot and the contracts cannot drift.
 */

/** Native BTC is reported as token address(0) in events and cap lookups. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

export const DEPOSIT_FACTORY_ABI = [
  "function vault() view returns (address)",
  "function implementation() view returns (address)",
  "function allowedToken(address token) view returns (bool)",
  "function predict(bytes32 salt) view returns (address)",
  "function sweepNative(bytes32 salt) returns (uint256 amount)",
  "function sweepToken(bytes32 salt, address token) returns (uint256 amount)",
  "function setTokenAllowed(address token, bool allowed)",
  "event Swept(bytes32 indexed salt, address indexed token, uint256 amount, address indexed vault)",
  "event TokenAllowed(address indexed token, bool allowed)",
] as const;

export const HOT_PAYOUT_ABI = [
  "function vault() view returns (address)",
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function paused() view returns (bool)",
  "function allowedToken(address token) view returns (bool)",
  "function perTxCap(address token) view returns (uint256)",
  "function dailyCap(address token) view returns (uint256)",
  "function remainingDaily(address token) view returns (uint256)",
  "function paid(bytes32 ref) view returns (bool)",
  "function payNative(bytes32 ref, address to, uint256 amount)",
  "function payToken(bytes32 ref, address token, address to, uint256 amount)",
  "function pause()",
  "function tightenCaps(address token, uint256 perTx, uint256 daily)",
  "event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount)",
] as const;

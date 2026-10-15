/**
 * Interfaces of the custody contracts in contracts/contracts/{DepositFactory,HotPayout}.sol.
 * tests/custodyAbi.test.ts (via the contracts test suite) asserts the compiled
 * ABIs contain every fragment below, so the bot and the contracts cannot drift.
 */

/** Native BTC is reported as token address(0) in events and cap lookups. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

export const DEPOSIT_FACTORY_ABI = [
  "function vault() view returns (address)",
  "function admin() view returns (address)",
  "function implementation() view returns (address)",
  "function allowedToken(address token) view returns (bool)",
  "function predict(bytes32 salt) view returns (address)",
  "function sweepNative(bytes32 salt) returns (uint256 amount)",
  "function sweepToken(bytes32 salt, address token) returns (uint256 amount)",
  "event Swept(bytes32 indexed salt, address indexed token, uint256 amount, address indexed vault)",
  "event TokenAllowed(address indexed token, bool allowed)",
  "event Rescued(bytes32 indexed salt, address indexed token, address indexed to, uint256 amount)",
  "error InvalidToken()",
  "error TokenNotAllowed()",
] as const;

/** HotPayout.Action, as uint8 in ActionQueued / ActionCancelled and cancel(). */
export const PAYOUT_ACTIONS = ["vault", "operator", "guardian", "caps", "recover"] as const;
export type PayoutAction = (typeof PAYOUT_ACTIONS)[number];

export const HOT_PAYOUT_ABI = [
  "function vault() view returns (address)",
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function factory() view returns (address)",
  "function forwarderImplementation() view returns (address)",
  "function forwarderCodeHash() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function allowedToken(address token) view returns (bool)",
  "function perTxCap(address token) view returns (uint256)",
  "function dailyCap(address token) view returns (uint256)",
  "function remainingDaily(address token) view returns (uint256)",
  "function paid(bytes32 ref) view returns (bool)",
  "function queuedEta(bytes32 id) view returns (uint256)",
  "function actionId(uint8 action, address subject, uint256 value1, uint256 value2) view returns (bytes32)",
  "function pendingEta(uint8 action, address subject, uint256 value1, uint256 value2) view returns (uint256)",
  "function vaultEpoch() view returns (uint256)",
  "function guardianSince() view returns (uint256)",
  "function previousGuardian() view returns (address)",
  "function domainSeparator() view returns (bytes32)",
  "function proposeVaultWithSig(address next, uint256 deadline, bytes signature)",
  "function payNative(bytes32 ref, address to, uint256 amount)",
  "function payToken(bytes32 ref, address token, address to, uint256 amount)",
  "function pause()",
  "function tightenCaps(address token, uint256 perTx, uint256 daily)",
  "function cancel(uint8 action, address subject, uint256 value1, uint256 value2)",
  "event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount)",
  "event ActionQueued(bytes32 indexed id, uint8 indexed action, address indexed subject, uint256 value1, uint256 value2, uint256 eta)",
  "event ActionCancelled(bytes32 indexed id, uint8 indexed action, address indexed by)",
  "event ActionApplied(bytes32 indexed id, uint8 indexed action)",
  "event QueueDropped(uint256 vaultEpoch)",
  "event CapRaisesDropped(address indexed token, uint256 capsEpoch)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event TokenAllowed(address indexed token, bool allowed)",
  "event CapsSet(address indexed token, uint256 perTxCap, uint256 dailyCap)",
  "event VaultSet(address indexed previous, address indexed vault)",
  "event OperatorSet(address indexed previous, address indexed operator)",
  "event GuardianSet(address indexed previous, address indexed guardian)",
  "event Recovered(address indexed token, uint256 amount)",
  "error InvalidRef()",
  "error AlreadyPaid()",
  "error BadRecipient()",
  "error TokenNotAllowed()",
  "error CapsNotSet()",
  "error ZeroAmount()",
  "error PerTxCapExceeded()",
  "error DailyCapExceeded()",
  "error InsufficientFloat()",
  "error PayFailed()",
  "error NotOperator()",
  "error NotGuardian()",
  "error NothingPending()",
  "error QueuedBeforeGuardian()",
  "error EnforcedPause()",
] as const;

export type AssetConfig = {
  symbol: "BTC" | "BTC_ERC20" | "MUSD" | "MEZO";
  label: string;
  address: `0x${string}`;
  decimals: number;
  native: boolean;
};

export type AppConfig = {
  defaultChainId: 31612 | 31611;
  walletConnectProjectId: string;
  chains: ChainConfig[];
};

export type ChainConfig = {
  network: "mainnet" | "testnet";
  chainId: 31612 | 31611;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  escrowContractAddress: `0x${string}` | "";
  platformFeeBps: number;
  assets: AssetConfig[];
};

export type WalletSession = {
  address: string;
  chainId: number;
  issuedAt: number;
};

export type ContractArgs = {
  sessionId: `0x${string}`;
  invitedPlayer: `0x${string}`;
  asset: `0x${string}`;
  stakeAmount: string;
  joinDeadline: number;
  playDeadline: number;
};

export type SessionRow = {
  id: `0x${string}`;
  seed: string;
  status: "draft" | "created" | "active" | "submitted" | "completed" | "refunded" | "cancelled" | "settlement_failed";
  chain_id: 31612 | 31611;
  escrow_contract_address: `0x${string}` | "";
  chain: {
    network: "mainnet" | "testnet";
    chainId: 31612 | 31611;
    chainName: string;
    explorerUrl: string;
    escrowContractAddress: `0x${string}` | "";
  };
  asset_symbol: string;
  asset_address: `0x${string}`;
  stake_amount_units: string;
  platform_fee_bps: number;
  player_a_address: string;
  player_b_address: string | null;
  invited_player_address: string | null;
  winner_address: string | null;
  create_tx_hash: string | null;
  join_tx_hash: string | null;
  settlement_tx_hash: string | null;
  join_deadline: string;
  play_deadline: string;
  contractArgs: ContractArgs;
};

export type GameState = {
  boardSize: number;
  session: {
    id: `0x${string}`;
    status: SessionRow["status"];
    assetSymbol: string;
    assetAddress: `0x${string}`;
    stakeAmountUnits: string;
    platformFeeBps: number;
    playerA: string;
    playerB: string | null;
    chainId: number;
    winner: string | null;
    playDeadline: string;
    settlementTxHash: string | null;
    explorerUrl: string;
    serverNow: string;
  };
  self: null | {
    address: string;
    score: number;
    multiplier: number;
    level: number;
    levelDisplay: number;
    maxLevels: number;
    phase: "playing" | "finished";
    submitted: boolean;
    pieces: Array<{ cells: Array<{ x: number; y: number; kind: "normal" | "multiplier" }>; placed: boolean }>;
    board: number[][];
  };
  opponent: null | { address: string | null; submitted: boolean; score: number | null };
  result: { completed: boolean; isWinner: boolean | null; isTie: boolean; aScore: number | null; bScore: number | null };
};

export type QueueEntry = {
  id: number;
  surface: "discord" | "wallet";
  user_id: string;
  status: "waiting" | "paired" | "cancelled" | "expired";
  joined_at: string;
  expires_at: string;
};

export type QueueEnqueueResponse =
  | { status: "waiting"; entry: QueueEntry }
  | { status: "paired"; session: SessionRow; opponent: string; role: "creator" | "joiner" };

export type QueueStatusResponse =
  | { status: "idle" }
  | { status: "waiting"; entry: QueueEntry }
  | { status: "cancelled"; entry: QueueEntry }
  | { status: "expired"; entry: QueueEntry }
  | { status: "paired"; session: SessionRow; opponent: string; role: "creator" | "joiner" };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload as T;
}

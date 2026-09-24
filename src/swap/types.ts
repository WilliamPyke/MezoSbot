import type { TokenSymbol } from "../tokens.js";

export type SwapMode = "internal" | "onchain";

export type SwapStatus =
  | "quoted"
  | "reserved"
  | "submitted"
  | "completed"
  | "failed"
  | "cancelled"
  /** Terminal for automation: funds stay escrowed until an operator resolves it. */
  | "needs_review";

/** Aerodrome-style basic Mezo pool hop. */
export type BasicRouteHop = {
  kind: "basic";
  from: string;
  to: string;
  stable: boolean;
  factory: string;
};

/** Slipstream concentrated-liquidity hop. */
export type ClRouteHop = {
  kind: "cl";
  tokenIn: string;
  tokenOut: string;
  tickSpacing: number;
  factory: string;
  pool: string;
};

export type MezoRouteHop = BasicRouteHop | ClRouteHop;

export type SwapLeg =
  | { venue: "basic"; hops: BasicRouteHop[] }
  | { venue: "cl"; hops: ClRouteHop[] };

export type SwapQuote = {
  quoteId: string;
  discordId: string;
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  fromAmount: number;
  quotedToAmount: number;
  minToAmount: number;
  mode: SwapMode;
  preferredMode: SwapMode;
  canInternal: boolean;
  canOnchain: boolean;
  gasReservedSats: number;
  routes: MezoRouteHop[];
  expiresAt: Date;
  volumeSatsProxy: number;
  freeInventoryTo: number;
  slippageBps: number;
  rateLabel: string;
};

export type SwapRow = {
  id: number;
  quote_id: string;
  discord_id: string;
  from_token: TokenSymbol;
  to_token: TokenSymbol;
  from_amount: number;
  quoted_to_amount: number;
  min_to_amount: number;
  received_to_amount: number | null;
  mode: SwapMode;
  status: SwapStatus;
  gas_reserved_sats: number;
  gas_actual_sats: number | null;
  gas_refunded_sats: number;
  to_credited: boolean;
  from_refunded: boolean;
  gas_settled: boolean;
  tx_hash: string | null;
  route_json: MezoRouteHop[];
  quote_expires_at: string;
  error_message: string | null;
  guild_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ExecuteSwapResult =
  | {
      ok: true;
      mode: SwapMode;
      fromToken: TokenSymbol;
      toToken: TokenSymbol;
      fromAmount: number;
      receivedToAmount: number;
      gasActualSats: number;
      gasRefundedSats: number;
      txHash?: string;
      txHashes?: string[];
      quoteId: string;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };

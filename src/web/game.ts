import { ethers } from "ethers";
import {
  applyMove,
  createPlayerState,
  pieceForSlot,
  replayMoves,
} from "../arcade/match.js";
import { generatePieceSequence } from "../arcade/pieces.js";
import { hashSeed } from "../arcade/rng.js";
import {
  BOARD_SIZE,
  PIECES_PER_LEVEL,
  type GeneratedPiece,
  type Move,
  type PieceCell,
  type PlayerState,
} from "../arcade/types.js";
import { config } from "../config.js";
import { normalizeWalletAddress } from "./auth.js";
import {
  completeSession,
  getSubmission,
  getWebSession,
  getWebSeriesScore,
  markWebPlayerReady,
  sessionPlayers,
  upsertSubmission,
  type WebArcadeSessionRow,
} from "./db.js";
import { settleOrRefundOnChain } from "./settlement.js";
import { chainConfigForId } from "./chains.js";

const settlementLocks = new Set<string>();

export type WebGameState = {
  session: {
    id: string;
    status: WebArcadeSessionRow["status"];
    assetSymbol: string;
    assetAddress: string;
    stakeAmountUnits: string;
    platformFeeBps: number;
    chainId: number;
    playerA: string;
    playerB: string | null;
    playerAReady: boolean;
    playerBReady: boolean;
    countdownStartedAt: string | null;
    invitedPlayer: string | null;
    winner: string | null;
    joinDeadline: string;
    playDeadline: string;
    createTxHash: string | null;
    joinTxHash: string | null;
    settlementTxHash: string | null;
    resultHash: string | null;
    explorerUrl: string;
    serverNow: string;
  };
  self: {
    address: string;
    score: number;
    multiplier: number;
    level: number;
    levelDisplay: number;
    maxLevels: number | null;
    phase: PlayerState["phase"];
    endReason?: PlayerState["endReason"];
    submitted: boolean;
    ready: boolean;
    pieces: Array<{ cells: PieceCell[] | null; placed: boolean }>;
    bank: { cells: PieceCell[] } | null;
    board: number[][];
  } | null;
  opponent: {
    address: string | null;
    submitted: boolean;
    ready: boolean;
    score: number | null;
  } | null;
  result: {
    completed: boolean;
    isWinner: boolean | null;
    isTie: boolean;
    aScore: number | null;
    bScore: number | null;
  };
  boardSize: number;
};

export type WalletArcadePlayState = {
  boardSize: number;
  match: {
    id: string;
    mode: "staked_pvp";
    status: WebArcadeSessionRow["status"];
    stakeSats: null;
    grossPotSats: null;
    winnerPayoutSats: null;
    stakeFormatted: string;
    grossPotFormatted: string;
    winnerPayoutFormatted: string;
    durationSeconds: number;
    startedAt: string | null;
    deadlineAt: string | null;
    serverNow: string;
  };
  self: {
    userId: string;
    score: number;
    multiplier: number;
    level: number;
    levelDisplay: number;
    maxLevels: number | null;
    phase: PlayerState["phase"];
    endReason?: PlayerState["endReason"];
    submitted: boolean;
    ready: boolean;
    pieces: Array<{ cells: PieceCell[] | null; placed: boolean }>;
    bank: { cells: PieceCell[] } | null;
    board: number[][];
  };
  opponent: {
    userId: string | null;
    submitted: boolean;
    ready: boolean;
    score: number | null;
  } | null;
  result: {
    completed: boolean;
    winnerId: string | null;
    isWinner: boolean | null;
    isTie: boolean;
    aScore: number | null;
    bScore: number | null;
    payoutFormatted: string | null;
    settlementTxHash: string | null;
    settlementExplorerUrl: string | null;
    rematchRequestedBySelf: boolean;
    rematchRequestedByOpponent: boolean;
    nextMatchId: number | null;
    nextSessionId: string | null;
    redirect: string | null;
    series: { youWins: number; opponentWins: number; ties: number; total: number };
  };
};

export async function buildGameState(sessionId: string, wallet: string): Promise<WebGameState> {
  const session = await getWebSession(sessionId);
  if (!session) throw new Error("Session not found");
  await finalizeReadySessionIfNeeded(session);
  const freshSession = (await getWebSession(sessionId)) ?? session;

  const address = normalizeWalletAddress(wallet);
  const chain = chainConfigForId(freshSession.chain_id);
  const players = sessionPlayers(freshSession);
  const isPlayer = players.includes(address);
  const state = isPlayer ? await playerState(freshSession, address) : null;
  const opponentAddress =
    freshSession.player_a_address === address
      ? freshSession.player_b_address
      : freshSession.player_b_address === address
        ? freshSession.player_a_address
        : freshSession.player_b_address;
  const opponentSubmission = opponentAddress
    ? await getSubmission(freshSession.id, opponentAddress)
    : null;
  const selfSubmitted =
    address === freshSession.player_a_address
      ? freshSession.player_a_submitted
      : address === freshSession.player_b_address
        ? freshSession.player_b_submitted
        : false;

  return {
    boardSize: BOARD_SIZE,
    session: {
      id: freshSession.id,
      status: freshSession.status,
      assetSymbol: freshSession.asset_symbol,
      assetAddress: freshSession.asset_address,
      stakeAmountUnits: freshSession.stake_amount_units,
      platformFeeBps: freshSession.platform_fee_bps,
      chainId: freshSession.chain_id,
      playerA: freshSession.player_a_address,
      playerB: freshSession.player_b_address,
      playerAReady: freshSession.player_a_ready,
      playerBReady: freshSession.player_b_ready,
      countdownStartedAt: freshSession.countdown_started_at,
      invitedPlayer: freshSession.invited_player_address,
      winner: freshSession.winner_address,
      joinDeadline: freshSession.join_deadline,
      playDeadline: freshSession.play_deadline,
      createTxHash: freshSession.create_tx_hash,
      joinTxHash: freshSession.join_tx_hash,
      settlementTxHash: freshSession.settlement_tx_hash,
      resultHash: freshSession.result_hash,
      explorerUrl: chain.explorerUrl,
      serverNow: new Date().toISOString(),
    },
    self: state
      ? {
          address,
          score: state.score,
          multiplier: state.multiplier,
          level: state.level,
          levelDisplay: state.level + 1,
          maxLevels: null,
          phase: state.phase,
          endReason: state.endReason,
          submitted: selfSubmitted,
          ready: address === freshSession.player_a_address
            ? freshSession.player_a_ready
            : freshSession.player_b_ready,
          pieces: currentPieces(freshSession.seed, state),
          bank: state.bank ? { cells: state.bank.cells } : null,
          board: state.board,
        }
      : null,
    opponent: opponentAddress
      ? {
          address: opponentAddress,
          submitted: opponentSubmission?.submitted ?? false,
          ready: opponentAddress === freshSession.player_a_address
            ? freshSession.player_a_ready
            : freshSession.player_b_ready,
          score: opponentScore(freshSession, opponentAddress),
        }
      : null,
    result: {
      completed: ["completed", "refunded"].includes(freshSession.status),
      isWinner: freshSession.status === "completed" ? freshSession.winner_address === address : null,
      isTie: freshSession.status === "refunded" && freshSession.result_hash != null,
      aScore: freshSession.player_a_score,
      bScore: freshSession.player_b_score,
    },
  };
}

export async function buildWalletArcadePlayState(
  sessionId: string,
  wallet: string
): Promise<WalletArcadePlayState> {
  const state = await buildGameState(sessionId, wallet);
  const session = await getWebSession(sessionId);
  const series = (await getWebSeriesScore(sessionId, wallet)) ?? {
    rootId: sessionId,
    totalCompleted: 0,
    youWins: 0,
    opponentWins: 0,
    ties: 0,
  };
  const me = normalizeWalletAddress(wallet);
  const isA = session ? session.player_a_address === me : false;
  const rematchSelf = !!(session && (isA ? session.rematch_requested_by_a : session.rematch_requested_by_b));
  const rematchOpp = !!(session && (isA ? session.rematch_requested_by_b : session.rematch_requested_by_a));
  const nextSessionId = session?.next_session_id ?? null;
  const redirect = nextSessionId ? `/session/${nextSessionId}` : null;
  return walletArcadePlayStateFromGameState(state, {
    series,
    rematchSelf,
    rematchOpp,
    nextSessionId,
    redirect,
  });
}

type WalletPlayExtras = {
  series: { youWins: number; opponentWins: number; ties: number; totalCompleted: number };
  rematchSelf: boolean;
  rematchOpp: boolean;
  nextSessionId: string | null;
  redirect: string | null;
};

const WALLET_PLAY_EXTRAS_DEFAULT: WalletPlayExtras = {
  series: { youWins: 0, opponentWins: 0, ties: 0, totalCompleted: 0 },
  rematchSelf: false,
  rematchOpp: false,
  nextSessionId: null,
  redirect: null,
};

export function walletArcadePlayStateFromGameState(
  state: WebGameState,
  extras: WalletPlayExtras = WALLET_PLAY_EXTRAS_DEFAULT
): WalletArcadePlayState {
  if (!state.self) throw new Error("Wallet is not a player in this session");

  const asset = assetForState(state);
  const stake = BigInt(state.session.stakeAmountUnits);
  const grossPot = stake * 2n;
  const fee = (grossPot * BigInt(state.session.platformFeeBps)) / 10000n;
  const winnerPayout = grossPot - fee;
  const settlementExplorerUrl = state.session.settlementTxHash
    ? `${state.session.explorerUrl}/tx/${state.session.settlementTxHash}`
    : null;

  return {
    boardSize: state.boardSize,
    match: {
      id: shortSessionId(state.session.id),
      mode: "staked_pvp",
      status: state.session.status,
      stakeSats: null,
      grossPotSats: null,
      winnerPayoutSats: null,
      stakeFormatted: `${ethers.formatUnits(stake, asset.decimals)} ${asset.symbol}`,
      grossPotFormatted: `${ethers.formatUnits(grossPot, asset.decimals)} ${asset.symbol}`,
      winnerPayoutFormatted: `${ethers.formatUnits(winnerPayout, asset.decimals)} ${asset.symbol}`,
      durationSeconds: Math.max(1, Math.round((Date.parse(state.session.playDeadline) - Date.parse(state.session.joinDeadline)) / 1000)),
      startedAt: walletPlayStartsAt(state.session),
      deadlineAt: ["active", "submitted"].includes(state.session.status) && walletPlayHasStarted(state.session)
        ? state.session.playDeadline
        : null,
      serverNow: state.session.serverNow,
    },
    self: {
      userId: shortAddress(state.self.address),
      score: state.self.score,
      multiplier: state.self.multiplier,
      level: state.self.level,
      levelDisplay: state.self.levelDisplay,
      maxLevels: state.self.maxLevels,
      phase: state.self.phase,
      endReason: state.self.endReason,
      submitted: state.self.submitted,
      ready: state.self.ready,
      pieces: state.self.pieces,
      bank: state.self.bank,
      board: state.self.board,
    },
    opponent: state.opponent
      ? {
          userId: state.opponent.address ? shortAddress(state.opponent.address) : null,
          submitted: state.opponent.submitted,
          ready: state.opponent.ready,
          score: state.opponent.score,
        }
      : null,
    result: {
      completed: state.result.completed,
      winnerId: state.session.winner ? shortAddress(state.session.winner) : null,
      isWinner: state.result.isWinner,
      isTie: state.result.isTie,
      aScore: state.result.aScore,
      bScore: state.result.bScore,
      payoutFormatted: state.result.completed && state.result.isWinner
        ? `${ethers.formatUnits(winnerPayout, asset.decimals)} ${asset.symbol}`
        : null,
      settlementTxHash: state.session.settlementTxHash,
      settlementExplorerUrl,
      rematchRequestedBySelf: extras.rematchSelf,
      rematchRequestedByOpponent: extras.rematchOpp,
      nextMatchId: null,
      nextSessionId: extras.nextSessionId,
      redirect: extras.redirect,
      series: {
        youWins: extras.series.youWins,
        opponentWins: extras.series.opponentWins,
        ties: extras.series.ties,
        total: extras.series.totalCompleted,
      },
    },
  };
}

export async function applyWebMove(sessionId: string, wallet: string, move: Move) {
  const session = await requireActivePlayer(sessionId, wallet);
  await finalizeReadySessionIfNeeded(session);
  const fresh = await requireActivePlayer(sessionId, wallet);
  requireSessionStarted(fresh);
  const current = await playerState(fresh, wallet);
  if (current.phase !== "playing") throw new Error("Player is already finished");
  const sequence = sequenceFor(fresh.seed);
  const result = applyMove(current, sequence, move);
  if (!result.ok) throw new Error(result.error);
  await upsertSubmission({
    sessionId,
    wallet,
    moves: result.state.moves,
    score: result.state.score,
    submitted: false,
  });
  return buildGameState(sessionId, wallet);
}

export async function submitWebScore(sessionId: string, wallet: string) {
  const session = await requireActivePlayer(sessionId, wallet);
  requireSessionStarted(session);
  const state = await playerState(session, wallet);
  await upsertSubmission({
    sessionId,
    wallet,
    moves: state.moves,
    score: state.score,
    submitted: true,
  });
  await tryFinalizeSession(sessionId);
  return buildGameState(sessionId, wallet);
}

export async function tryFinalizeSession(sessionId: string) {
  if (settlementLocks.has(sessionId)) return getWebSession(sessionId);
  settlementLocks.add(sessionId);
  try {
    const session = await getWebSession(sessionId);
    if (!session || ["completed", "refunded", "cancelled"].includes(session.status)) return session;
    if (!session.player_b_address || session.status !== "active") return session;

    const expired = Date.now() >= settlementCutoffMs(session);
    const bothSubmitted = session.player_a_submitted && session.player_b_submitted;
    if (!expired && !bothSubmitted) return session;

    const locked = await lockSessionForSettlement(session.id);
    if (!locked) return getWebSession(session.id);

    const aState = await playerState(session, session.player_a_address);
    const bState = await playerState(session, session.player_b_address);
    const aScore = session.player_a_submitted || expired ? aState.score : 0;
    const bScore = session.player_b_submitted || expired ? bState.score : 0;

    if (aScore === bScore) {
      const resultHash = resultHashFor(session.id, null, aScore, bScore);
      const txHash = await settleOrRefundOnChain({
        session,
        action: "refund",
        resultHash,
        reasonHash: ethers.id("tie"),
      });
      return completeSession({ sessionId: session.id, winner: null, resultHash, settlementTxHash: txHash, refunded: true });
    }

    const winner = aScore > bScore ? session.player_a_address : session.player_b_address;
    const resultHash = resultHashFor(session.id, winner, aScore, bScore);
    const txHash = await settleOrRefundOnChain({ session, action: "settle", resultHash, winner });
    return completeSession({ sessionId: session.id, winner, resultHash, settlementTxHash: txHash });
  } finally {
    settlementLocks.delete(sessionId);
  }
}

async function finalizeReadySessionIfNeeded(session: WebArcadeSessionRow) {
  if (session.status !== "active") return;
  if (!walletSessionReady(session)) return;
  const expired = Date.now() >= settlementCutoffMs(session);
  const bothSubmitted = session.player_a_submitted && session.player_b_submitted;
  if (expired || bothSubmitted) {
    await tryFinalizeSession(session.id);
  }
}

export async function markWalletArcadeReady(sessionId: string, wallet: string) {
  await markWebPlayerReady(sessionId, wallet, 3000);
  return buildWalletArcadePlayState(sessionId, wallet);
}

async function lockSessionForSettlement(sessionId: string): Promise<boolean> {
  const { supabase } = await import("../db.js");
  const { data, error } = await supabase
    .from("web_arcade_sessions")
    .update({ status: "settling", updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Could not lock settlement: ${error.message}`);
  return !!data;
}

function walletSessionReady(session: WebArcadeSessionRow) {
  return !!session.player_a_ready && !!session.player_b_ready && walletPlayHasStarted({
    countdownStartedAt: session.countdown_started_at,
  });
}

function walletPlayStartsAt(session: { countdownStartedAt?: string | null; countdown_started_at?: string | null }) {
  const raw = session.countdownStartedAt ?? session.countdown_started_at ?? null;
  if (!raw) return null;
  return new Date(Date.parse(raw) + 3000).toISOString();
}

function walletPlayHasStarted(session: { countdownStartedAt?: string | null; countdown_started_at?: string | null }) {
  const startsAt = walletPlayStartsAt(session);
  return !!startsAt && Date.now() >= Date.parse(startsAt);
}

function requireSessionStarted(session: WebArcadeSessionRow) {
  if (!session.player_a_ready || !session.player_b_ready) throw new Error("Both players must ready up first");
  if (!walletPlayHasStarted(session)) throw new Error("Match countdown is still running");
}

function settlementCutoffMs(session: WebArcadeSessionRow) {
  return Date.parse(session.play_deadline) + config.web.settlementGraceSeconds * 1000;
}

async function requireActivePlayer(sessionId: string, wallet: string) {
  const session = await getWebSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.status !== "active") throw new Error("Session is not active");
  const address = normalizeWalletAddress(wallet);
  if (![session.player_a_address, session.player_b_address].includes(address)) {
    throw new Error("Wallet is not a player in this session");
  }
  return session;
}

async function playerState(session: WebArcadeSessionRow, wallet: string): Promise<PlayerState> {
  const submission = await getSubmission(session.id, wallet);
  const moves = submission?.move_log ?? [];
  const replay = replayMoves(sequenceFor(session.seed), moves);
  if (!replay.valid) return createPlayerState();
  return replay.state;
}

function currentPieces(seed: string, state: PlayerState) {
  const sequence = sequenceFor(seed);
  const out: Array<{ cells: PieceCell[] | null; placed: boolean }> = [];
  for (let i = 0; i < PIECES_PER_LEVEL; i++) {
    const piece = pieceForSlot(state, sequence, state.level, i);
    out.push({ cells: piece ? piece.cells : null, placed: state.placedThisLevel[i] });
  }
  return out;
}

function sequenceFor(seed: string): GeneratedPiece[][] {
  return generatePieceSequence(hashSeed(seed));
}

function opponentScore(session: WebArcadeSessionRow, opponent: string) {
  return opponent === session.player_a_address ? session.player_a_score : session.player_b_score;
}

function assetForState(state: WebGameState) {
  return {
    symbol: state.session.assetSymbol,
    decimals: assetForAddressDecimals(state.session.assetAddress, state.session.chainId),
  };
}

function assetForAddressDecimals(address: string, chainId: number) {
  const chain = chainConfigForId(chainId);
  const asset = chain.assets.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
  if (!asset) return 18;
  return asset.decimals;
}

function resultHashFor(sessionId: string, winner: string | null, aScore: number, bScore: number) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "uint256", "uint256"],
      [sessionId, winner ?? ethers.ZeroAddress, BigInt(aScore), BigInt(bScore)]
    )
  );
}

function shortSessionId(id: string) {
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

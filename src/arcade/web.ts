/**
 * Browser playfield for Slice Arcade.
 *
 * Discord initiates matchmaking; this module serves the actual game in a web
 * browser. The server is the source of truth for every move — the browser is
 * a thin client that POSTs `{pieceIndex, rotation, row, col}` and re-renders
 * from the JSON state the server returns.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  cancelRematch,
  getMatch,
  getSeriesScore,
  recordSubmission,
  requestRematch,
  trySettleMatch,
  type ArcadeMatchRow,
} from "./db.js";
import {
  applyMoveForPlayer,
  clearRuntime,
  ensureRuntime,
  getRuntime,
  rebuildState,
} from "./runtime.js";
import { pieceForSlot } from "./match.js";
import { rotateCells } from "./pieces.js";
import {
  BOARD_SIZE,
  PIECES_PER_LEVEL,
  type Move,
  type PieceCell,
  type PlayerState,
} from "./types.js";
import { issueMatchToken, verifyMatchToken } from "./tokens.js";
import { onMatchSettled } from "./notify.js";
import { buildSpectatorSnapshot } from "./spectate.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";

/* ────────────────────────────────────────────────────────────────── */
/*  Public dispatcher                                                  */
/* ────────────────────────────────────────────────────────────────── */

export async function handleArcadeWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" && path === "/arcade" ) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return true;
  }
  if (method === "GET" && path === "/arcade/play") {
    sendHtml(res, 200, renderArcadePlayPage({
      requiresToken: true,
      tokenParam: "t",
      missingAccessHtml: '<div class="wrap"><h2>Missing token.</h2><p>Open this page from the link Discord gave you.</p></div>',
      statePath: "/arcade/api/state",
      movePath: "/arcade/api/move",
      submitPath: "/arcade/api/submit",
      doneMessage: "You can close this tab — the result is posted in Discord.",
    }));
    return true;
  }
  if (method === "GET" && path === "/arcade/api/state") {
    await respond(req, res, async (claim) => buildStateResponse(claim.matchId, claim.userId));
    return true;
  }
  if (method === "POST" && path === "/arcade/api/move") {
    await respondWithBody(req, res, async (claim, body) => {
      const kind = typeof body.kind === "string" ? body.kind : "place";
      const move: Move =
        kind === "bank"
          ? {
              kind: "bank",
              level: numField(body, "level"),
              pieceIndex: numField(body, "pieceIndex"),
            }
          : {
              level: numField(body, "level"),
              pieceIndex: numField(body, "pieceIndex"),
              rotation: (numField(body, "rotation") % 4) as 0 | 1 | 2 | 3,
              row: numField(body, "row"),
              col: numField(body, "col"),
            };
      await ensureMatchRuntimeLoaded(claim.matchId);
      const current = await getMatch(claim.matchId);
      if (current && current.status === "waiting") {
        return { status: 409, body: { error: "Waiting for opponent" } };
      }
      const expired = await settleExpiredMatchIfNeeded(claim.matchId);
      if (expired && expired.status !== "active" && expired.status !== "submitted") {
        return {
          status: 200,
          body: await buildStateResponse(claim.matchId, claim.userId, {
            match: expired,
            skipExpireCheck: true,
          }),
        };
      }
      const result = applyMoveForPlayer(claim.matchId, claim.userId, move);
      if (!("ok" in result) || !result.ok) {
        return { status: 400, body: { error: (result as { error: string }).error } };
      }
      // Best-effort draft persist so a restart can recover.
      const state = result.state;
      persistDraft(claim.matchId, claim.userId, state).catch(() => {});
      return {
        status: 200,
        body: await buildStateResponse(claim.matchId, claim.userId, {
          match: expired ?? current ?? undefined,
          skipExpireCheck: true,
          skipSeries: true,
        }),
      };
    });
    return true;
  }
  if (method === "POST" && path === "/arcade/api/rematch") {
    await respondWithBody(req, res, async (claim) => {
      const result = await requestRematch(claim.matchId, claim.userId);
      if (result.status === "error") {
        return { status: 400, body: { error: result.error } };
      }
      const body: Record<string, unknown> = {
        status: result.status,
        match: { id: claim.matchId },
      };
      if (result.status === "created") {
        body.nextMatchId = result.nextMatchId;
        body.nextToken = issueMatchToken(result.nextMatchId, claim.userId);
        body.redirect = `/arcade/play?t=${encodeURIComponent(body.nextToken as string)}`;
      }
      return { status: 200, body };
    });
    return true;
  }
  if (method === "POST" && path === "/arcade/api/rematch/cancel") {
    await respondWithBody(req, res, async (claim) => {
      const result = await cancelRematch(claim.matchId, claim.userId);
      if (!result.ok) return { status: 400, body: { error: result.error ?? "Cancel failed" } };
      return { status: 200, body: { ok: true } };
    });
    return true;
  }
  if (method === "GET" && path === "/arcade/watch") {
    sendHtml(res, 200, renderArcadeWatchPage());
    return true;
  }
  if (method === "GET" && path === "/arcade/api/spectate-state") {
    try {
      const matchIdRaw = url.searchParams.get("match");
      const matchId = matchIdRaw ? parseInt(matchIdRaw, 10) : NaN;
      if (!Number.isFinite(matchId) || matchId <= 0) {
        sendJson(res, 400, { error: "Missing or invalid match id" });
        return true;
      }
      const m = await getMatch(matchId);
      if (!m) {
        sendJson(res, 404, { error: "Match not found" });
        return true;
      }
      if (m.mode === "practice") {
        sendJson(res, 403, { error: "Practice matches can't be spectated" });
        return true;
      }
      if (m.status === "waiting") {
        sendJson(res, 200, { type: "waiting", matchId, mode: m.mode });
        return true;
      }
      await ensureMatchRuntimeLoaded(matchId);
      const snapshot = await buildSpectatorSnapshot(matchId);
      if (!snapshot) {
        sendJson(res, 404, { error: "Snapshot unavailable" });
        return true;
      }
      sendJson(res, 200, snapshot);
    } catch (err) {
      console.error("[Spectate] state route error:", (err as Error)?.message ?? err);
      sendJson(res, 500, { error: "Internal error" });
    }
    return true;
  }
  if (method === "POST" && path === "/arcade/api/submit") {
    await respondWithBody(req, res, async (claim) => {
      await ensureMatchRuntimeLoaded(claim.matchId);
      const current = await getMatch(claim.matchId);
      if (current && current.status === "waiting") {
        return { status: 409, body: { error: "Waiting for opponent" } };
      }
      const expired = await settleExpiredMatchIfNeeded(claim.matchId);
      if (expired && expired.status !== "active" && expired.status !== "submitted") {
        return { status: 200, body: await buildStateResponse(claim.matchId, claim.userId) };
      }
      const runtime = getRuntime(claim.matchId);
      if (!runtime) return { status: 404, body: { error: "Match not found" } };
      const playerState = runtime.players.get(claim.userId);
      if (!playerState) return { status: 403, body: { error: "Not a player in this match" } };

      await recordSubmission({
        matchId: claim.matchId,
        userId: claim.userId,
        moveLog: playerState.moves,
        claimedScore: playerState.score,
        validatedScore: playerState.score,
        valid: true,
      });

      const settlement = await trySettleMatch(claim.matchId);
      // Notify spectators + refresh Discord card BEFORE clearing the
      // runtime so the final snapshot still has board state.
      onMatchSettled(claim.matchId);
      if (settlement.status !== "waiting") clearRuntime(claim.matchId);

      return { status: 200, body: await buildStateResponse(claim.matchId, claim.userId) };
    });
    return true;
  }

  return false;
}

/* ────────────────────────────────────────────────────────────────── */
/*  State assembly                                                     */
/* ────────────────────────────────────────────────────────────────── */

type StateResponse = {
  match: {
    id: number;
    mode: ArcadeMatchRow["mode"];
    status: ArcadeMatchRow["status"];
    stakeSats: number | null;
    grossPotSats: number | null;
    winnerPayoutSats: number | null;
    stakeFormatted: string | null;
    grossPotFormatted: string | null;
    winnerPayoutFormatted: string | null;
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
    phase: "playing" | "finished";
    endReason?: string;
    submitted: boolean;
    pieces: Array<{ cells: PieceCell[] | null; placed: boolean }>;
    bank: { cells: PieceCell[] } | null;
    board: number[][];
  };
  opponent: {
    userId: string | null;
    submitted: boolean;
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
    settlementTxHash?: string | null;
    settlementExplorerUrl?: string | null;
    rematchRequestedBySelf: boolean;
    rematchRequestedByOpponent: boolean;
    nextMatchId: number | null;
    nextSessionId: string | null;
    redirect: string | null;
    series: { youWins: number; opponentWins: number; ties: number; total: number };
  };
  boardSize: number;
};

async function buildStateResponse(
  matchId: number,
  userId: string,
  options: { match?: ArcadeMatchRow; skipExpireCheck?: boolean; skipSeries?: boolean } = {}
): Promise<StateResponse | { error: string }> {
  let match = options.match ?? await getMatch(matchId);
  if (!match) return { error: "Match not found" };
  if (!options.skipExpireCheck) {
    match = (await settleExpiredMatchIfNeeded(matchId)) ?? match;
  }

  const isPracticeOrPlayer =
    match.mode === "practice"
      ? match.player_a_id === userId
      : [match.player_a_id, match.player_b_id].includes(userId);
  if (!isPracticeOrPlayer) return { error: "Not a player in this match" };

  await ensureMatchRuntimeLoaded(matchId);
  const runtime = getRuntime(matchId);
  if (!runtime) return { error: "Match runtime unavailable" };
  const state = runtime.players.get(userId);
  if (!state) return { error: "Player state not found" };

  const pieces: Array<{ cells: PieceCell[] | null; placed: boolean }> = [];
  for (let i = 0; i < PIECES_PER_LEVEL; i++) {
    const slot = pieceForSlot(state, runtime.sequence, state.level, i);
    pieces.push({ cells: slot ? slot.cells : null, placed: state.placedThisLevel[i] });
  }
  const bank = state.bank ? { cells: state.bank.cells } : null;

  const opponentId =
    match.mode === "practice"
      ? null
      : match.player_a_id === userId
        ? match.player_b_id
        : match.player_a_id;

  const submittedSelf =
    match.player_a_id === userId
      ? match.player_a_submitted
      : match.player_b_submitted;
  const submittedOpp = opponentId
    ? opponentId === match.player_a_id
      ? match.player_a_submitted
      : match.player_b_submitted
    : false;
  const opponentScore = opponentId
    ? opponentId === match.player_a_id
      ? match.player_a_score
      : match.player_b_score
    : null;

  const aScore = match.player_a_score ?? null;
  const bScore = match.player_b_score ?? null;
  const completed = match.status === "completed";
  const isTie = completed && match.winner_id == null;
  const isWinner = completed ? match.winner_id === userId : null;

  const isPlayerA = match.player_a_id === userId;
  const rematchSelf = isPlayerA ? match.rematch_requested_by_a : match.rematch_requested_by_b;
  const rematchOpp = match.mode === "practice"
    ? false
    : isPlayerA
      ? match.rematch_requested_by_b
      : match.rematch_requested_by_a;
  const defaultSeries = {
    rootId: matchId,
    totalCompleted: 0,
    youWins: 0,
    opponentWins: 0,
    ties: 0,
  };
  const shouldLoadSeries =
    !options.skipSeries ||
    completed ||
    (match.series_root_id != null && match.series_root_id !== match.id) ||
    !!match.next_match_id ||
    !!match.next_session_id;
  const series = shouldLoadSeries
    ? (await getSeriesScore(matchId, userId)) ?? defaultSeries
    : defaultSeries;
  let redirect: string | null = null;
  if (match.next_match_id) {
    const nextMatch = await getMatch(match.next_match_id);
    if (nextMatch && nextMatch.status !== "waiting" && nextMatch.status !== "cancelled") {
      const nextToken = issueMatchToken(match.next_match_id, userId);
      redirect = `/arcade/play?t=${encodeURIComponent(nextToken)}`;
    }
  } else if (match.next_session_id) {
    redirect = `/session/${match.next_session_id}`;
  }

  return {
    boardSize: BOARD_SIZE,
    match: {
      id: match.id,
      mode: match.mode,
      status: match.status,
      stakeSats: match.stake_amount_sats,
      grossPotSats: match.gross_pot_sats,
      winnerPayoutSats: match.winner_payout_sats,
      stakeFormatted: match.stake_amount_sats != null ? formatSats(match.stake_amount_sats) : null,
      grossPotFormatted: match.gross_pot_sats != null ? formatSats(match.gross_pot_sats) : null,
      winnerPayoutFormatted:
        match.winner_payout_sats != null ? formatSats(match.winner_payout_sats) : null,
      durationSeconds: match.duration_seconds ?? 180,
      startedAt: match.started_at,
      deadlineAt: deadlineAt(match)?.toISOString() ?? null,
      serverNow: new Date().toISOString(),
    },
    self: {
      userId,
      score: state.score,
      multiplier: state.multiplier,
      level: state.level,
      levelDisplay: state.level + 1,
      maxLevels: null,
      phase: state.phase,
      endReason: state.endReason,
      submitted: submittedSelf,
      pieces,
      bank,
      board: state.board,
    },
    opponent:
      match.mode === "practice"
        ? null
        : {
            userId: opponentId,
            submitted: submittedOpp,
            score: opponentScore,
          },
    result: {
      completed,
      winnerId: match.winner_id,
      isWinner,
      isTie,
      aScore,
      bScore,
      payoutFormatted:
        completed && isWinner && match.winner_payout_sats != null
          ? formatSats(match.winner_payout_sats)
          : null,
      rematchRequestedBySelf: !!rematchSelf,
      rematchRequestedByOpponent: !!rematchOpp,
      nextMatchId: match.next_match_id,
      nextSessionId: match.next_session_id,
      redirect,
      series: {
        youWins: series.youWins,
        opponentWins: series.opponentWins,
        ties: series.ties,
        total: series.totalCompleted,
      },
    },
  };
}

function deadlineAt(match: ArcadeMatchRow): Date | null {
  if (!["active", "submitted"].includes(match.status)) return null;
  const start = match.started_at ?? match.created_at;
  if (!start) return null;
  const durationSeconds = match.duration_seconds ?? 180;
  return new Date(new Date(start).getTime() + durationSeconds * 1000);
}

async function settleExpiredMatchIfNeeded(matchId: number): Promise<ArcadeMatchRow | null> {
  const match = await getMatch(matchId);
  if (!match || match.status === "completed" || match.status === "cancelled") return match;
  const deadline = deadlineAt(match);
  if (!deadline || Date.now() < deadline.getTime()) return match;

  await ensureMatchRuntimeLoaded(matchId);
  const runtime = getRuntime(matchId);
  if (!runtime) return match;

  const playerIds =
    match.mode === "practice"
      ? [match.player_a_id]
      : [match.player_a_id, match.player_b_id].filter(Boolean) as string[];
  const submitted = new Set<string>();
  if (match.player_a_submitted) submitted.add(match.player_a_id);
  if (match.player_b_id && match.player_b_submitted) submitted.add(match.player_b_id);

  for (const playerId of playerIds) {
    if (submitted.has(playerId)) continue;
    const playerState = runtime.players.get(playerId);
    await recordSubmission({
      matchId,
      userId: playerId,
      moveLog: playerState?.moves ?? [],
      claimedScore: playerState?.score ?? 0,
      validatedScore: playerState?.score ?? 0,
      valid: true,
    });
  }

  const settlement = await trySettleMatch(matchId);
  if (settlement.status !== "waiting") {
    clearRuntime(matchId);
    onMatchSettled(matchId);
  }
  return settlement.match;
}

export async function ensureMatchRuntimeLoaded(matchId: number): Promise<void> {
  const existing = getRuntime(matchId);
  if (existing && existing.players.size > 0) return;

  const match = await getMatch(matchId);
  if (!match) return;
  const playerIds = [match.player_a_id, match.player_b_id].filter(Boolean) as string[];
  const runtime = ensureRuntime(matchId, match.seed, playerIds);

  const { data: subs } = await supabase
    .from("arcade_submissions")
    .select("user_id, move_log")
    .eq("match_id", matchId);

  for (const sub of subs ?? []) {
    try {
      const restored = rebuildState(match.seed, (sub.move_log as Move[]) ?? []);
      runtime.players.set(sub.user_id, restored);
    } catch {
      // Corrupted log — leave fresh state and let the player keep playing.
    }
  }
}

async function persistDraft(matchId: number, userId: string, state: PlayerState): Promise<void> {
  await supabase.from("arcade_submissions").upsert(
    {
      match_id: matchId,
      user_id: userId,
      move_log: state.moves,
      claimed_score: state.score,
      validated_score: state.score,
      valid: null,
      validation_error: null,
    },
    { onConflict: "match_id,user_id" }
  );
}

/* ────────────────────────────────────────────────────────────────── */
/*  Request plumbing                                                   */
/* ────────────────────────────────────────────────────────────────── */

type Claim = ReturnType<typeof verifyMatchToken>;

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (claim: NonNullable<Claim>) => Promise<unknown>
): Promise<void> {
  const claim = readClaim(req);
  if (!claim) return sendJson(res, 401, { error: "Invalid or expired token" });
  try {
    const out = await handler(claim);
    if (out && typeof out === "object" && "error" in out) {
      sendJson(res, 400, out);
      return;
    }
    sendJson(res, 200, out);
  } catch (err) {
    console.error("[ArcadeWeb] handler error:", (err as Error)?.message ?? err);
    sendJson(res, 500, { error: "Internal error" });
  }
}

async function respondWithBody(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (
    claim: NonNullable<Claim>,
    body: Record<string, unknown>
  ) => Promise<{ status: number; body: unknown }>
): Promise<void> {
  const claim = readClaim(req);
  if (!claim) return sendJson(res, 401, { error: "Invalid or expired token" });
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Bad JSON body" });
  }
  try {
    const out = await handler(claim, body);
    sendJson(res, out.status, out.body);
  } catch (err) {
    console.error("[ArcadeWeb] handler error:", (err as Error)?.message ?? err);
    sendJson(res, 500, { error: "Internal error" });
  }
}

function readClaim(req: IncomingMessage): NonNullable<Claim> | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const fromQuery = url.searchParams.get("t");
  const fromHeader = req.headers["x-arcade-token"];
  const token =
    (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) || fromQuery || null;
  return verifyMatchToken(token);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 64 * 1024) throw new Error("Body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function numField(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Bad field: ${key}`);
  }
  return Math.trunc(v);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

/* ────────────────────────────────────────────────────────────────── */
/*  Spectator HTML page                                                */
/* ────────────────────────────────────────────────────────────────── */

export function renderArcadeWatchPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Slice Arcade — Watch</title>
<style>
  :root {
    --bg: #0c0f14;
    --panel: #161b22;
    --border: #2a313c;
    --text: #e8edf2;
    --muted: #8a94a4;
    --accent: #00cc6a;
    --tip: #ffaa00;
    --cell-empty: #1f2630;
    --cell-normal: #00cc6a;
    --cell-mult: #ffaa00;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); margin: 0; min-height: 100vh; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 12px; color: var(--muted); font-weight: 500; }
  h1 .id { color: var(--text); }
  .status-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .pill { background: var(--panel); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 13px; color: var(--muted); }
  .pill.live { color: var(--accent); border-color: var(--accent); }
  .pill.tipfight { color: var(--tip); border-color: var(--tip); }
  .boards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 700px) { .boards { grid-template-columns: 1fr; } }
  .player-panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
  .player-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; gap: 12px; flex-wrap: wrap; }
  .player-name { font-size: 16px; font-weight: 600; word-break: break-word; }
  .player-id { font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; }
  .player-stats { font-size: 13px; color: var(--muted); }
  .player-score { font-size: 24px; font-weight: 700; color: var(--accent); margin: 4px 0 12px; }
  .player-score.tipfight-staker { color: var(--tip); }
  .submitted-tag { display: inline-block; margin-left: 8px; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--accent); color: #000; vertical-align: middle; }
  .board { display: grid; grid-template-columns: repeat(9, 1fr); gap: 2px; aspect-ratio: 1/1; background: var(--border); padding: 2px; border-radius: 6px; }
  .cell { background: var(--cell-empty); border-radius: 2px; aspect-ratio: 1/1; transition: background 0.1s; }
  .cell.normal { background: var(--cell-normal); }
  .cell.mult { background: var(--cell-mult); }
  .pieces { display: flex; gap: 6px; margin-top: 12px; align-items: flex-start; flex-wrap: wrap; }
  .piece { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
  .piece.placed { opacity: 0.3; }
  .mini-grid { display: grid; gap: 1px; background: var(--border); padding: 1px; border-radius: 3px; }
  .mini-cell { width: 10px; height: 10px; }
  .mini-cell.normal { background: var(--cell-normal); }
  .mini-cell.mult { background: var(--cell-mult); }
  .mini-cell.empty { background: transparent; }
  .conn { position: fixed; bottom: 12px; right: 12px; font-size: 11px; color: var(--muted); padding: 4px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 999px; }
  .conn.connected { color: var(--accent); border-color: var(--accent); }
  .empty-state { padding: 32px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<h1>Slice Arcade — Match <span class="id" id="match-id">…</span></h1>
<div class="status-bar" id="status-bar"></div>
<div id="content"><div class="empty-state">Loading match…</div></div>
<div class="conn" id="conn">connecting…</div>
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const matchId = params.get("match");
  document.getElementById("match-id").textContent = "#" + (matchId ?? "?");
  if (!matchId) {
    document.getElementById("content").innerHTML = '<div class="empty-state">Missing match id. Use the Watch link from Discord.</div>';
    return;
  }

  const conn = document.getElementById("conn");
  const content = document.getElementById("content");
  const statusBar = document.getElementById("status-bar");

  function renderPiece(piece) {
    if (!piece || !piece.cells || piece.cells.length === 0) {
      return '<div class="piece placed" style="width:32px;height:32px"></div>';
    }
    const xs = piece.cells.map(c => c.x);
    const ys = piece.cells.map(c => c.y);
    const w = Math.max(...xs) + 1;
    const h = Math.max(...ys) + 1;
    let cellsHtml = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = piece.cells.find(c2 => c2.x === x && c2.y === y);
        const cls = c ? (c.kind === "multiplier" ? "mult" : "normal") : "empty";
        cellsHtml += '<div class="mini-cell ' + cls + '"></div>';
      }
    }
    return '<div class="mini-grid" style="grid-template-columns:repeat(' + w + ',10px)">' + cellsHtml + '</div>';
  }

  function renderPlayer(p, isStaker, mode) {
    const board = p.board || Array.from({length:9}, () => Array(9).fill(0));
    let cellsHtml = '';
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const v = board[r] && board[r][c];
        const cls = v === 1 ? "normal" : v === 2 ? "mult" : "";
        cellsHtml += '<div class="cell ' + cls + '"></div>';
      }
    }
    const piecesHtml = (p.currentPieces || []).map((piece, i) => {
      const placed = (p.placedThisLevel || [])[i];
      return '<div class="piece ' + (placed ? "placed" : "") + '">' + renderPiece(piece) + '</div>';
    }).join("");
    const submittedTag = p.submitted ? '<span class="submitted-tag">submitted</span>' : '';
    const scoreClass = (mode === "tipfight" && isStaker) ? "tipfight-staker" : "";
    const stakerLabel = (mode === "tipfight" && isStaker) ? ' 💰 Staker' : (mode === "tipfight" && !isStaker ? ' ⚔️ Challenger' : '');
    return '' +
      '<div class="player-panel">' +
        '<div class="player-head">' +
          '<div>' +
            '<div class="player-name">' + escapeHtml(p.displayName) + stakerLabel + submittedTag + '</div>' +
            '<div class="player-id">' + escapeHtml(p.id) + '</div>' +
          '</div>' +
          '<div class="player-stats">Lvl ' + (p.level + 1) + ' · ×' + p.multiplier.toFixed(1) + '</div>' +
        '</div>' +
        '<div class="player-score ' + scoreClass + '">' + p.score.toLocaleString() + '</div>' +
        '<div class="board">' + cellsHtml + '</div>' +
        '<div class="pieces">' + piecesHtml + '</div>' +
      '</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function render(snap) {
    if (snap.type === "waiting") {
      content.innerHTML = '<div class="empty-state">Match #' + snap.matchId + ' is waiting for an opponent. Refresh once the match starts.</div>';
      statusBar.innerHTML = '<div class="pill">Waiting</div>';
      return;
    }
    const modeClass = snap.mode === "tipfight" ? "tipfight" : "live";
    const modeLabel = snap.mode === "tipfight" ? "💰 Fight for tip" : snap.mode === "staked_pvp" ? "Staked PvP" : "Free PvP";
    const statusLabel = snap.status === "completed" ? "🏁 Final" : snap.status === "submitted" ? "📝 Awaiting submission" : "🎮 Live";
    const stakeLine = snap.stake ? '<div class="pill ' + modeClass + '">' + snap.stake.toLocaleString() + ' sats</div>' : '';
    statusBar.innerHTML =
      '<div class="pill ' + modeClass + '">' + modeLabel + '</div>' +
      '<div class="pill live">' + statusLabel + '</div>' + stakeLine;
    const players = snap.players || [];
    if (players.length === 0) {
      content.innerHTML = '<div class="empty-state">No players in this match.</div>';
      return;
    }
    content.innerHTML = '<div class="boards">' +
      players.map((p, i) => renderPlayer(p, i === 0, snap.mode)).join("") +
      '</div>';
  }

  // Initial paint via JSON
  fetch("/arcade/api/spectate-state?match=" + encodeURIComponent(matchId), { cache: "no-store" })
    .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
    .then(render)
    .catch(err => { content.innerHTML = '<div class="empty-state">Could not load match: ' + escapeHtml(String(err)) + '</div>'; });

  // Live updates via WebSocket
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/arcade/spectate?match=" + encodeURIComponent(matchId);
  let ws;
  let reconnectDelay = 1000;
  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => { conn.textContent = "live"; conn.classList.add("connected"); reconnectDelay = 1000; };
    ws.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); } catch {}
    };
    ws.onclose = (ev) => {
      conn.textContent = "disconnected"; conn.classList.remove("connected");
      if (ev.code === 1000) return; // match completed normally
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connect();
})();
</script>
</body>
</html>`;
}

/* ────────────────────────────────────────────────────────────────── */
/*  HTML page                                                          */
/* ────────────────────────────────────────────────────────────────── */

export function renderArcadePlayPage(options: {
  requiresToken: boolean;
  tokenParam?: string;
  missingAccessHtml: string;
  statePath: string;
  movePath: string;
  submitPath: string;
  doneMessage: string;
}): string {
  const clientConfig = JSON.stringify({
    requiresToken: options.requiresToken,
    tokenParam: options.tokenParam ?? "t",
    missingAccessHtml: options.missingAccessHtml,
    statePath: options.statePath,
    movePath: options.movePath,
    submitPath: options.submitPath,
    doneMessage: options.doneMessage,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Slice Arcade — PvP</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg-1: #06080f;
    --bg-2: #0c1322;
    --bg-3: #131b30;
    --line: rgba(255,255,255,.08);
    --line-strong: rgba(255,255,255,.18);
    --text: #eef3ff;
    --muted: #8a93a6;
    --neon: #00ff9d;
    --neon-2: #1ee881;
    --cyan: #4ff7ff;
    --blue: #4f8cff;
    --purple: #a06bff;
    --pink: #ff5fa3;
    --orange: #ff8a1a;
    --orange-2: #ffb04a;
    --red: #ff4d6d;
    --gold: #ffd86b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: var(--text); font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif; background: #06080f; overflow-x: hidden; overscroll-behavior-x: none; -webkit-tap-highlight-color: transparent; }
  .display { font-family: "Orbitron", "Space Grotesk", ui-sans-serif, system-ui, sans-serif; }
  body { min-height: 100vh; position: relative; }
  body.shake { animation: shake .35s cubic-bezier(.36,.07,.19,.97); }
  body.shake-big { animation: shakeBig .6s cubic-bezier(.36,.07,.19,.97); }
  @keyframes shake { 0%,100% { transform: translate3d(0,0,0); } 10% { transform: translate3d(-4px,2px,0); } 25% { transform: translate3d(6px,-3px,0); } 40% { transform: translate3d(-5px,4px,0); } 60% { transform: translate3d(4px,-2px,0); } 80% { transform: translate3d(-2px,1px,0); } }
  @keyframes shakeBig { 0%,100% { transform: translate3d(0,0,0); } 8% { transform: translate3d(-9px,5px,0) rotate(-.4deg); } 22% { transform: translate3d(11px,-7px,0) rotate(.5deg); } 38% { transform: translate3d(-12px,8px,0) rotate(-.5deg); } 55% { transform: translate3d(8px,-4px,0) rotate(.3deg); } 75% { transform: translate3d(-5px,3px,0); } }

  /* Animated background layers */
  .bg-grid { position: fixed; inset: 0; pointer-events: none; z-index: 0; background:
    radial-gradient(1200px 800px at 20% -10%, rgba(80,140,255,.18), transparent 60%),
    radial-gradient(1100px 700px at 100% 110%, rgba(160,107,255,.16), transparent 60%),
    radial-gradient(900px 600px at 0% 100%, rgba(0,255,157,.12), transparent 60%),
    linear-gradient(180deg, #06080f 0%, #0a0f1c 50%, #06080f 100%);
  }
  .bg-grid::before { content: ""; position: absolute; inset: -2px;
    background-image:
      linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at center, rgba(0,0,0,.85), transparent 75%);
    -webkit-mask-image: radial-gradient(ellipse at center, rgba(0,0,0,.85), transparent 75%);
    animation: gridDrift 30s linear infinite;
  }
  @keyframes gridDrift { from { transform: translate(0,0); } to { transform: translate(-48px,-48px); } }

  .bg-orbs { position: fixed; inset: 0; pointer-events: none; z-index: 1; overflow: hidden; }
  .orb { position: absolute; border-radius: 50%; filter: blur(70px); opacity: .35; mix-blend-mode: screen; }
  .o1 { width: 420px; height: 420px; background: #4f8cff; top: -140px; left: -120px; animation: orb1 18s ease-in-out infinite alternate; }
  .o2 { width: 520px; height: 520px; background: #ff5fa3; bottom: -160px; right: -120px; animation: orb2 22s ease-in-out infinite alternate; }
  .o3 { width: 360px; height: 360px; background: #00ff9d; top: 30%; right: 15%; animation: orb3 16s ease-in-out infinite alternate; }
  @keyframes orb1 { 0% { transform: translate(0,0) scale(1); } 100% { transform: translate(80px,60px) scale(1.2); } }
  @keyframes orb2 { 0% { transform: translate(0,0) scale(1); } 100% { transform: translate(-100px,-60px) scale(1.1); } }
  @keyframes orb3 { 0% { transform: translate(0,0) scale(1); } 100% { transform: translate(-60px,40px) scale(1.25); } }

  /* Particle canvas overlay */
  #fx { position: fixed; inset: 0; pointer-events: none; z-index: 50; }

  .wrap { position: relative; z-index: 2; max-width: min(1380px, 98vw); margin: 0 auto; padding: clamp(12px, 1.6vw, 24px) clamp(10px, 2vw, 28px) 80px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .title { font-family: "Orbitron", "Space Grotesk", sans-serif; font-weight: 900; font-size: clamp(20px, 2.6vw, 32px); letter-spacing: .14em; background: linear-gradient(90deg, #4ff7ff, #1ee881 35%, #ffd86b 65%, #ff5fa3); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 0 0 30px rgba(79,247,255,.25); animation: titleGradient 6s linear infinite; }
  @keyframes titleGradient { from { background-position: 0% 0; } to { background-position: 200% 0; } }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; background: rgba(20,26,40,.55); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); color: var(--muted); font-size: 12px; font-weight: 600; }
  .badge.live { color: var(--neon-2); border-color: rgba(30,232,129,.45); background: rgba(30,232,129,.1); animation: liveBlink 1.6s ease-in-out infinite; }
  .topRight { display: flex; align-items: center; gap: 10px; }
  .iconBtn { width: 38px; height: 38px; border-radius: 999px; border: 1px solid var(--line); background: rgba(20,26,40,.6); color: var(--text); font-size: 18px; line-height: 1; cursor: pointer; transition: transform .12s, border-color .15s, background .15s, box-shadow .2s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: inline-flex; align-items: center; justify-content: center; }
  .iconBtn:hover { transform: translateY(-1px) scale(1.06); border-color: rgba(255,255,255,.3); background: rgba(30,38,56,.7); box-shadow: 0 6px 18px -6px rgba(0,0,0,.5); }
  .iconBtn:active { transform: scale(.94); }
  .iconBtn.muted { color: var(--muted); border-color: rgba(255,77,109,.35); }
  @keyframes liveBlink { 0%,100% { box-shadow: 0 0 0 0 rgba(30,232,129,.6); } 50% { box-shadow: 0 0 0 6px rgba(30,232,129,0); } }

  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
  .stat { background: linear-gradient(135deg, rgba(20,26,40,.6), rgba(13,18,30,.6)); border: 1px solid var(--line); border-radius: 16px; padding: 10px 12px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); position: relative; overflow: hidden; }
  .stat::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255,255,255,.06), transparent 50%); pointer-events: none; }
  .stat .label { font-family: "Orbitron", "Space Grotesk", sans-serif; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .18em; font-weight: 700; }
  .stat .value { font-family: "Orbitron", "Space Grotesk", sans-serif; font-weight: 800; font-size: clamp(18px, 2.2vw, 26px); margin-top: 2px; font-variant-numeric: tabular-nums; letter-spacing: .02em; transition: color .25s, text-shadow .25s; position: relative; }
  .stat.bump .value { animation: bump .45s cubic-bezier(.34,1.56,.64,1); }
  @keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.45); } 100% { transform: scale(1); } }
  .stat.glow .value { text-shadow: 0 0 18px currentColor, 0 0 32px currentColor; }
  .stat.score .value { color: #fff; }
  .stat.score.glow .value { color: var(--gold); }
  .stat.mult .value { color: var(--orange-2); }
  .stat.mult.glow .value { color: #fff; text-shadow: 0 0 22px var(--orange), 0 0 40px var(--orange); }
  .stat.time .value { color: var(--neon-2); }
  .stat.time.low .value { color: var(--red); animation: pulseLow 1s infinite; }
  @keyframes pulseLow { 0%,100% { opacity: 1; } 50% { opacity: .55; } }

  .pot { background: linear-gradient(135deg, rgba(255,216,107,.08), rgba(255,95,163,.08)); border: 1px solid rgba(255,216,107,.25); border-radius: 14px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: var(--muted); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
  .pot strong { color: var(--gold); text-shadow: 0 0 12px rgba(255,216,107,.55); }

  /* Board */
  .game-shell { display: grid; grid-template-columns: minmax(0, 1fr) minmax(270px, 340px); gap: clamp(12px, 2vw, 24px); align-items: start; }
  .side-panel { display: flex; flex-direction: column; gap: 12px; position: sticky; top: 14px; max-height: calc(100vh - 28px); overflow-y: auto; padding-right: 2px; }
  .board-wrap { position: relative; perspective: 1200px; display: flex; justify-content: center; }
  .board { display: grid; grid-template-columns: repeat(9, 1fr); width: min(100%, 760px, calc(100vh - 170px)); max-width: 760px; min-width: 0; gap: 4px; padding: 10px; background: linear-gradient(135deg, rgba(20,26,40,.7), rgba(13,18,30,.85)); border: 1px solid var(--line-strong); border-radius: 20px; aspect-ratio: 1 / 1; user-select: none; touch-action: manipulation; box-shadow: 0 30px 60px -20px rgba(0,0,0,.65), inset 0 0 0 1px rgba(255,255,255,.04); transition: transform .25s ease, box-shadow .3s ease; transform-style: preserve-3d; position: relative; overflow: hidden; }
  .board::before { content: ""; position: absolute; inset: 0; background: radial-gradient(circle 320px at var(--mx, 50%) var(--my, 50%), rgba(79,247,255,.14), transparent 60%); pointer-events: none; transition: opacity .3s; opacity: 0; z-index: 0; }
  .board.active::before { opacity: 1; }
  .board > * { position: relative; z-index: 1; }
  .cell { background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.18)); border-radius: 8px; aspect-ratio: 1 / 1; position: relative; transition: background .12s ease, transform .12s cubic-bezier(.34,1.56,.64,1), box-shadow .15s; cursor: pointer; }
  .cell:hover { background: rgba(255,255,255,.06); }
  .cell.fill-1 { background: linear-gradient(135deg, #5a99ff 0%, #2a55c6 100%); box-shadow: inset 0 -3px 0 rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.28), 0 0 14px rgba(79,140,255,.45); }
  .cell.fill-2 { background: linear-gradient(135deg, #ffc274 0%, #ff5a1a 100%); box-shadow: inset 0 -3px 0 rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.4), 0 0 18px rgba(255,138,26,.6); animation: multShimmer 2.4s linear infinite; }
  @keyframes multShimmer { 0% { filter: hue-rotate(0deg) brightness(1); } 50% { filter: hue-rotate(20deg) brightness(1.18); } 100% { filter: hue-rotate(0deg) brightness(1); } }
  .cell.placed-now { animation: dropIn .5s cubic-bezier(.34,1.56,.64,1); }
  @keyframes dropIn { 0% { transform: translateY(-42px) scale(.3); opacity: 0; filter: brightness(2.2); } 45% { transform: translateY(0) scale(1.32); opacity: 1; filter: brightness(1.7); } 68% { transform: translateY(0) scale(.9); filter: brightness(1.25); } 86% { transform: translateY(0) scale(1.05); filter: brightness(1.05); } 100% { transform: translateY(0) scale(1); filter: brightness(1); } }
  .cell.clearing { animation: cellClear .6s cubic-bezier(.55,.085,.68,.53) forwards; z-index: 2; }
  @keyframes cellClear { 0% { transform: scale(1); filter: brightness(1); } 25% { transform: scale(1.4) rotate(8deg); filter: brightness(2.4) saturate(2); background: linear-gradient(135deg, #fff, #fff); box-shadow: 0 0 30px #fff, 0 0 60px rgba(255,255,255,.7); } 100% { transform: scale(0) rotate(40deg); opacity: 0; filter: brightness(1); } }
  .cell.ghost-ok { background: linear-gradient(135deg, rgba(30,232,129,.55), rgba(0,204,106,.35)); box-shadow: inset 0 0 0 2px rgba(30,232,129,.65), 0 0 14px rgba(30,232,129,.4); animation: ghostPulse 1.2s ease-in-out infinite; }
  .cell.ghost-mult { background: linear-gradient(135deg, rgba(255,176,74,.65), rgba(255,90,26,.4)); box-shadow: inset 0 0 0 2px rgba(255,176,74,.7), 0 0 18px rgba(255,138,26,.55); animation: ghostPulse 1.2s ease-in-out infinite; }
  .cell.ghost-bad { background: linear-gradient(135deg, rgba(255,77,109,.55), rgba(180,40,70,.4)); box-shadow: inset 0 0 0 2px rgba(255,77,109,.6); animation: ghostShake .35s ease-in-out infinite; }
  @keyframes ghostPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
  @keyframes ghostShake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-1.5px); } 75% { transform: translateX(1.5px); } }
  .cell.keyboard-cursor { outline: 2px solid var(--neon); outline-offset: -2px; box-shadow: 0 0 0 3px rgba(0,255,157,.3); }

  /* Pieces + bank */
  .pieces-row { display: grid; grid-template-columns: 1fr; gap: 10px; align-items: stretch; }
  .pieces { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .bank { background: linear-gradient(135deg, rgba(255,216,107,.08), rgba(160,107,255,.08)); border: 1px solid rgba(255,216,107,.3); border-radius: 16px; padding: 12px; min-height: 120px; display: flex; flex-direction: column; gap: 8px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); position: relative; overflow: hidden; }
  .bank.empty { opacity: .55; border-style: dashed; }
  .bank.active { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(255,216,107,.3), 0 12px 30px -10px rgba(255,216,107,.45); }
  .bank .ptitle { font-size: 11px; color: var(--gold); text-transform: uppercase; letter-spacing: .1em; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
  .bank .ptitle kbd { background: rgba(20,26,40,.7); border: 1px solid var(--line-strong); border-radius: 6px; padding: 2px 6px; font-size: 10px; }
  .bank .pgrid { display: grid; gap: 3px; }
  .bank .pcell { background: rgba(255,255,255,.04); border-radius: 4px; aspect-ratio: 1 / 1; }
  .bank .pcell.kn { background: linear-gradient(135deg, #5a99ff, #2a55c6); box-shadow: inset 0 -2px 0 rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.25); }
  .bank .pcell.km { background: linear-gradient(135deg, #ffc274, #ff5a1a); box-shadow: inset 0 -2px 0 rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.35); animation: multShimmer 2.4s linear infinite; }
  .bank .empty-msg { color: var(--muted); font-size: 12px; align-self: center; text-align: center; flex: 1; display: flex; align-items: center; justify-content: center; }
  .piece.empty-slot { opacity: .35; cursor: not-allowed; pointer-events: none; }
  .piece { background: linear-gradient(135deg, rgba(20,26,40,.65), rgba(13,18,30,.65)); border: 1px solid var(--line); border-radius: 16px; padding: 12px; cursor: pointer; transition: transform .18s, border-color .18s, box-shadow .25s; min-height: 120px; display: flex; flex-direction: column; gap: 8px; position: relative; overflow: hidden; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .piece::before { content: ""; position: absolute; inset: -50%; background: conic-gradient(from 0deg, transparent 0%, rgba(0,255,157,.45), transparent 30%); opacity: 0; transition: opacity .25s; pointer-events: none; }
  .piece:hover { transform: translateY(-3px); border-color: rgba(255,255,255,.18); box-shadow: 0 12px 30px -10px rgba(0,0,0,.6); }
  .piece.selected { border-color: var(--neon); box-shadow: 0 0 0 2px rgba(0,255,157,.28), 0 12px 30px -10px rgba(0,255,157,.45); transform: translateY(-3px); }
  .piece.selected::before { opacity: 1; animation: spin 4s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .piece.placed { opacity: .25; cursor: not-allowed; pointer-events: none; filter: grayscale(.7); }
  .piece .ptitle { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .1em; font-weight: 700; position: relative; z-index: 1; transition: color .15s; }
  .piece.selected .ptitle { color: var(--neon-2); text-shadow: 0 0 10px rgba(30,232,129,.6); }
  .piece .pgrid { display: grid; gap: 3px; position: relative; z-index: 1; }
  .piece .pcell { background: rgba(255,255,255,.04); border-radius: 4px; aspect-ratio: 1 / 1; }
  .piece .pcell.kn { background: linear-gradient(135deg, #5a99ff, #2a55c6); box-shadow: inset 0 -2px 0 rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.25); }
  .piece .pcell.km { background: linear-gradient(135deg, #ffc274, #ff5a1a); box-shadow: inset 0 -2px 0 rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.35); animation: multShimmer 2.4s linear infinite; }

  /* Buttons */
  .controls { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn { background: linear-gradient(135deg, rgba(20,26,40,.7), rgba(13,18,30,.7)); border: 1px solid var(--line-strong); color: var(--text); padding: 12px 16px; border-radius: 14px; font-weight: 700; font-size: 14px; cursor: pointer; transition: transform .1s, background .15s, border-color .15s, box-shadow .2s; flex: 1 1 auto; position: relative; overflow: hidden; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .btn::after { content: ""; position: absolute; top: 0; bottom: 0; left: -120%; width: 60%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent); transform: skewX(-20deg); transition: left .6s ease; }
  .btn:hover { transform: translateY(-1px); border-color: rgba(255,255,255,.35); box-shadow: 0 8px 24px -8px rgba(0,0,0,.55); }
  .btn:hover::after { left: 160%; }
  .btn:active { transform: translateY(0) scale(.97); }
  .btn.primary { background: linear-gradient(135deg, #00ff9d, #1ee881); color: #002814; border-color: transparent; box-shadow: 0 8px 24px -6px rgba(0,255,157,.5), inset 0 1px 0 rgba(255,255,255,.45); }
  .btn.primary:hover { box-shadow: 0 14px 40px -6px rgba(0,255,157,.75), inset 0 1px 0 rgba(255,255,255,.55); }
  .btn:disabled { opacity: .4; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn:disabled::after { display: none; }

  /* Tabs */
  .tabs { display: flex; gap: 6px; margin-top: 14px; border-bottom: 1px solid var(--line); }
  .tab { flex: 0 1 auto; background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 10px 12px; font-weight: 700; font-size: 13px; cursor: pointer; transition: color .15s, border-color .15s, text-shadow .15s; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--neon); text-shadow: 0 0 12px rgba(0,255,157,.55); }
  .panel { display: none; background: rgba(20,26,40,.5); border: 1px solid var(--line); border-top: 0; border-radius: 0 0 14px 14px; padding: 12px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .panel.active { display: block; }
  .shortcuts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
  .shortcut { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 13px; }
  .keys { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  kbd { min-width: 26px; padding: 4px 7px; border: 1px solid var(--line-strong); border-bottom-color: #3a4254; border-radius: 6px; background: rgba(20,26,40,.7); color: var(--text); font: 700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-align: center; }

  .opponent { display: flex; align-items: center; justify-content: space-between; background: linear-gradient(135deg, rgba(20,26,40,.6), rgba(13,18,30,.6)); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-top: 14px; font-size: 13px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .opponent .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 8px; }
  .opponent.live .dot { background: var(--neon-2); box-shadow: 0 0 14px rgba(30,232,129,.85); animation: liveBlink 1.6s ease-in-out infinite; }
  .opponent.done .dot { background: var(--orange-2); box-shadow: 0 0 14px rgba(255,176,74,.85); }

  /* Toast & banner */
  .toast { position: fixed; left: 50%; top: 24px; transform: translateX(-50%) translateY(-20px); background: linear-gradient(135deg, rgba(255,77,109,.22), rgba(180,40,70,.22)); border: 1px solid rgba(255,77,109,.6); color: #ffd0d8; padding: 12px 18px; border-radius: 14px; font-size: 14px; font-weight: 600; z-index: 100; opacity: 0; transition: opacity .25s, transform .35s cubic-bezier(.34,1.56,.64,1); pointer-events: none; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  .banner { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; z-index: 80; }
  .banner.show { display: flex; }
  .banner .text { font-family: "Orbitron", "Space Grotesk", sans-serif; font-weight: 900; font-size: 78px; letter-spacing: .14em; background: linear-gradient(90deg, #4ff7ff, #1ee881, #ffd86b, #ff5fa3); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 0 0 60px rgba(0,255,157,.65); animation: bannerIn .85s cubic-bezier(.34,1.56,.64,1), titleGradient 3s linear infinite; padding: 0 20px; text-align: center; }
  @keyframes bannerIn { 0% { transform: scale(0) rotate(-25deg); opacity: 0; } 60% { transform: scale(1.25) rotate(3deg); opacity: 1; } 100% { transform: scale(1) rotate(0deg); opacity: 1; } }

  /* Score popups */
  .popups { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
  .pop { position: absolute; font-family: "Orbitron", "Space Grotesk", sans-serif; font-weight: 900; font-size: 28px; letter-spacing: .04em; color: var(--gold); text-shadow: 0 0 18px currentColor, 0 2px 4px rgba(0,0,0,.5); transform: translate(-50%, -50%); animation: pop 1.15s cubic-bezier(.22,1,.36,1) forwards; white-space: nowrap; pointer-events: none; }
  .pop.big { font-size: 46px; color: #fff; text-shadow: 0 0 22px var(--gold), 0 0 40px var(--orange); }
  .pop.cyan { color: var(--cyan); text-shadow: 0 0 22px var(--cyan), 0 0 40px var(--blue); }
  .pop.green { color: var(--neon-2); text-shadow: 0 0 22px var(--neon), 0 0 40px var(--neon-2); }
  @keyframes pop { 0% { opacity: 0; transform: translate(-50%, -50%) scale(.4); } 15% { opacity: 1; transform: translate(-50%, -85%) scale(1.3); } 100% { opacity: 0; transform: translate(-50%, -190%) scale(.95); } }

  /* End screen */
  .end { margin-top: 20px; background: linear-gradient(135deg, rgba(20,26,40,.7), rgba(13,18,30,.7)); border: 1px solid var(--line-strong); border-radius: 20px; padding: 20px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); position: relative; overflow: hidden; }
  .end h2 { margin: 0 0 10px 0; font-family: "Orbitron", "Space Grotesk", sans-serif; font-size: 22px; font-weight: 900; letter-spacing: .08em; background: linear-gradient(90deg, #4ff7ff, #1ee881, #ffd86b); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .end .row { display: flex; justify-content: space-between; padding: 8px 0; color: var(--muted); font-size: 14px; }
  .end .row.win { color: var(--neon-2); font-weight: 800; font-size: 18px; text-shadow: 0 0 12px rgba(30,232,129,.55); }
  .end .row.lose { color: #ffb0bb; font-weight: 600; }

  .footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 28px; opacity: .7; }
  @media (max-width: 760px) {
    .wrap { max-width: 100vw; padding: max(8px, env(safe-area-inset-top)) 8px calc(92px + env(safe-area-inset-bottom)); }
    .game-shell { display: block; }
    .side-panel { position: static; max-height: none; overflow: visible; padding-right: 0; margin-top: 10px; }
    .topbar { align-items: flex-start; margin-bottom: 10px; }
    .topRight { gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .badge, .series-chip { font-size: 11px; padding: 5px 8px; }
    .iconBtn { width: 42px; height: 42px; }
    .stats { gap: 7px; margin-bottom: 10px; }
    .stat { border-radius: 12px; padding: 8px 9px; }
    .stat .label { font-size: 9px; letter-spacing: .12em; }
    .board { gap: clamp(2px, .7vw, 3px); padding: clamp(6px, 1.8vw, 9px); border-radius: 16px; }
    .cell { border-radius: clamp(4px, 1.2vw, 7px); }
    .pieces-row { grid-template-columns: 1fr; gap: 8px; margin-top: 10px; }
    .pieces { gap: 8px; }
    .piece, .bank { border-radius: 12px; padding: 8px; min-height: 88px; gap: 6px; }
    .piece .ptitle, .bank .ptitle { font-size: 10px; letter-spacing: .08em; }
    .controls { position: sticky; bottom: max(8px, env(safe-area-inset-bottom)); z-index: 30; margin-top: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 16px; background: rgba(6,8,15,.72); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 -10px 30px -18px rgba(0,0,0,.8); }
    .btn { min-height: 44px; padding: 10px 12px; border-radius: 12px; font-size: 13px; }
    .tabs { overflow-x: auto; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
  }
  @media (hover: none) {
    .iconBtn:hover, .piece:hover, .btn:hover, .btn.primary:hover { transform: none; box-shadow: none; }
    .cell:not(.fill-1):not(.fill-2):not(.ghost-ok):not(.ghost-mult):not(.ghost-bad):hover { background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.18)); }
    .btn:hover::after { left: -120%; }
  }
  @media (max-width: 480px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .stat .value { font-size: 18px; }
    .shortcuts { grid-template-columns: 1fr; }
    .banner .text { font-size: 44px; }
    .title { font-size: 18px; }
  }

  /* Waiting overlay */
  .waitOverlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(6,8,15,.78); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 90; padding: 24px; }
  .waitOverlay.show { display: flex; }
  .waitCard { background: linear-gradient(135deg, rgba(20,26,40,.92), rgba(13,18,30,.92)); border: 1px solid var(--line-strong); border-radius: 20px; padding: 28px 32px; text-align: center; max-width: 420px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.7); }
  .waitCard h2 { margin: 0 0 8px; font-family: "Orbitron", sans-serif; font-size: 22px; letter-spacing: .12em; color: var(--neon-2); }
  .waitCard p { margin: 6px 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
  .waitCard .pulse-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--neon); margin-right: 8px; box-shadow: 0 0 14px var(--neon); animation: liveBlink 1.4s ease-in-out infinite; }

  /* Series chip */
  .series-chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid rgba(255,216,107,.4); border-radius: 999px; background: linear-gradient(135deg, rgba(255,216,107,.12), rgba(255,95,163,.12)); color: var(--gold); font-family: "Orbitron", sans-serif; font-weight: 800; font-size: 12px; letter-spacing: .1em; backdrop-filter: blur(6px); }

  /* Rematch panel inside endBox */
  .rematch { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
  .rematch .status { font-size: 13px; color: var(--muted); }
  .rematch .status.live { color: var(--neon-2); }
  .rematch .actions { display: flex; gap: 10px; flex-wrap: wrap; }

  @media (min-width: 1100px) {
    .wrap { max-width: 1200px; }
    .stats { grid-template-columns: repeat(4, 1fr); }
  }
</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="bg-orbs">
  <div class="orb o1"></div>
  <div class="orb o2"></div>
  <div class="orb o3"></div>
</div>
<canvas id="fx"></canvas>

<div class="wrap">
  <div class="topbar">
    <div>
      <div class="title">SLICE ARCADE</div>
      <div id="modeLabel" class="badge" style="margin-top:6px;">Loading…</div>
    </div>
    <div class="topRight">
      <div id="seriesChip" class="series-chip" style="display:none;"></div>
      <button id="muteBtn" class="iconBtn" type="button" title="Toggle sound" aria-label="Toggle sound">🔊</button>
      <div id="liveBadge" class="badge live" style="display:none;">● Live</div>
    </div>
  </div>

  <div id="potBox" class="pot" style="display:none;"></div>

  <div class="stats">
    <div id="scoreStat" class="stat score"><div class="label">Score</div><div id="score" class="value">0</div></div>
    <div id="multStat" class="stat mult"><div class="label">Multiplier</div><div id="mult" class="value">1×</div></div>
    <div id="levelStat" class="stat"><div class="label">Level</div><div id="level" class="value">1/12</div></div>
    <div id="timeStat" class="stat time"><div class="label">Time</div><div id="time" class="value">3:00</div></div>
  </div>

  <div class="game-shell">
  <div class="board-wrap">
    <div id="board" class="board" aria-label="Game board"></div>
  </div>

  <div class="side-panel">
  <div class="pieces-row">
    <div id="pieces" class="pieces"></div>
    <div id="bank" class="bank empty">
      <div class="ptitle"><span>Bank</span><kbd>E</kbd></div>
      <div class="empty-msg">Press E with a piece selected to hold it for later.</div>
    </div>
  </div>

  <div class="controls">
    <button id="rotateBtn" class="btn">↻ Rotate</button>
    <button id="clearBtn" class="btn">Clear</button>
    <button id="submitBtn" class="btn primary" style="display:none;">Submit final score</button>
  </div>

  <div class="tabs" role="tablist" aria-label="Game info">
    <button id="playTab" class="tab active" type="button" role="tab" aria-selected="true" aria-controls="playPanel">Play</button>
    <button id="shortcutsTab" class="tab" type="button" role="tab" aria-selected="false" aria-controls="shortcutsPanel">Shortcuts</button>
  </div>
  <div id="playPanel" class="panel active" role="tabpanel" aria-labelledby="playTab">
    <div class="shortcut"><span>Keyboard cursor</span><span class="keys"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></span></div>
  </div>
  <div id="shortcutsPanel" class="panel" role="tabpanel" aria-labelledby="shortcutsTab">
    <div class="shortcuts">
      <div class="shortcut"><span>Switch piece</span><span class="keys"><kbd>Tab</kbd></span></div>
      <div class="shortcut"><span>Select piece</span><span class="keys"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></span></div>
      <div class="shortcut"><span>Move piece</span><span class="keys"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></span></div>
      <div class="shortcut"><span>Place piece</span><span class="keys"><kbd>Space</kbd><kbd>Enter</kbd></span></div>
      <div class="shortcut"><span>Rotate</span><span class="keys"><kbd>R</kbd></span></div>
      <div class="shortcut"><span>Hold piece</span><span class="keys"><kbd>E</kbd></span></div>
      <div class="shortcut"><span>Clear selection</span><span class="keys"><kbd>C</kbd><kbd>Esc</kbd></span></div>
    </div>
  </div>

  <div id="opponentBox" class="opponent" style="display:none;"></div>

  <div id="endBox" class="end" style="display:none;"></div>
  </div>
  </div>

  <div class="footer">
    Same shapes for both players. Highest validated score wins. Server validates every move.
  </div>
</div>

<div id="popups" class="popups"></div>
<div id="banner" class="banner"></div>
<div id="toast" class="toast"></div>
<div id="waitOverlay" class="waitOverlay">
  <div class="waitCard">
    <h2><span class="pulse-dot"></span>Waiting for opponent</h2>
    <p>The match starts as soon as both players are in.</p>
    <p>Your timer will not start counting down until then.</p>
  </div>
</div>

<script>
(() => {
  const CONFIG = ${clientConfig};
  const params = new URLSearchParams(location.search);
  const TOKEN_KEY = 'arcade.latestToken';
  let TOKEN = CONFIG.requiresToken ? params.get(CONFIG.tokenParam || 't') : null;
  if (CONFIG.requiresToken) {
    if (TOKEN) {
      try { localStorage.setItem(TOKEN_KEY, TOKEN); } catch (e) {}
    } else {
      try { TOKEN = localStorage.getItem(TOKEN_KEY); } catch (e) { TOKEN = null; }
    }
  }
  if (CONFIG.requiresToken && !TOKEN) {
    document.body.innerHTML = CONFIG.missingAccessHtml;
    return;
  }

  const $board = document.getElementById('board');
  const $pieces = document.getElementById('pieces');
  const $score = document.getElementById('score');
  const $mult = document.getElementById('mult');
  const $level = document.getElementById('level');
  const $time = document.getElementById('time');
  const $timeStat = document.getElementById('timeStat');
  const $scoreStat = document.getElementById('scoreStat');
  const $multStat = document.getElementById('multStat');
  const $levelStat = document.getElementById('levelStat');
  const $mode = document.getElementById('modeLabel');
  const $live = document.getElementById('liveBadge');
  const $rotate = document.getElementById('rotateBtn');
  const $clear = document.getElementById('clearBtn');
  const $submit = document.getElementById('submitBtn');
  const $playTab = document.getElementById('playTab');
  const $shortcutsTab = document.getElementById('shortcutsTab');
  const $playPanel = document.getElementById('playPanel');
  const $shortcutsPanel = document.getElementById('shortcutsPanel');
  const $opponent = document.getElementById('opponentBox');
  const $end = document.getElementById('endBox');
  const $toast = document.getElementById('toast');
  const $pot = document.getElementById('potBox');
  const $popups = document.getElementById('popups');
  const $banner = document.getElementById('banner');
  const $fx = document.getElementById('fx');
  const fxCtx = $fx.getContext('2d');
  const $mute = document.getElementById('muteBtn');
  const $bank = document.getElementById('bank');
  const $waitOverlay = document.getElementById('waitOverlay');
  const $seriesChip = document.getElementById('seriesChip');

  /* ---- Sound engine (Web Audio synth) ---- */
  const Sound = {
    ctx: null,
    master: null,
    muted: (function () { try { return localStorage.getItem('arcade.muted') === '1'; } catch (e) { return false; } })(),
    init: function () {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.42;
      this.master.connect(this.ctx.destination);
    },
    resume: function () {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    setMuted: function (m) {
      this.muted = !!m;
      try { localStorage.setItem('arcade.muted', this.muted ? '1' : '0'); } catch (e) {}
    },
    tone: function (opts) {
      if (this.muted || !this.ctx) return;
      const o = opts || {};
      const ctx = this.ctx;
      const t0 = ctx.currentTime + (o.delay || 0);
      const dur = o.dur || 0.12;
      const release = o.release != null ? o.release : 0.06;
      const attack = o.attack != null ? o.attack : 0.005;
      const osc = ctx.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq || 440, t0);
      if (o.freqEnd != null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + dur);
      }
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(o.vol || 0.25, t0 + attack);
      gain.gain.linearRampToValueAtTime(0, t0 + dur + release);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + release + 0.05);
    },
    noise: function (opts) {
      if (this.muted || !this.ctx) return;
      const o = opts || {};
      const ctx = this.ctx;
      const t0 = ctx.currentTime + (o.delay || 0);
      const dur = o.dur || 0.15;
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = o.filter || 'highpass';
      filt.frequency.value = o.freq || 1500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(o.vol || 0.18, t0 + 0.005);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      src.connect(filt); filt.connect(g); g.connect(this.master);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    },
    place: function () {
      this.tone({ freq: 520, freqEnd: 760, dur: 0.08, type: 'triangle', vol: 0.32 });
      this.tone({ freq: 1040, freqEnd: 1480, dur: 0.06, type: 'sine', vol: 0.16, delay: 0.005 });
    },
    placeMult: function () {
      [440, 660, 880, 1320].forEach((f, i) => this.tone({ freq: f, dur: 0.13, type: 'triangle', vol: 0.24, delay: i * 0.04 }));
      this.noise({ dur: 0.2, vol: 0.07, freq: 4000 });
    },
    rotate: function () {
      this.tone({ freq: 360, freqEnd: 500, dur: 0.05, type: 'square', vol: 0.16 });
    },
    select: function () {
      this.tone({ freq: 720, dur: 0.04, type: 'sine', vol: 0.14 });
    },
    cursor: function () {
      this.tone({ freq: 140, freqEnd: 95, dur: 0.07, type: 'triangle', vol: 0.32, attack: 0.001, release: 0.04 });
      this.tone({ freq: 70, freqEnd: 50, dur: 0.09, type: 'sine', vol: 0.22, attack: 0.001, release: 0.05 });
      this.noise({ dur: 0.04, vol: 0.05, freq: 200, filter: 'lowpass' });
    },
    invalid: function () {
      this.tone({ freq: 200, freqEnd: 110, dur: 0.18, type: 'sawtooth', vol: 0.22 });
    },
    scoreUp: function (big) {
      this.tone({ freq: big ? 1320 : 980, dur: 0.06, type: 'sine', vol: 0.24 });
      this.tone({ freq: big ? 1760 : 1240, dur: 0.06, type: 'sine', vol: 0.18, delay: 0.04 });
    },
    multUp: function () {
      [660, 880, 1100, 1320].forEach((f, i) => this.tone({ freq: f, dur: 0.1, type: 'triangle', vol: 0.22, delay: i * 0.035 }));
    },
    clear: function (intensity) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.22, delay: i * 0.03 }));
      this.tone({ freq: 200, freqEnd: 1500, dur: 0.32, type: 'sawtooth', vol: 0.12 });
      this.noise({ dur: 0.28, vol: 0.08, freq: 3000 });
      if (intensity > 1) this.tone({ freq: 1320, freqEnd: 2640, dur: 0.4, type: 'sine', vol: 0.18, delay: 0.1 });
    },
    levelUp: function () {
      const arp = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
      arp.forEach((f, i) => this.tone({ freq: f, dur: 0.18, type: 'triangle', vol: 0.28, delay: i * 0.06 }));
      this.tone({ freq: 110, freqEnd: 220, dur: 0.55, type: 'sawtooth', vol: 0.14 });
    },
    victory: function () {
      const fanfare = [523.25, 659.25, 783.99, 1046.5, 1046.5, 1318.51, 1567.98, 2093];
      fanfare.forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.3, delay: i * 0.1 }));
      this.tone({ freq: 130, dur: 1.6, type: 'sawtooth', vol: 0.08 });
    },
    defeat: function () {
      [440, 392, 349.23, 293.66].forEach((f, i) => this.tone({ freq: f, dur: 0.32, type: 'triangle', vol: 0.22, delay: i * 0.16 }));
    },
    tie: function () {
      [440, 523.25].forEach((f, i) => this.tone({ freq: f, dur: 0.24, type: 'sine', vol: 0.22, delay: i * 0.1 }));
    },
  };

  function refreshMuteUi() {
    if (!$mute) return;
    $mute.textContent = Sound.muted ? '🔇' : '🔊';
    $mute.classList.toggle('muted', Sound.muted);
    $mute.title = Sound.muted ? 'Sound off — click to enable' : 'Sound on — click to mute';
  }
  refreshMuteUi();

  if ($mute) {
    $mute.addEventListener('click', () => {
      Sound.init();
      Sound.resume();
      Sound.setMuted(!Sound.muted);
      refreshMuteUi();
      if (!Sound.muted) Sound.select();
    });
  }

  function unlockAudio() {
    Sound.init();
    Sound.resume();
  }
  ['click', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, unlockAudio, { once: true });
  });

  let state = null;
  let selected = { pieceIndex: null, rotation: 0, hoverRow: 0, hoverCol: 0 };
  let serverOffsetMs = 0;
  let timeoutRefreshPending = false;
  let movePending = false;
  let confettiOn = false;
  let bannerTimer = 0;

  /* ---- Particle engine ---- */
  const particles = [];
  let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  function resizeCanvas() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    $fx.width = window.innerWidth * dpr;
    $fx.height = window.innerHeight * dpr;
    $fx.style.width = window.innerWidth + 'px';
    $fx.style.height = window.innerHeight + 'px';
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  function rand(a, b) { return a + Math.random() * (b - a); }

  function spawnBurst(x, y, opts) {
    const o = opts || {};
    const count = o.count || 24;
    const colors = o.colors || ['#4f8cff', '#00ff9d', '#ffd86b'];
    const speed = o.speed || 6;
    const life = o.life || 60;
    const size = o.size || 3;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const v = Math.random() * speed + speed * 0.3;
      particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v - rand(0.5, 2),
        life: life + Math.random() * 30,
        max: life + 30,
        color: colors[(Math.random() * colors.length) | 0],
        size: rand(size * 0.6, size * 1.6),
        gravity: o.gravity != null ? o.gravity : 0.18,
        rot: Math.random() * Math.PI,
        spin: rand(-0.2, 0.2),
        confetti: false,
        ring: false,
      });
    }
  }

  function spawnRing(x, y, color) {
    particles.push({ ring: true, x: x, y: y, r: 6, max: 70, life: 70, color: color || '#00ff9d' });
  }

  function spawnConfettiBatch() {
    const colors = ['#4ff7ff', '#1ee881', '#ffd86b', '#ff5fa3', '#a06bff', '#4f8cff', '#00ff9d'];
    for (let i = 0; i < 5; i++) {
      particles.push({
        confetti: true,
        ring: false,
        x: Math.random() * window.innerWidth,
        y: -20,
        vx: rand(-2, 2),
        vy: rand(2, 5),
        life: 360, max: 360,
        color: colors[(Math.random() * colors.length) | 0],
        size: rand(4, 9),
        rot: Math.random() * Math.PI,
        spin: rand(-0.3, 0.3),
        gravity: 0.05,
      });
    }
  }

  function fxLoop() {
    fxCtx.clearRect(0, 0, $fx.width, $fx.height);
    if (confettiOn) spawnConfettiBatch();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p.ring) {
        p.r += 4.5;
        p.life -= 1;
        const a = Math.max(0, p.life / p.max);
        fxCtx.beginPath();
        fxCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        fxCtx.lineWidth = 3 * a + 1;
        fxCtx.strokeStyle = p.color;
        fxCtx.globalAlpha = a;
        fxCtx.shadowColor = p.color;
        fxCtx.shadowBlur = 18 * a;
        fxCtx.stroke();
        fxCtx.globalAlpha = 1;
        fxCtx.shadowBlur = 0;
        if (p.life <= 0) particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      p.life -= 1;
      const a = Math.max(0, p.life / p.max);
      fxCtx.save();
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rot);
      fxCtx.globalAlpha = a;
      if (p.confetti) {
        fxCtx.fillStyle = p.color;
        fxCtx.fillRect(-p.size / 2, -p.size, p.size, p.size * 1.8);
      } else {
        fxCtx.fillStyle = p.color;
        fxCtx.shadowColor = p.color;
        fxCtx.shadowBlur = 16;
        fxCtx.beginPath();
        fxCtx.arc(0, 0, Math.max(0.4, p.size * a), 0, Math.PI * 2);
        fxCtx.fill();
      }
      fxCtx.restore();
      if (p.life <= 0 || p.y > window.innerHeight + 40 || p.x < -40 || p.x > window.innerWidth + 40) {
        particles.splice(i, 1);
      }
    }
    requestAnimationFrame(fxLoop);
  }
  requestAnimationFrame(fxLoop);

  function cellRect(r, c) {
    const node = cellNodes[r * 9 + c];
    if (!node) return { x: 0, y: 0, w: 0, h: 0 };
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
  }

  function shake(big) {
    document.body.classList.remove('shake', 'shake-big');
    void document.body.offsetWidth;
    document.body.classList.add(big ? 'shake-big' : 'shake');
    setTimeout(() => document.body.classList.remove('shake', 'shake-big'), big ? 620 : 380);
  }

  function flyText(x, y, text, kind) {
    const el = document.createElement('div');
    el.className = 'pop' + (kind ? ' ' + kind : '');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.textContent = text;
    $popups.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  function showBanner(text) {
    $banner.innerHTML = '<div class="text">' + text + '</div>';
    $banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => $banner.classList.remove('show'), 1500);
  }

  function pulseStat(node, glowMs) {
    if (!node) return;
    node.classList.remove('bump', 'glow');
    void node.offsetWidth;
    node.classList.add('bump', 'glow');
    setTimeout(() => node.classList.remove('bump'), 480);
    setTimeout(() => node.classList.remove('glow'), glowMs || 700);
  }

  /* Build empty 9x9 grid */
  const cellNodes = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.addEventListener('mouseenter', () => previewAt(r, c));
      cell.addEventListener('mouseleave', () => previewAt(null, null));
      cell.addEventListener('click', () => placeAt(r, c));
      $board.appendChild(cell);
      cellNodes.push(cell);
    }
  }

  /* Mouse-tracked glow on board */
  $board.addEventListener('mouseenter', () => $board.classList.add('active'));
  $board.addEventListener('mouseleave', () => $board.classList.remove('active'));
  $board.addEventListener('mousemove', (e) => {
    const rect = $board.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    $board.style.setProperty('--mx', x + '%');
    $board.style.setProperty('--my', y + '%');
  });

  $rotate.addEventListener('click', rotateSelected);
  function rotateSelected() {
    if (!state || state.result.completed || state.self.phase === 'finished' || isTimeExpired()) return;
    if (isWaitingForOpponent()) return;
    selected.rotation = (selected.rotation + 1) % 4;
    Sound.rotate();
    render();
  }
  $clear.addEventListener('click', () => {
    selected = { pieceIndex: null, rotation: 0, hoverRow: selected.hoverRow != null ? selected.hoverRow : 0, hoverCol: selected.hoverCol != null ? selected.hoverCol : 0 };
    render();
  });
  $submit.addEventListener('click', async () => {
    $submit.disabled = true;
    const next = await api('POST', CONFIG.submitPath, {});
    if (next) {
      const prev = state;
      state = next;
      onStateUpdate(prev, null);
    }
    selected.pieceIndex = null;
    render();
  });
  $playTab.addEventListener('click', () => setInfoTab('play'));
  $shortcutsTab.addEventListener('click', () => setInfoTab('shortcuts'));
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const key = event.key.toLowerCase();
    if (isWaitingForOpponent()) return;
    if (key === 'r') {
      event.preventDefault();
      rotateSelected();
    } else if (key === 'e') {
      event.preventDefault();
      bankSelected();
    } else if (key === 'tab') {
      event.preventDefault();
      cyclePiece(event.shiftKey ? -1 : 1);
    } else if (key === 'arrowup') {
      event.preventDefault();
      moveCursor(-1, 0);
    } else if (key === 'arrowdown') {
      event.preventDefault();
      moveCursor(1, 0);
    } else if (key === 'arrowleft') {
      event.preventDefault();
      moveCursor(0, -1);
    } else if (key === 'arrowright') {
      event.preventDefault();
      moveCursor(0, 1);
    } else if (key === ' ' || key === 'spacebar') {
      event.preventDefault();
      placeAtCursor();
    } else if (key === 'escape' || key === 'c') {
      event.preventDefault();
      selected = { pieceIndex: null, rotation: 0, hoverRow: selected.hoverRow != null ? selected.hoverRow : 0, hoverCol: selected.hoverCol != null ? selected.hoverCol : 0 };
      render();
    } else if (key >= '1' && key <= '3') {
      const idx = Number(key) - 1;
      if (state && state.self && state.self.pieces && isPlayablePiece(state.self.pieces[idx])) {
        event.preventDefault();
        selected.pieceIndex = idx;
        selected.rotation = 0;
        Sound.select();
        ensureCursor();
        render();
      }
    } else if (key === 'enter') {
      event.preventDefault();
      if ($submit.style.display !== 'none' && !$submit.disabled) $submit.click();
      else placeAtCursor();
    }
  });

  function isWaitingForOpponent() {
    return !!(state && state.match && state.match.status === 'waiting');
  }

  function formatMultiplier(m) {
    if (typeof m !== 'number' || !isFinite(m)) return '1';
    return m % 1 === 0 ? String(Math.round(m)) : m.toFixed(1);
  }

  function formatLevel(state) {
    if (!state || !state.self) return '1';
    const display = state.self.levelDisplay || (state.self.level + 1);
    if (state.self.maxLevels) return display + '/' + state.self.maxLevels;
    return 'Lv ' + display;
  }

  async function bankSelected() {
    if (movePending) return;
    if (!state || state.result.completed || state.self.phase === 'finished' || isTimeExpired()) return;
    if (isWaitingForOpponent()) return;
    if (selected.pieceIndex == null || !isPlayablePiece(state.self.pieces[selected.pieceIndex])) {
      showToast('Select a piece first');
      return;
    }
    const move = { kind: 'bank', level: state.self.level, pieceIndex: selected.pieceIndex };
    movePending = true;
    try {
      const next = await api('POST', CONFIG.movePath, move);
      if (!next) return;
      const beforeServer = state;
      state = next;
      onStateUpdate(beforeServer, null);
      // After a bank, prefer the slot we banked into (bank had something) or the
      // first remaining playable piece (bank was empty).
      const idx = firstPlayablePieceIndex();
      selected.pieceIndex = idx >= 0 ? idx : null;
      selected.rotation = 0;
      Sound.select();
      render();
    } finally {
      movePending = false;
    }
  }

  function rematchPath(suffix) {
    // movePath is either /arcade/api/move or /api/web/play/<id>/move.
    // Replace the trailing /move with /rematch (or /rematch/cancel).
    const base = CONFIG.movePath.replace(/\\/move$/, '');
    return base + '/rematch' + (suffix ? suffix : '');
  }

  async function requestRematch() {
    const next = await api('POST', rematchPath(''), {});
    if (!next) return;
    if (next.redirect) {
      window.location.href = next.redirect;
      return;
    }
    refresh();
  }

  async function cancelRematchRequest() {
    const next = await api('POST', rematchPath('/cancel'), {});
    if (!next) return;
    refresh();
  }

  function setInfoTab(name) {
    const shortcuts = name === 'shortcuts';
    $playTab.classList.toggle('active', !shortcuts);
    $shortcutsTab.classList.toggle('active', shortcuts);
    $playPanel.classList.toggle('active', !shortcuts);
    $shortcutsPanel.classList.toggle('active', shortcuts);
    $playTab.setAttribute('aria-selected', String(!shortcuts));
    $shortcutsTab.setAttribute('aria-selected', String(shortcuts));
  }

  function availablePieceIndexes() {
    if (!state || !state.self || !state.self.pieces) return [];
    return state.self.pieces
      .map((piece, index) => isPlayablePiece(piece) ? index : -1)
      .filter((index) => index >= 0);
  }

  function isPlayablePiece(piece) {
    return !!(piece && piece.cells && !piece.placed);
  }

  function firstPlayablePieceIndex() {
    if (!state || !state.self || !state.self.pieces) return -1;
    return state.self.pieces.findIndex(isPlayablePiece);
  }

  function cyclePiece(direction) {
    if (!state || state.result.completed || state.self.phase === 'finished' || isTimeExpired()) return;
    const indexes = availablePieceIndexes();
    if (indexes.length === 0) return;
    const current = indexes.indexOf(selected.pieceIndex);
    const base = current >= 0 ? current : direction > 0 ? -1 : 0;
    const next = indexes[(base + direction + indexes.length) % indexes.length];
    selected.pieceIndex = next;
    selected.rotation = 0;
    Sound.select();
    ensureCursor();
    render();
  }

  function ensureCursor() {
    if (selected.hoverRow == null || selected.hoverCol == null) {
      selected.hoverRow = 0;
      selected.hoverCol = 0;
    }
  }

  function moveCursor(rowDelta, colDelta) {
    if (!state || state.result.completed) return;
    ensureCursor();
    const nextR = Math.max(0, Math.min(8, selected.hoverRow + rowDelta));
    const nextC = Math.max(0, Math.min(8, selected.hoverCol + colDelta));
    const cells = selectedCells();
    const clamped = clampAnchor(cells, nextR, nextC);
    if (clamped.r !== selected.hoverRow || clamped.c !== selected.hoverCol) {
      Sound.cursor();
    }
    selected.hoverRow = clamped.r;
    selected.hoverCol = clamped.c;
    paintBoard();
  }

  function placeAtCursor() {
    ensureCursor();
    placeAt(selected.hoverRow, selected.hoverCol);
  }

  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => $toast.classList.remove('show'), 2200);
  }

  function remainingMs() {
    if (!state || !state.match || !state.match.deadlineAt || state.result.completed) return null;
    return Math.max(0, Date.parse(state.match.deadlineAt) - (Date.now() + serverOffsetMs));
  }

  function isTimeExpired() {
    const remaining = remainingMs();
    return remaining != null && remaining <= 0;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return mins + ':' + String(secs).padStart(2, '0');
  }

  function paintTimer() {
    if (isWaitingForOpponent()) {
      $time.textContent = 'WAIT';
      $timeStat.classList.remove('low');
      return;
    }
    const remaining = remainingMs();
    if (remaining == null) {
      $time.textContent = state && state.match && state.match.durationSeconds ? formatClock(state.match.durationSeconds * 1000) : '3:00';
      $timeStat.classList.remove('low');
      return;
    }
    $time.textContent = formatClock(remaining);
    $timeStat.classList.toggle('low', remaining <= 30000);
    if (remaining <= 0 && state && !state.result.completed && !timeoutRefreshPending) {
      timeoutRefreshPending = true;
      refresh().finally(() => {
        timeoutRefreshPending = false;
      });
    }
  }

  async function api(method, path, body) {
    try {
      const url = CONFIG.requiresToken
        ? path + (path.includes('?') ? '&' : '?') + (CONFIG.tokenParam || 't') + '=' + encodeURIComponent(TOKEN)
        : path;
      const init = { method: method, credentials: 'include', headers: {} };
      if (CONFIG.requiresToken) init.headers['X-Arcade-Token'] = TOKEN;
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(json.error || ('Error ' + res.status));
        return null;
      }
      return json;
    } catch (err) {
      showToast(String(err && err.message || err));
      return null;
    }
  }

  function rotateCells(cells, rotation) {
    let out = cells.map(c => ({ x: c.x, y: c.y, kind: c.kind }));
    for (let i = 0; i < rotation; i++) {
      out = out.map(c => ({ x: c.y, y: -c.x, kind: c.kind }));
    }
    const minX = Math.min.apply(null, out.map(c => c.x));
    const minY = Math.min.apply(null, out.map(c => c.y));
    return out.map(c => ({ x: c.x - minX, y: c.y - minY, kind: c.kind }));
  }

  function selectedCells() {
    if (!state || selected.pieceIndex == null) return null;
    const piece = state.self.pieces[selected.pieceIndex];
    if (!piece || !piece.cells) return null;
    return rotateCells(piece.cells, selected.rotation);
  }

  function clampAnchor(cells, r, c) {
    if (!cells || !cells.length) return { r: r, c: c };
    let maxX = 0, maxY = 0;
    for (const cell of cells) {
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y > maxY) maxY = cell.y;
    }
    return {
      r: Math.max(0, Math.min(8 - maxY, r)),
      c: Math.max(0, Math.min(8 - maxX, c)),
    };
  }

  function isValidPlacement(cells, r, c) {
    if (!cells) return false;
    for (const cell of cells) {
      const rr = r + cell.y;
      const cc = c + cell.x;
      if (rr < 0 || rr >= 9 || cc < 0 || cc >= 9) return false;
      if (state.self.board[rr][cc] !== 0) return false;
    }
    return true;
  }

  function previewAt(r, c) {
    if (r == null || c == null) {
      paintBoard();
      return;
    }
    const cells = selectedCells();
    const clamped = clampAnchor(cells, r, c);
    selected.hoverRow = clamped.r;
    selected.hoverCol = clamped.c;
    paintBoard();
  }

  async function placeAt(r, c) {
    if (!state) return;
    if (movePending) return;
    if (state.result.completed) return;
    if (state.self.phase === 'finished') return;
    if (isWaitingForOpponent()) return;
    if (isTimeExpired()) {
      showToast('Time is up');
      await refresh();
      return;
    }
    if (selected.pieceIndex == null) {
      showToast('Pick a piece first');
      return;
    }
    const cells = selectedCells();
    if (cells) {
      const clamped = clampAnchor(cells, r, c);
      r = clamped.r;
      c = clamped.c;
    }
    if (!isValidPlacement(cells, r, c)) {
      showToast("That doesn't fit");
      Sound.invalid();
      shake(false);
      return;
    }
    const move = {
      level: state.self.level,
      pieceIndex: selected.pieceIndex,
      rotation: selected.rotation,
      row: r,
      col: c,
    };
    const previous = cloneState(state);
    const placedCells = cells.map(cell => ({ r: r + cell.y, c: c + cell.x, kind: cell.kind }));
    const hasMult = placedCells.some(p => p.kind === 'multiplier');
    applyOptimisticPlacement(cells, r, c, selected.pieceIndex);
    render();

    /* Place-time juice: drop animation, ring, particle burst */
    requestAnimationFrame(() => {
      placedCells.forEach((p) => {
        const node = cellNodes[p.r * 9 + p.c];
        if (node) {
          node.classList.add('placed-now');
          setTimeout(() => node.classList.remove('placed-now'), 470);
        }
      });
      const midCell = cells[Math.floor(cells.length / 2)];
      const center = cellRect(r + midCell.y, c + midCell.x);
      spawnRing(center.x, center.y, hasMult ? '#ffb04a' : '#4f8cff');
      spawnBurst(center.x, center.y, {
        count: hasMult ? 36 : 18,
        colors: hasMult ? ['#ffb04a', '#ff8a1a', '#ffd86b', '#ffffff'] : ['#4f8cff', '#7aa9ff', '#ffffff', '#cfe0ff'],
        speed: hasMult ? 7.5 : 5.5,
        size: hasMult ? 3.4 : 2.6,
      });
      if (hasMult) {
        Sound.placeMult();
        shake(false);
      } else {
        Sound.place();
      }
    });

    movePending = true;
    try {
      const next = await api('POST', CONFIG.movePath, move);
      if (!next) {
        state = previous;
        render();
        return;
      }
      const beforeServer = state;
      state = next;
      onStateUpdate(beforeServer, { lastPlacement: { r: r, c: c, cells: placedCells } });
      if (state.self.phase === 'playing') {
        const idx = firstPlayablePieceIndex();
        selected.pieceIndex = idx >= 0 ? idx : null;
      } else {
        selected.pieceIndex = null;
      }
      selected.rotation = 0;
      selected.hoverRow = r;
      selected.hoverCol = c;
      render();
    } finally {
      movePending = false;
    }
  }

  function cloneState(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function applyOptimisticPlacement(cells, r, c, pieceIndex) {
    for (const cell of cells) {
      state.self.board[r + cell.y][c + cell.x] = cell.kind === 'multiplier' ? 2 : 1;
    }
    state.self.pieces[pieceIndex].placed = true;
    const idx = firstPlayablePieceIndex();
    selected.pieceIndex = idx >= 0 ? idx : null;
    selected.rotation = 0;
    selected.hoverRow = r;
    selected.hoverCol = c;
  }

  function onStateUpdate(prev, ctx) {
    if (!prev || !state) return;

    const prevSelf = prev.self || {};
    const newSelf = state.self || {};

    /* Score increase popup */
    const prevScore = prevSelf.score || 0;
    const newScore = newSelf.score || 0;
    const delta = newScore - prevScore;
    if (delta > 0) {
      pulseStat($scoreStat, 700);
      let x = window.innerWidth / 2, y = window.innerHeight / 2 - 80;
      const place = ctx && ctx.lastPlacement ? ctx.lastPlacement : null;
      if (place) {
        const rect = cellRect(place.r, place.c);
        x = rect.x;
        y = rect.y - 14;
      }
      const big = delta >= 200;
      flyText(x, y, '+' + delta.toLocaleString(), big ? 'big' : '');
      Sound.scoreUp(big);
    }

    /* Multiplier change */
    const prevMult = prevSelf.multiplier || 1;
    const newMult = newSelf.multiplier || 1;
    if (newMult > prevMult) {
      pulseStat($multStat, 1000);
      shake(false);
      const r = $multStat.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      flyText(cx, cy, newMult + '×!', 'big');
      spawnBurst(cx, cy, { count: 32, colors: ['#ffb04a', '#ff8a1a', '#ffd86b', '#ffffff'], speed: 6.5, size: 3 });
      spawnRing(cx, cy, '#ffb04a');
      Sound.multUp();
    }

    /* Level up */
    const prevLevel = prevSelf.level != null ? prevSelf.level : 0;
    const newLevel = newSelf.level != null ? newSelf.level : 0;
    if (newLevel > prevLevel) {
      pulseStat($levelStat, 800);
      shake(true);
      showBanner('LEVEL UP');
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      spawnRing(cx, cy, '#00ff9d');
      setTimeout(() => spawnRing(cx, cy, '#4ff7ff'), 80);
      setTimeout(() => spawnRing(cx, cy, '#ffd86b'), 160);
      spawnBurst(cx, cy, { count: 90, colors: ['#4ff7ff', '#1ee881', '#ffd86b', '#ff5fa3', '#a06bff', '#ffffff'], speed: 9, size: 3.5, life: 100 });
      Sound.levelUp();
    }

    /* Line clears: cells that went non-zero -> zero between prev (post-optimistic) and new */
    const prevBoard = prevSelf.board;
    const newBoard = newSelf.board;
    if (prevBoard && newBoard && prevBoard.length === 9 && newBoard.length === 9) {
      const cleared = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          if (prevBoard[r][c] !== 0 && newBoard[r][c] === 0) {
            cleared.push({ r: r, c: c });
          }
        }
      }
      if (cleared.length > 0) {
        triggerLineClear(cleared);
      }
    }

    /* Match completed transition */
    if ((!prev.result || !prev.result.completed) && state.result && state.result.completed) {
      onMatchComplete();
    }

    /* Auto-redirect to rematch as soon as both sides have accepted */
    if (state.result && state.result.redirect) {
      const prevRedirect = prev.result && prev.result.redirect;
      if (!prevRedirect) {
        // Slight delay so the user sees the "Both accepted" status
        setTimeout(() => { window.location.href = state.result.redirect; }, 600);
      }
    }
  }

  function triggerLineClear(cells) {
    shake(cells.length >= 18);
    cells.forEach((p, i) => {
      const node = cellNodes[p.r * 9 + p.c];
      if (!node) return;
      node.classList.remove('placed-now');
      node.classList.add('clearing');
      setTimeout(() => node.classList.remove('clearing'), 620);
      setTimeout(() => {
        const rect = cellRect(p.r, p.c);
        spawnBurst(rect.x, rect.y, {
          count: 14,
          colors: ['#ffffff', '#4ff7ff', '#1ee881', '#ffd86b'],
          speed: 7,
          size: 3,
          life: 80,
        });
      }, i * 12);
    });
    const lines = Math.max(1, Math.floor(cells.length / 9));
    Sound.clear(lines);
    setTimeout(() => {
      const text = lines >= 3 ? 'TRIPLE CLEAR!' : lines === 2 ? 'DOUBLE CLEAR!' : 'CLEAR!';
      flyText(window.innerWidth / 2, window.innerHeight / 2 - 40, text, 'big cyan');
    }, 80);
  }

  function onMatchComplete() {
    if (state.result.isWinner) {
      showBanner('VICTORY!');
      confettiOn = true;
      setTimeout(() => { confettiOn = false; }, 5500);
      shake(true);
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      spawnRing(cx, cy, '#ffd86b');
      spawnBurst(cx, cy, { count: 120, colors: ['#ffd86b', '#1ee881', '#4ff7ff', '#ff5fa3', '#ffffff'], speed: 10, size: 4, life: 110 });
      Sound.victory();
    } else if (state.result.isTie) {
      showBanner('TIE');
      Sound.tie();
    } else {
      showBanner('DEFEAT');
      shake(false);
      Sound.defeat();
    }
  }

  function paintBoard() {
    const board = state ? state.self.board : Array.from({ length: 9 }, () => new Array(9).fill(0));
    const cells = selectedCells();
    const pr = selected.hoverRow;
    const pc = selected.hoverCol;
    const wouldFit = cells != null && pr != null && pc != null && isValidPlacement(cells, pr, pc);

    const ghostMap = new Map();
    if (cells && pr != null && pc != null) {
      for (const cell of cells) {
        const rr = pr + cell.y;
        const cc = pc + cell.x;
        if (rr >= 0 && rr < 9 && cc >= 0 && cc < 9) {
          ghostMap.set(rr * 9 + cc, cell.kind);
        }
      }
    }

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const node = cellNodes[r * 9 + c];
        const v = board[r][c];
        const wasNow = node.classList.contains('placed-now');
        const wasClearing = node.classList.contains('clearing');
        node.className = 'cell';
        if (wasNow) node.classList.add('placed-now');
        if (wasClearing) node.classList.add('clearing');
        if (v === 1) node.classList.add('fill-1');
        else if (v === 2) node.classList.add('fill-2');

        if (selected.hoverRow === r && selected.hoverCol === c) {
          node.classList.add('keyboard-cursor');
        }

        if (ghostMap.has(r * 9 + c)) {
          if (!wouldFit) node.classList.add('ghost-bad');
          else if (ghostMap.get(r * 9 + c) === 'multiplier') node.classList.add('ghost-mult');
          else node.classList.add('ghost-ok');
        }
      }
    }
  }

  function paintPieces() {
    $pieces.innerHTML = '';
    const pieces = state ? state.self.pieces : [];
    pieces.forEach((p, i) => {
      const card = document.createElement('div');
      const isEmpty = !p.cells;
      card.className = 'piece' + (selected.pieceIndex === i ? ' selected' : '') + (p.placed ? ' placed' : '') + (isEmpty ? ' empty-slot' : '');
      const title = document.createElement('div');
      title.className = 'ptitle';
      title.textContent = 'Piece ' + (i + 1) + (p.placed ? ' • placed' : isEmpty ? ' • banked' : '');
      card.appendChild(title);

      if (isEmpty) {
        $pieces.appendChild(card);
        return;
      }

      const previewCells = selected.pieceIndex === i ? rotateCells(p.cells, selected.rotation) : p.cells;
      const w = Math.max.apply(null, previewCells.map(c => c.x)) + 1;
      const h = Math.max.apply(null, previewCells.map(c => c.y)) + 1;
      const grid = document.createElement('div');
      grid.className = 'pgrid';
      grid.style.gridTemplateColumns = 'repeat(' + w + ', 1fr)';
      grid.style.width = Math.min(140, 26 * w) + 'px';
      const filled = new Map();
      for (const cell of previewCells) filled.set(cell.y * w + cell.x, cell.kind);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dot = document.createElement('div');
          dot.className = 'pcell';
          const kind = filled.get(y * w + x);
          if (kind === 'normal') dot.classList.add('kn');
          else if (kind === 'multiplier') dot.classList.add('km');
          grid.appendChild(dot);
        }
      }
      card.appendChild(grid);
      card.addEventListener('click', () => {
        if (p.placed || state.result.completed || isTimeExpired() || state.self.phase === 'finished' || isWaitingForOpponent()) return;
        if (!p.cells) return;
        selected.pieceIndex = i;
        selected.rotation = 0;
        Sound.select();
        render();
      });
      $pieces.appendChild(card);
    });
  }

  function paintHud() {
    if (!state) return;
    if (state.match.serverNow) serverOffsetMs = Date.parse(state.match.serverNow) - Date.now();
    $score.textContent = state.self.score.toLocaleString();
    $mult.textContent = formatMultiplier(state.self.multiplier) + '×';
    $level.textContent = formatLevel(state);
    paintTimer();

    // Series chip (rematch chain win counter)
    const series = state.result && state.result.series;
    if ($seriesChip) {
      if (series && series.total > 0) {
        $seriesChip.style.display = '';
        $seriesChip.textContent = 'You ' + series.youWins + ' — Opp ' + series.opponentWins +
          (series.ties > 0 ? ' • ' + series.ties + ' tie' + (series.ties === 1 ? '' : 's') : '');
      } else {
        $seriesChip.style.display = 'none';
      }
    }

    // Waiting-for-opponent overlay
    if ($waitOverlay) {
      $waitOverlay.classList.toggle('show', isWaitingForOpponent());
    }

    const m = state.match;
    let label;
    if (isWaitingForOpponent()) label = 'Waiting for opponent';
    else if (m.mode === 'practice') label = 'Practice • Match #' + m.id;
    else if (m.mode === 'free_pvp') label = 'Free PvP • Match #' + m.id;
    else label = 'Stake ' + (m.stakeFormatted || '?') + ' • Match #' + m.id;
    $mode.textContent = label;

    if (state.self.phase === 'playing' && !state.result.completed && !isWaitingForOpponent()) {
      $live.style.display = '';
    } else {
      $live.style.display = 'none';
    }
    $rotate.disabled = isWaitingForOpponent() || state.self.phase === 'finished' || state.result.completed || isTimeExpired();
    $clear.disabled = isWaitingForOpponent() || state.result.completed;

    if (m.mode === 'staked_pvp' && m.grossPotFormatted) {
      $pot.style.display = '';
      $pot.innerHTML =
        '💰 Gross pot <strong>' + m.grossPotFormatted + '</strong> • ' +
        'Winner takes <strong>' + (m.winnerPayoutFormatted || '0') + '</strong>';
    } else {
      $pot.style.display = 'none';
    }

    if (!isWaitingForOpponent() && state.self.phase === 'finished' && !state.self.submitted && !state.result.completed) {
      $submit.style.display = '';
      $submit.disabled = false;
    } else {
      $submit.style.display = 'none';
    }

    if (state.opponent) {
      $opponent.style.display = '';
      $opponent.classList.remove('live', 'done');
      const op = state.opponent;
      let txt;
      if (op.submitted) {
        $opponent.classList.add('done');
        txt = '<span><span class="dot"></span>Opponent submitted' +
              (op.score != null ? ' — score <strong>' + op.score.toLocaleString() + '</strong>' : '') + '</span>';
      } else if (op.userId) {
        $opponent.classList.add('live');
        txt = '<span><span class="dot"></span>Opponent is playing…</span>';
      } else {
        txt = '<span><span class="dot"></span>Waiting for opponent to join</span>';
      }
      if (state.self.submitted) txt += '<span style="color:var(--muted);">You submitted</span>';
      $opponent.innerHTML = txt;
    } else {
      $opponent.style.display = 'none';
    }

    if (state.result.completed) {
      $end.style.display = '';
      let html = '<h2>Match complete</h2>';
      if (state.opponent) {
        const youScore = state.self.score;
        const oppScore = state.opponent.score != null ? state.opponent.score : 0;
        if (state.result.isTie) {
          html += '<div class="row">🤝 Tie</div>';
        } else if (state.result.isWinner) {
          html += '<div class="row win">🏆 You win!' +
            (state.result.payoutFormatted ? ' Payout: ' + state.result.payoutFormatted : '') + '</div>';
        } else {
          html += '<div class="row lose">Opponent wins this round.</div>';
        }
        html += '<div class="row"><span>You</span><span>' + youScore.toLocaleString() + '</span></div>';
        html += '<div class="row"><span>Opponent</span><span>' + oppScore.toLocaleString() + '</span></div>';
      } else {
        html += '<div class="row">Final score</div>';
        html += '<div class="row"><span>You</span><span>' + state.self.score.toLocaleString() + '</span></div>';
      }
      if (state.result.settlementExplorerUrl) {
        html += '<div class="row"><span>Settlement tx</span><a href="' + state.result.settlementExplorerUrl + '" target="_blank" rel="noopener noreferrer">' +
          String(state.result.settlementTxHash || '').slice(0, 10) + '…' + String(state.result.settlementTxHash || '').slice(-8) +
          '</a></div>';
      }
      html += '<div class="row" style="margin-top:6px;">' + CONFIG.doneMessage + '</div>';
      html += rematchPanelHtml(state);
      $end.innerHTML = html;
      attachRematchHandlers();
    } else {
      $end.style.display = 'none';
    }
  }

  function rematchPanelHtml(s) {
    const r = s.result || {};
    if (r.redirect) {
      return '<div class="rematch"><div class="status live">Rematch ready — heading there now…</div></div>';
    }
    const self = !!r.rematchRequestedBySelf;
    const opp = !!r.rematchRequestedByOpponent;
    const isPractice = s.match && s.match.mode === 'practice';
    let body = '<div class="rematch">';
    if (isPractice) {
      body += '<div class="actions"><button class="btn primary" data-rematch="request">Play again</button></div>';
    } else if (self && !opp) {
      body += '<div class="status live">Waiting for opponent to accept rematch…</div>';
      body += '<div class="actions"><button class="btn" data-rematch="cancel">Cancel rematch</button></div>';
    } else if (opp && !self) {
      body += '<div class="status live">Opponent wants a rematch.</div>';
      body += '<div class="actions"><button class="btn primary" data-rematch="request">Accept rematch</button></div>';
    } else if (self && opp) {
      body += '<div class="status live">Both players accepted — preparing match…</div>';
    } else {
      body += '<div class="actions"><button class="btn primary" data-rematch="request">Request rematch</button></div>';
    }
    body += '</div>';
    return body;
  }

  function attachRematchHandlers() {
    const buttons = $end.querySelectorAll('[data-rematch]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-rematch');
        btn.disabled = true;
        if (action === 'request') requestRematch().finally(() => { btn.disabled = false; });
        else if (action === 'cancel') cancelRematchRequest().finally(() => { btn.disabled = false; });
      });
    });
  }

  function paintBank() {
    if (!$bank) return;
    const bank = state && state.self ? state.self.bank : null;
    $bank.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'ptitle';
    title.innerHTML = '<span>Bank</span><kbd>E</kbd>';
    $bank.appendChild(title);
    if (!bank || !bank.cells) {
      $bank.classList.add('empty');
      $bank.classList.remove('active');
      const msg = document.createElement('div');
      msg.className = 'empty-msg';
      msg.textContent = 'Press E with a piece selected to hold it for later.';
      $bank.appendChild(msg);
      return;
    }
    $bank.classList.remove('empty');
    $bank.classList.add('active');
    const cells = bank.cells;
    const w = Math.max.apply(null, cells.map(c => c.x)) + 1;
    const h = Math.max.apply(null, cells.map(c => c.y)) + 1;
    const grid = document.createElement('div');
    grid.className = 'pgrid';
    grid.style.gridTemplateColumns = 'repeat(' + w + ', 1fr)';
    grid.style.width = Math.min(140, 26 * w) + 'px';
    const filled = new Map();
    for (const cell of cells) filled.set(cell.y * w + cell.x, cell.kind);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dot = document.createElement('div');
        dot.className = 'pcell';
        const kind = filled.get(y * w + x);
        if (kind === 'normal') dot.classList.add('kn');
        else if (kind === 'multiplier') dot.classList.add('km');
        grid.appendChild(dot);
      }
    }
    $bank.appendChild(grid);
  }

  function render() {
    paintHud();
    paintPieces();
    paintBank();
    paintBoard();
  }

  async function refresh() {
    const next = await api('GET', CONFIG.statePath);
    if (!next) return;
    const prev = state;
    state = next;
    onStateUpdate(prev, null);
    if ((selected.pieceIndex == null || !isPlayablePiece(state.self.pieces[selected.pieceIndex])) && state.self.phase === 'playing') {
      const idx = firstPlayablePieceIndex();
      if (idx >= 0) selected.pieceIndex = idx;
    }
    ensureCursor();
    render();
  }

  refresh();
  setInterval(paintTimer, 500);
  setInterval(() => {
    if (!state) return;
    // Poll continuously while waiting (so we catch the opponent joining), and
    // after match completion (so we catch rematch state changes from the
    // opponent), and during play if the opponent has submitted.
    if (isWaitingForOpponent()) { refresh(); return; }
    if (state.result.completed) { refresh(); return; }
    if (state.self.submitted || state.opponent) refresh();
  }, 2000);
})();
</script>
</body>
</html>`;
}

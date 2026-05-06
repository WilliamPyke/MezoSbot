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
  getMatch,
  recordSubmission,
  trySettleMatch,
  type ArcadeMatchRow,
} from "./db.js";
import {
  applyMoveForPlayer,
  clearRuntime,
  ensureRuntime,
  getRuntime,
  rebuildState,
  type MatchRuntime,
} from "./runtime.js";
import { rotateCells } from "./pieces.js";
import {
  BOARD_SIZE,
  MAX_LEVELS,
  PIECES_PER_LEVEL,
  type Move,
  type PieceCell,
  type PlayerState,
} from "./types.js";
import { verifyMatchToken } from "./tokens.js";
import { onMatchSettled } from "./notify.js";
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
    sendHtml(res, 200, renderPlayPage());
    return true;
  }
  if (method === "GET" && path === "/arcade/api/state") {
    await respond(req, res, async (claim) => buildStateResponse(claim.matchId, claim.userId));
    return true;
  }
  if (method === "POST" && path === "/arcade/api/move") {
    await respondWithBody(req, res, async (claim, body) => {
      const move: Move = {
        level: numField(body, "level"),
        pieceIndex: numField(body, "pieceIndex"),
        rotation: (numField(body, "rotation") % 4) as 0 | 1 | 2 | 3,
        row: numField(body, "row"),
        col: numField(body, "col"),
      };
      await ensureMatchRuntimeLoaded(claim.matchId);
      const result = applyMoveForPlayer(claim.matchId, claim.userId, move);
      if (!("ok" in result) || !result.ok) {
        return { status: 400, body: { error: (result as { error: string }).error } };
      }
      // Best-effort draft persist so a restart can recover.
      const state = result.state;
      persistDraft(claim.matchId, claim.userId, state).catch(() => {});
      return { status: 200, body: await buildStateResponse(claim.matchId, claim.userId) };
    });
    return true;
  }
  if (method === "POST" && path === "/arcade/api/submit") {
    await respondWithBody(req, res, async (claim) => {
      await ensureMatchRuntimeLoaded(claim.matchId);
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
      if (settlement.status !== "waiting") clearRuntime(claim.matchId);
      // Fire-and-forget: let Discord refresh the public match card.
      onMatchSettled(claim.matchId);

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
    rakeSats: number | null;
    winnerPayoutSats: number | null;
    rakeBps: number;
    stakeFormatted: string | null;
    grossPotFormatted: string | null;
    rakeFormatted: string | null;
    winnerPayoutFormatted: string | null;
  };
  self: {
    userId: string;
    score: number;
    multiplier: number;
    level: number;
    levelDisplay: number;
    maxLevels: number;
    phase: "playing" | "finished";
    endReason?: string;
    submitted: boolean;
    pieces: Array<{ cells: PieceCell[]; placed: boolean }>;
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
  };
  boardSize: number;
};

async function buildStateResponse(
  matchId: number,
  userId: string
): Promise<StateResponse | { error: string }> {
  const match = await getMatch(matchId);
  if (!match) return { error: "Match not found" };

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

  const levelIdx = Math.min(state.level, MAX_LEVELS - 1);
  const pieces = runtime.sequence[levelIdx].map((p, i) => ({
    cells: p.cells,
    placed: state.placedThisLevel[i],
  }));

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

  return {
    boardSize: BOARD_SIZE,
    match: {
      id: match.id,
      mode: match.mode,
      status: match.status,
      stakeSats: match.stake_amount_sats,
      grossPotSats: match.gross_pot_sats,
      rakeSats: match.rake_amount_sats,
      winnerPayoutSats: match.winner_payout_sats,
      rakeBps: match.platform_rake_bps,
      stakeFormatted: match.stake_amount_sats != null ? formatSats(match.stake_amount_sats) : null,
      grossPotFormatted: match.gross_pot_sats != null ? formatSats(match.gross_pot_sats) : null,
      rakeFormatted: match.rake_amount_sats != null ? formatSats(match.rake_amount_sats) : null,
      winnerPayoutFormatted:
        match.winner_payout_sats != null ? formatSats(match.winner_payout_sats) : null,
    },
    self: {
      userId,
      score: state.score,
      multiplier: state.multiplier,
      level: state.level,
      levelDisplay: Math.min(state.level + 1, MAX_LEVELS),
      maxLevels: MAX_LEVELS,
      phase: state.phase,
      endReason: state.endReason,
      submitted: submittedSelf,
      pieces,
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
    },
  };
}

async function ensureMatchRuntimeLoaded(matchId: number): Promise<void> {
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
/*  HTML page                                                          */
/* ────────────────────────────────────────────────────────────────── */

function renderPlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Slice Arcade — PvP</title>
<style>
  :root {
    --bg: #0b0d12;
    --bg-2: #11141b;
    --bg-3: #181c25;
    --line: #232936;
    --text: #e7edf7;
    --muted: #8a93a6;
    --neon: #00cc6a;
    --neon-2: #1ee881;
    --blue: #4f8cff;
    --orange: #ff8a1a;
    --orange-2: #ffb04a;
    --red: #ff4d6d;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: radial-gradient(1200px 800px at 50% -10%, #131826 0%, #0b0d12 60%) fixed; color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif; }
  a { color: var(--neon); text-decoration: none; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 18px 14px 80px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg-2); color: var(--muted); font-size: 12px; font-weight: 500; }
  .badge.live { color: var(--neon-2); border-color: rgba(30,232,129,.35); background: rgba(30,232,129,.08); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
  .stat { background: var(--bg-2); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .stat .value { font-weight: 700; font-size: 20px; margin-top: 2px; }
  .stat.mult .value { color: var(--orange-2); }
  .pot { background: var(--bg-2); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px; color: var(--muted); }
  .pot strong { color: var(--text); }
  .board { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; padding: 8px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 16px; aspect-ratio: 1 / 1; user-select: none; touch-action: manipulation; }
  .cell { background: var(--bg-3); border-radius: 6px; aspect-ratio: 1 / 1; position: relative; transition: background .08s ease, transform .08s ease; }
  .cell.fill-1 { background: var(--blue); box-shadow: inset 0 -2px 0 rgba(0,0,0,.25); }
  .cell.fill-2 { background: var(--orange); box-shadow: inset 0 -2px 0 rgba(0,0,0,.25); }
  .cell.ghost-ok { background: rgba(30,232,129,.55); }
  .cell.ghost-mult { background: rgba(255,138,26,.7); }
  .cell.ghost-bad { background: rgba(255,77,109,.55); }
  .cell.clear-hint { outline: 2px solid rgba(30,232,129,.65); outline-offset: -2px; }
  .grid-rule { box-shadow: inset 0 0 0 1px rgba(255,255,255,.04); }
  /* heavier 3x3 separators */
  .board > .cell:nth-child(3n) { margin-right: 2px; }
  .board > .cell:nth-child(9n) { margin-right: 0; }
  .board > .cell:nth-child(n+19):nth-child(-n+27),
  .board > .cell:nth-child(n+46):nth-child(-n+54) { margin-bottom: 2px; }
  .pieces { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
  .piece { background: var(--bg-2); border: 1px solid var(--line); border-radius: 14px; padding: 10px; cursor: pointer; transition: border-color .1s ease, transform .08s ease; min-height: 110px; display: flex; flex-direction: column; gap: 8px; }
  .piece:hover { border-color: rgba(255,255,255,.12); }
  .piece.selected { border-color: var(--neon); box-shadow: 0 0 0 2px rgba(0,204,106,.18); }
  .piece.placed { opacity: .35; cursor: not-allowed; pointer-events: none; }
  .piece .ptitle { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .piece .pgrid { display: grid; gap: 2px; }
  .piece .pcell { background: var(--bg-3); border-radius: 3px; aspect-ratio: 1/1; }
  .piece .pcell.kn { background: var(--blue); }
  .piece .pcell.km { background: var(--orange); }
  .controls { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .btn { background: var(--bg-2); border: 1px solid var(--line); color: var(--text); padding: 10px 14px; border-radius: 12px; font-weight: 600; font-size: 14px; cursor: pointer; transition: transform .05s ease, background .1s ease, border-color .1s ease; flex: 1 1 auto; }
  .btn:hover { background: #1d2230; }
  .btn.primary { background: var(--neon); color: #001b0c; border-color: transparent; }
  .btn.primary:hover { background: var(--neon-2); }
  .btn.danger { background: transparent; border-color: rgba(255,77,109,.5); color: #ff8a9c; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .opponent { display: flex; align-items: center; justify-content: space-between; background: var(--bg-2); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; margin-top: 12px; font-size: 13px; }
  .opponent .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 6px; }
  .opponent.live .dot { background: var(--neon-2); box-shadow: 0 0 8px rgba(30,232,129,.7); }
  .opponent.done .dot { background: var(--orange-2); }
  .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: rgba(255,77,109,.15); border: 1px solid rgba(255,77,109,.5); color: #ffd0d8; padding: 10px 14px; border-radius: 12px; font-size: 13px; z-index: 50; opacity: 0; transition: opacity .2s ease; pointer-events: none; }
  .toast.show { opacity: 1; }
  .end { margin-top: 16px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
  .end h2 { margin: 0 0 6px 0; font-size: 18px; }
  .end .row { display: flex; justify-content: space-between; padding: 6px 0; color: var(--muted); font-size: 13px; }
  .end .row.win { color: var(--neon-2); font-weight: 700; }
  .end .row.lose { color: #ffb0bb; }
  .footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 22px; }
  @media (max-width: 480px) {
    .stats { grid-template-columns: repeat(3, 1fr); }
    .stat .value { font-size: 17px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div>
      <div style="font-weight:800;font-size:18px;letter-spacing:.02em;">Slice Arcade</div>
      <div id="modeLabel" class="badge" style="margin-top:6px;">Loading…</div>
    </div>
    <div id="liveBadge" class="badge live" style="display:none;">● Live</div>
  </div>

  <div id="potBox" class="pot" style="display:none;"></div>

  <div class="stats">
    <div class="stat"><div class="label">Score</div><div id="score" class="value">0</div></div>
    <div class="stat mult"><div class="label">Multiplier</div><div id="mult" class="value">1×</div></div>
    <div class="stat"><div class="label">Level</div><div id="level" class="value">1/12</div></div>
  </div>

  <div id="board" class="board" aria-label="Game board"></div>

  <div id="pieces" class="pieces"></div>

  <div class="controls">
    <button id="rotateBtn" class="btn">Rotate</button>
    <button id="clearBtn" class="btn">Clear</button>
    <button id="submitBtn" class="btn primary" style="display:none;">Submit final score</button>
  </div>

  <div id="opponentBox" class="opponent" style="display:none;"></div>

  <div id="endBox" class="end" style="display:none;"></div>

  <div class="footer">
    Same shapes for both players. Highest validated score wins. Server validates every move.
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
(() => {
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('t');
  if (!TOKEN) {
    document.body.innerHTML = '<div class="wrap"><h2>Missing token.</h2><p>Open this page from the link Discord gave you.</p></div>';
    return;
  }

  const $board = document.getElementById('board');
  const $pieces = document.getElementById('pieces');
  const $score = document.getElementById('score');
  const $mult = document.getElementById('mult');
  const $level = document.getElementById('level');
  const $mode = document.getElementById('modeLabel');
  const $live = document.getElementById('liveBadge');
  const $rotate = document.getElementById('rotateBtn');
  const $clear = document.getElementById('clearBtn');
  const $submit = document.getElementById('submitBtn');
  const $opponent = document.getElementById('opponentBox');
  const $end = document.getElementById('endBox');
  const $toast = document.getElementById('toast');
  const $pot = document.getElementById('potBox');

  let state = null;
  let selected = { pieceIndex: null, rotation: 0, hoverRow: null, hoverCol: null };

  // Build empty 9x9 grid
  const cellNodes = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell grid-rule';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.addEventListener('mouseenter', () => previewAt(r, c));
      cell.addEventListener('mouseleave', () => previewAt(null, null));
      cell.addEventListener('click', () => placeAt(r, c));
      $board.appendChild(cell);
      cellNodes.push(cell);
    }
  }

  $rotate.addEventListener('click', () => {
    selected.rotation = (selected.rotation + 1) % 4;
    render();
  });
  $clear.addEventListener('click', () => {
    selected = { pieceIndex: null, rotation: 0, hoverRow: null, hoverCol: null };
    render();
  });
  $submit.addEventListener('click', async () => {
    $submit.disabled = true;
    const next = await api('POST', '/arcade/api/submit', {});
    if (next) state = next;
    selected.pieceIndex = null;
    render();
  });

  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => $toast.classList.remove('show'), 2200);
  }

  async function api(method, path, body) {
    try {
      const url = path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
      const init = { method, headers: { 'X-Arcade-Token': TOKEN } };
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
    const minX = Math.min(...out.map(c => c.x));
    const minY = Math.min(...out.map(c => c.y));
    return out.map(c => ({ x: c.x - minX, y: c.y - minY, kind: c.kind }));
  }

  function selectedCells() {
    if (!state || selected.pieceIndex == null) return null;
    const piece = state.self.pieces[selected.pieceIndex];
    if (!piece) return null;
    return rotateCells(piece.cells, selected.rotation);
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
    selected.hoverRow = r;
    selected.hoverCol = c;
    paintBoard();
  }

  async function placeAt(r, c) {
    if (!state) return;
    if (state.self.phase === 'finished') return;
    if (selected.pieceIndex == null) {
      showToast('Pick a piece first');
      return;
    }
    const cells = selectedCells();
    if (!isValidPlacement(cells, r, c)) {
      showToast("That doesn't fit");
      return;
    }
    const next = await api('POST', '/arcade/api/move', {
      level: state.self.level,
      pieceIndex: selected.pieceIndex,
      rotation: selected.rotation,
      row: r,
      col: c,
    });
    if (!next) return;
    state = next;
    // Auto-pick next unplaced piece if any
    if (state.self.phase === 'playing') {
      const idx = state.self.pieces.findIndex(p => !p.placed);
      selected.pieceIndex = idx >= 0 ? idx : null;
    } else {
      selected.pieceIndex = null;
    }
    selected.rotation = 0;
    selected.hoverRow = null;
    selected.hoverCol = null;
    render();
  }

  function paintBoard() {
    const board = state ? state.self.board : Array.from({ length: 9 }, () => new Array(9).fill(0));
    const cells = selectedCells();
    const pr = selected.hoverRow;
    const pc = selected.hoverCol;
    const wouldFit = cells != null && pr != null && pc != null && isValidPlacement(cells, pr, pc);

    // Pre-compute ghost positions
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
        node.className = 'cell grid-rule';
        if (v === 1) node.classList.add('fill-1');
        else if (v === 2) node.classList.add('fill-2');

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
      card.className = 'piece' + (selected.pieceIndex === i ? ' selected' : '') + (p.placed ? ' placed' : '');
      const title = document.createElement('div');
      title.className = 'ptitle';
      title.textContent = 'Piece ' + (i + 1) + (p.placed ? ' • placed' : '');
      card.appendChild(title);

      const previewCells = selected.pieceIndex === i ? rotateCells(p.cells, selected.rotation) : p.cells;
      const w = Math.max(...previewCells.map(c => c.x)) + 1;
      const h = Math.max(...previewCells.map(c => c.y)) + 1;
      const grid = document.createElement('div');
      grid.className = 'pgrid';
      grid.style.gridTemplateColumns = 'repeat(' + w + ', 1fr)';
      grid.style.width = Math.min(120, 22 * w) + 'px';
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
        if (p.placed) return;
        selected.pieceIndex = i;
        selected.rotation = 0;
        render();
      });
      $pieces.appendChild(card);
    });
  }

  function paintHud() {
    if (!state) return;
    $score.textContent = state.self.score.toLocaleString();
    $mult.textContent = state.self.multiplier + '×';
    $level.textContent = state.self.levelDisplay + '/' + state.self.maxLevels;

    const m = state.match;
    let label;
    if (m.mode === 'practice') label = 'Practice • Match #' + m.id;
    else if (m.mode === 'free_pvp') label = 'Free PvP • Match #' + m.id;
    else label = 'Stake ' + (m.stakeFormatted || '?') + ' • Match #' + m.id;
    $mode.textContent = label;

    if (state.self.phase === 'playing' && !state.result.completed) {
      $live.style.display = '';
    } else {
      $live.style.display = 'none';
    }

    if (m.mode === 'staked_pvp' && m.grossPotFormatted) {
      $pot.style.display = '';
      $pot.innerHTML =
        'Gross pot <strong>' + m.grossPotFormatted + '</strong> • ' +
        'Platform fee <strong>' + (m.rakeFormatted || '0') + '</strong> • ' +
        'Winner receives <strong>' + (m.winnerPayoutFormatted || '0') + '</strong>';
    } else {
      $pot.style.display = 'none';
    }

    // Submit shows when self phase is finished AND we haven't already submitted
    if (state.self.phase === 'finished' && !state.self.submitted && !state.result.completed) {
      $submit.style.display = '';
      $submit.disabled = false;
    } else {
      $submit.style.display = 'none';
    }

    // Opponent panel
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

    // End screen
    if (state.result.completed) {
      $end.style.display = '';
      let html = '<h2>Match complete</h2>';
      if (state.opponent) {
        const youScore = state.self.score;
        const oppScore = state.opponent.score ?? 0;
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
      html += '<div class="row" style="margin-top:6px;">You can close this tab — the result is posted in Discord.</div>';
      $end.innerHTML = html;
    } else {
      $end.style.display = 'none';
    }
  }

  function render() {
    paintHud();
    paintPieces();
    paintBoard();
  }

  async function refresh() {
    const next = await api('GET', '/arcade/api/state');
    if (!next) return;
    state = next;
    if (selected.pieceIndex == null && state.self.phase === 'playing') {
      const idx = state.self.pieces.findIndex(p => !p.placed);
      if (idx >= 0) selected.pieceIndex = idx;
    }
    render();
  }

  // Initial load + opponent polling
  refresh();
  setInterval(() => {
    // Only poll when we've submitted and are waiting on opponent, OR when match is still active.
    if (!state) return;
    if (state.result.completed) return;
    if (state.self.submitted || state.opponent) refresh();
  }, 2500);
})();
</script>
</body>
</html>`;
}

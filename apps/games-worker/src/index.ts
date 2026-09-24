import {
  isArcadeCommand,
  isSatscapeCommand,
  parseJsonObject,
  verifySignedRequest,
  type ArcadeCommand,
  type ServiceResult,
  type SatscapeCommand,
} from "@mezosbot/contracts";
import {
  applyMove,
  canEnter,
  clampDurationMinutes,
  generatePieceSequence,
  hashSeed,
  movePoint,
  pieceForSlot,
  replayMoves,
  type Direction,
  type Move,
} from "@mezosbot/game-core";
import { ArcadeRoom } from "./arcade-room.js";
import { playRedirect, publicMatch } from "./policy.js";
import { SATSCAPE_MIN_MOVE_INTERVAL_MS, encounterAt, revealTiles } from "./satscape-rules.js";
import { rest, rpc } from "./supabase.js";
import { issuePlayToken, verifyPlayToken } from "./tokens.js";

export { ArcadeRoom };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** Seconds of slack after started_at + duration_seconds; mirrors save_arcade_draft_v1. */
const ARCADE_MOVE_GRACE_SECONDS = 5;

/** Sweeper tuning for expire_stale_arcade_matches_v1 (cron trigger in wrangler.jsonc). */
const ARCADE_EXPIRE_WAITING_MINUTES = 30;
const ARCADE_EXPIRE_GRACE_SECONDS = 60;

function json(value: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function resultError(code: string, message: string, status: number, requestId?: string): Response {
  return json({ ok: false, error: { code, message, retryable: status >= 500, requestId }, requestId }, status);
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = new Set<string>([env.ARCADE_ORIGIN, env.SATSCAPE_ORIGIN]);
  return allowed.has(origin) ? origin : null;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = allowedOrigin(request, env);
  return origin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, idempotency-key, x-mezo-signature, x-mezo-timestamp, x-mezo-nonce, x-request-id",
    "access-control-max-age": "86400",
    vary: "Origin",
  } : {};
}

async function authenticateInternal(request: Request, env: Env, body: string): Promise<{ ok: true; requestId: string; idempotencyKey: string } | { ok: false; response: Response }> {
  const verified = await verifySignedRequest({ secret: env.INTERNAL_SIGNING_SECRET, method: request.method, url: request.url, body, headers: request.headers });
  if (!verified.ok) return { ok: false, response: resultError("unauthorized", verified.reason, 401) };
  const claimed = await rpc<boolean>(env, "consume_integration_nonce_v1", {
    p_service: "games-worker",
    p_nonce: verified.headers.nonce,
    p_expires_at: new Date(Number(verified.headers.timestamp) + 120_000).toISOString(),
  });
  if (!claimed) return { ok: false, response: resultError("replayed_request", "Nonce has already been used", 409, verified.headers.requestId) };
  return { ok: true, requestId: verified.headers.requestId, idempotencyKey: verified.headers.idempotencyKey };
}

type ArcadeRow = {
  id: number;
  mode: string;
  status: string;
  seed: string;
  created_by_id?: string;
  player_a_id: string;
  player_b_id: string | null;
  duration_seconds: number;
  started_at?: string | null;
  player_a_score?: number | null;
  player_b_score?: number | null;
};
type ArcadeView = {
  forbidden?: boolean;
  match: ArcadeRow & { player_a_ready: boolean; player_b_ready: boolean; player_a_submitted: boolean; player_b_submitted: boolean; winner_id: string | null };
  deadline_at?: string | null;
  server_now?: string;
  submission: { move_log?: Move[] };
};

function isPlayer(match: Pick<ArcadeRow, "player_a_id" | "player_b_id">, userId: string): boolean {
  return match.player_a_id === userId || match.player_b_id === userId;
}

async function getArcadeState(env: Env, matchId: number, actorId: string) {
  const view = await rpc<ArcadeView | null>(env, "get_arcade_view_v1", { p_match_id: matchId, p_user_id: actorId });
  if (!view || view.forbidden) return null;
  const moves = Array.isArray(view.submission?.move_log) ? view.submission.move_log : [];
  const sequence = generatePieceSequence(hashSeed(view.match.seed));
  const replay = replayMoves(sequence, moves);
  if (!replay.valid) throw new Error(`Stored Arcade replay is invalid: ${replay.error}`);
  const state = replay.state;
  const pieces = [0, 1, 2].map((pieceIndex) => pieceForSlot(state, sequence, state.level, pieceIndex));
  return {
    sequence,
    match: view.match,
    deadlineAt: view.deadline_at ?? null,
    self: { ...state, pieces },
  };
}

function parseMove(value: Record<string, unknown> | null): Move | null {
  if (!value) return null;
  const integer = (key: string) => typeof value[key] === "number" && Number.isInteger(value[key]) ? value[key] as number : null;
  const level = integer("level");
  const pieceIndex = integer("pieceIndex");
  if (level === null || pieceIndex === null || pieceIndex < 0 || pieceIndex > 2) return null;
  if (value.kind === "bank") return { kind: "bank", level, pieceIndex };
  const rotation = integer("rotation"); const row = integer("row"); const col = integer("col");
  if (rotation === null || row === null || col === null || rotation < 0 || rotation > 3) return null;
  return { kind: "place", level, pieceIndex, rotation: rotation as 0 | 1 | 2 | 3, row, col };
}

function playUrl(env: Env, matchId: number, token: string): string {
  return `${env.ARCADE_ORIGIN}/?match=${matchId}&token=${encodeURIComponent(token)}`;
}

async function handleArcadeCommand(command: ArcadeCommand, env: Env, idempotencyKey: string, requestId: string): Promise<Response> {
  if (command.action === "accept") {
    if (!command.matchId) return resultError("bad_request", "matchId is required", 400, requestId);
    // Seating and (for staked_pvp) the stake debit happen atomically in the RPC,
    // so a player who loses the join race is never charged.
    const joined = await rpc<{ ok: boolean; code?: string; match?: ArcadeRow }>(env, "join_arcade_match_v1", { p_match_id: command.matchId, p_user_id: command.actorId });
    if (!joined.ok || !joined.match) return resultError(joined.code ?? "join_failed", "Unable to join match", 409, requestId);
    const token = await issuePlayToken(env.PLAY_TOKEN_SECRET, { sub: command.actorId, game: "arcade", matchId: command.matchId, exp: Date.now() + 15 * 60_000 });
    return json({ ok: true, value: { match: publicMatch(joined.match), playUrl: playUrl(env, command.matchId, token) }, requestId });
  }

  if (command.action === "cancel") {
    if (!command.matchId) return resultError("bad_request", "matchId is required", 400, requestId);
    const cancelled = await rpc<{ ok: boolean; code?: string }>(env, "refund_arcade_match_v1", {
      p_match_id: command.matchId, p_actor_id: command.actorId, p_idempotency_key: `${idempotencyKey}:cancel`,
    });
    if (!cancelled.ok) {
      const status = cancelled.code === "not_creator" ? 403 : cancelled.code === "match_not_found" ? 404 : 409;
      return resultError(cancelled.code ?? "cancel_failed", "Unable to cancel match", status, requestId);
    }
    return json({ ok: true, value: { match: { id: command.matchId, status: "cancelled" } }, requestId });
  }

  if (command.action === "status") {
    if (!command.matchId) return resultError("bad_request", "matchId is required", 400, requestId);
    const rows = await rest<ArcadeRow[]>(env, `arcade_matches?id=eq.${command.matchId}&select=id,mode,status,player_a_id,player_b_id,duration_seconds,started_at,player_a_score,player_b_score,winner_id`);
    const match = rows[0];
    if (!match) return resultError("not_found", "Match not found", 404, requestId);
    // No spectator mode: only seated players get a play token.
    if (!isPlayer(match, command.actorId)) {
      return json({ ok: true, value: { match: publicMatch(match), playUrl: null }, requestId } satisfies ServiceResult<unknown>);
    }
    const token = await issuePlayToken(env.PLAY_TOKEN_SECRET, { sub: command.actorId, game: "arcade", matchId: match.id, exp: Date.now() + 15 * 60_000 });
    return json({ ok: true, value: { match: publicMatch(match), playUrl: playUrl(env, match.id, token) }, requestId } satisfies ServiceResult<unknown>);
  }

  if (!["create_practice", "create_challenge", "create_offer", "create_tipfight"].includes(command.action)) {
    return resultError("not_implemented", `Arcade action ${command.action} is not enabled in the staged Worker`, 501, requestId);
  }
  const mode = command.action === "create_practice" ? "practice" : command.action === "create_tipfight" ? "tipfight" : (command.stakeSats ?? 0) > 0 ? "staked_pvp" : "free_pvp";
  const durationSeconds = clampDurationMinutes(command.durationMinutes, 3) * 60;
  const stake = mode === "staked_pvp" || mode === "tipfight" ? command.stakeSats ?? null : null;
  // create_arcade_match_v1 debits the creator's stake in the same transaction;
  // on insufficient balance no match is created.
  const created = await rpc<{ ok: boolean; code?: string; match?: ArcadeRow }>(env, "create_arcade_match_v1", {
    p_mode: mode, p_created_by_id: command.actorId, p_target_player_id: command.opponentId ?? null,
    p_stake_sats: stake, p_channel_id: command.channelId ?? null,
    p_duration_seconds: durationSeconds, p_idempotency_key: `${idempotencyKey}:create`,
  });
  const match = created.match;
  if (!created.ok || !match) return resultError(created.code ?? "create_failed", "Match was not created", 409, requestId);
  const token = await issuePlayToken(env.PLAY_TOKEN_SECRET, { sub: command.actorId, game: "arcade", matchId: match.id, exp: Date.now() + 15 * 60_000 });
  return json({ ok: true, value: { match: publicMatch(match), playUrl: playUrl(env, match.id, token) }, requestId } satisfies ServiceResult<unknown>, 201);
}

async function handleSatscapeCommand(command: SatscapeCommand, env: Env, requestId: string): Promise<Response> {
  if (command.action === "join") {
    const started = await rpc<{ ok: boolean; code?: string }>(env, "start_satscape_run_v1", { p_discord_id: command.actorId, p_buyin_sats: 50, p_spawn_x: 127, p_spawn_y: 111 });
    if (!started.ok) return resultError(started.code ?? "join_failed", "Unable to start SatScape", 409, requestId);
  }
  const view = await rpc<Record<string, unknown> | null>(env, "get_satscape_view_v1", { p_discord_id: command.actorId, p_radius: 8 });
  if (!view?.player && command.action !== "join") return resultError("not_active", "Use /satscape join first", 409, requestId);
  const token = await issuePlayToken(env.PLAY_TOKEN_SECRET, { sub: command.actorId, game: "satscape", exp: Date.now() + 15 * 60_000 });
  const anchor = command.action === "open_shop" ? "#shop" : command.action === "open_quests" ? "#quests" : "";
  return json({ ok: true, value: { view, playUrl: `${env.SATSCAPE_ORIGIN}/?token=${encodeURIComponent(token)}${anchor}` }, requestId } satisfies ServiceResult<unknown>);
}

const ARCADE_CONFLICT_MESSAGES: Record<string, string> = {
  waiting: "Waiting for an opponent",
  not_started: "Both players must be ready",
  deadline_passed: "The match clock has run out",
  already_submitted: "You already submitted this match",
  draft_conflict: "Another move was saved first; reload and try again",
  match_not_active: "The match is no longer active",
};

type SatscapeSnapshot = {
  player?: { active: boolean; x_coord: number; y_coord: number; hunger: number; state: string; state_version: number; last_move_at?: string | null };
  inventory?: Array<{ item_id: string }>;
  cleared?: Array<[number, number]>;
};

async function handleSatscapeMove(request: Request, env: Env, sub: string): Promise<Response> {
  const input = parseJsonObject(await request.text());
  const direction = input?.direction;
  if (!["up", "down", "left", "right"].includes(String(direction))) {
    return resultError("invalid_action", "direction must be up, down, left, or right", 400);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await rpc<SatscapeSnapshot | null>(env, "get_satscape_action_snapshot_v1", { p_discord_id: sub, p_radius: 8 });
    const player = snapshot?.player;
    if (!player || !player.active) return resultError("not_active", "SatScape run is not active", 409);
    if (player.state !== "idle") return resultError("bad_state", "Movement is unavailable in the current state", 409);
    const lastMove = player.last_move_at ? Date.parse(player.last_move_at) : NaN;
    if (Number.isFinite(lastMove) && Date.now() - lastMove < SATSCAPE_MIN_MOVE_INTERVAL_MS) {
      return resultError("too_fast", "Slow down a little", 429);
    }
    // Legacy burns 1 sat of HP per step at 0 stamina (money movement); the
    // Worker refuses instead so the player eats or moves via Discord.
    if (player.hunger <= 0) return resultError("exhausted", "Out of stamina — eat bread in Discord to keep moving", 409);
    const next = movePoint({ x: player.x_coord, y: player.y_coord }, direction as Direction);
    const inventory = snapshot?.inventory ?? [];
    if (!canEnter(next.x, next.y, { ownsBoat: inventory.some((item) => item.item_id === "boat") })) {
      return resultError("blocked_tile", "That tile cannot be entered", 409);
    }
    const cleared = new Set((snapshot?.cleared ?? []).map(([x, y]) => `${x},${y}`));
    const encounter = encounterAt(next.x, next.y, cleared);
    if (encounter) {
      return json({ ok: false, error: { code: "encounter", message: `A ${encounter} blocks the way — continue in Discord`, retryable: false }, encounter, position: next }, 409);
    }
    const commit = await rpc<{ ok: boolean; conflict?: boolean; state_version?: number }>(env, "commit_satscape_action_v1", {
      p_discord_id: sub,
      p_expected_version: player.state_version,
      p_player_patch: { x_coord: next.x, y_coord: next.y, hunger: Math.max(0, player.hunger - 1), last_move_at: new Date().toISOString() },
      p_combat_patch: null,
      p_delete_combat: false,
      p_inventory_deltas: [],
      p_explored_tiles: revealTiles(next.x, next.y),
      p_cleared_tiles: [],
      p_event: null,
    });
    if (commit.ok) return json({ ok: true, value: { position: next, stateVersion: commit.state_version } });
    if (!commit.conflict || attempt === 1) return resultError("state_conflict", "Game state changed; reload and try again", 409);
  }
  return resultError("state_conflict", "Game state changed; reload and try again", 409);
}

async function handleArcadeApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const token = await verifyPlayToken(env.PLAY_TOKEN_SECRET, url.searchParams.get("token"), "arcade");
  if (!token?.matchId) return resultError("unauthorized", "Invalid or expired play token", 401);
  const state = await getArcadeState(env, token.matchId, token.sub);
  if (!state) return resultError("forbidden", "Match not found or player is not in it", 403);
  const room = () => env.ARCADE_ROOMS.getByName(String(token.matchId));

  if (url.pathname === "/api/v1/arcade/state" && request.method === "GET") {
    return json({ ok: true, value: { match: publicMatch(state.match), deadlineAt: state.deadlineAt, self: state.self } });
  }
  if (url.pathname === "/api/v1/arcade/ready" && request.method === "POST") {
    const ready = await rpc<{ ok: boolean; code?: string; match?: ArcadeView["match"] }>(env, "mark_arcade_ready_v1", {
      p_match_id: token.matchId, p_user_id: token.sub,
    });
    if (!ready.ok || !ready.match) return resultError(ready.code ?? "ready_failed", "Unable to mark player ready", 409);
    ctx.waitUntil(room().broadcast({ type: "arcade.ready", matchId: token.matchId, actorId: token.sub }));
    return json({ ok: true, value: { match: publicMatch(ready.match) } });
  }
  if (url.pathname === "/api/v1/arcade/move" && request.method === "POST") {
    if (state.match.status === "waiting") return resultError("waiting", ARCADE_CONFLICT_MESSAGES.waiting, 409);
    if (state.match.mode !== "practice" && !(state.match.player_a_ready && state.match.player_b_ready)) {
      return resultError("not_started", ARCADE_CONFLICT_MESSAGES.not_started, 409);
    }
    const submitted = state.match.player_a_id === token.sub ? state.match.player_a_submitted : state.match.player_b_submitted;
    if (submitted) return resultError("already_submitted", ARCADE_CONFLICT_MESSAGES.already_submitted, 409);
    if (state.deadlineAt && Date.now() > Date.parse(state.deadlineAt) + ARCADE_MOVE_GRACE_SECONDS * 1000) {
      return resultError("deadline_passed", ARCADE_CONFLICT_MESSAGES.deadline_passed, 409);
    }
    const move = parseMove(parseJsonObject(await request.text()));
    if (!move) return resultError("invalid_move", "Move does not match the v1 schema", 400);
    const result = applyMove(state.self, state.sequence, move);
    if (!result.ok) return resultError("invalid_move", result.error, 400);
    // Compare-and-set on the stored move count: concurrent moves cannot overwrite each other.
    const saved = await rpc<{ ok: boolean; code?: string }>(env, "save_arcade_draft_v1", {
      p_match_id: token.matchId, p_user_id: token.sub, p_move_log: result.state.moves, p_score: result.state.score,
      p_expected_moves: state.self.moves.length,
    });
    if (!saved.ok) {
      const code = saved.code ?? "save_failed";
      return resultError(code, ARCADE_CONFLICT_MESSAGES[code] ?? "Unable to persist move", 409);
    }
    // Deliberately no room broadcast: moves must not wake the Durable Object,
    // and the opponent's live score/board stays private until settlement.
    const level = result.state.level;
    const pieces = [0, 1, 2].map((pieceIndex) => pieceForSlot(result.state, state.sequence, level, pieceIndex));
    return json({ ok: true, value: { self: { ...result.state, pieces } } });
  }
  if (url.pathname === "/api/v1/arcade/submit" && request.method === "POST") {
    const key = `web:${token.matchId}:${token.sub}:${state.self.moves.length}:${state.self.score}`;
    const settled = await rpc<{ ok: boolean; code?: string; status?: string; winner_id?: string | null }>(env, "submit_and_settle_arcade_match_v1", {
      p_match_id: token.matchId, p_user_id: token.sub, p_move_log: state.self.moves,
      p_claimed_score: state.self.score, p_validated_score: state.self.score,
      p_valid: true, p_validation_error: null, p_idempotency_key: key,
    });
    if (!settled.ok) {
      const code = settled.code ?? "settlement_failed";
      return resultError(code, ARCADE_CONFLICT_MESSAGES[code] ?? "Unable to submit match", 409);
    }
    ctx.waitUntil(room().broadcast({ type: "arcade.submitted", matchId: token.matchId, actorId: token.sub, status: settled.status, winnerId: settled.winner_id ?? null }));
    return json({ ok: true, value: settled });
  }
  return resultError("not_found", "Arcade endpoint not found", 404);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (url.pathname === "/healthz") return json({ status: "ok", service: "games-worker", version: 1 });
  if (url.hostname === "play.mallard.sh") {
    return playRedirect(url, { arcade: env.ARCADE_ORIGIN, satscape: env.SATSCAPE_ORIGIN });
  }

  if (url.pathname === "/internal/v1/arcade/command" || url.pathname === "/internal/v1/satscape/command") {
    if (request.method !== "POST") return resultError("method_not_allowed", "POST required", 405);
    const body = await request.text();
    const auth = await authenticateInternal(request, env, body);
    if (!auth.ok) return auth.response;
    const parsed = parseJsonObject(body);
    if (url.pathname.includes("/arcade/")) {
      if (!isArcadeCommand(parsed)) return resultError("invalid_contract", "Invalid ArcadeCommand v1", 400, auth.requestId);
      return handleArcadeCommand(parsed, env, auth.idempotencyKey, auth.requestId);
    }
    if (!isSatscapeCommand(parsed)) return resultError("invalid_contract", "Invalid SatscapeCommand v1", 400, auth.requestId);
    return handleSatscapeCommand(parsed, env, auth.requestId);
  }

  const roomMatch = url.pathname.match(/^\/api\/v1\/arcade\/rooms\/(\d+)\/websocket$/);
  if (roomMatch) {
    const token = await verifyPlayToken(env.PLAY_TOKEN_SECRET, url.searchParams.get("token"), "arcade");
    if (!token || token.matchId !== Number(roomMatch[1])) return resultError("unauthorized", "Invalid room token", 401);
    return env.ARCADE_ROOMS.getByName(roomMatch[1]).fetch(request);
  }

  if (url.pathname.startsWith("/api/v1/arcade/")) return handleArcadeApi(request, env, ctx, url);

  if (url.pathname === "/api/v1/satscape/state" && request.method === "GET") {
    const token = await verifyPlayToken(env.PLAY_TOKEN_SECRET, url.searchParams.get("token"), "satscape");
    if (!token) return resultError("unauthorized", "Invalid or expired play token", 401);
    return json(await rpc(env, "get_satscape_view_v1", { p_discord_id: token.sub, p_radius: 8 }));
  }

  if (url.pathname === "/api/v1/satscape/action" && request.method === "POST") {
    const token = await verifyPlayToken(env.PLAY_TOKEN_SECRET, url.searchParams.get("token"), "satscape");
    if (!token) return resultError("unauthorized", "Invalid or expired play token", 401);
    return handleSatscapeMove(request, env, token.sub);
  }

  if (url.pathname.startsWith("/api/")) return resultError("not_found", "API endpoint not found", 404);

  const broadcastMatch = url.pathname.match(/^\/internal\/v1\/arcade\/rooms\/(\d+)\/broadcast$/);
  if (broadcastMatch && request.method === "POST") {
    const body = await request.text();
    const auth = await authenticateInternal(request, env, body);
    if (!auth.ok) return auth.response;
    const message = parseJsonObject(body);
    if (!message || typeof message.type !== "string") return resultError("invalid_contract", "Broadcast needs a string type", 400, auth.requestId);
    const delivered = await env.ARCADE_ROOMS.getByName(broadcastMatch[1]).broadcast({ ...message, type: message.type });
    return json({ ok: true, value: { delivered }, requestId: auth.requestId });
  }

  if (url.hostname === new URL(env.SATSCAPE_ORIGIN).hostname && url.pathname === "/") {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/satscape/index.html";
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
  if (url.hostname === new URL(env.ARCADE_ORIGIN).hostname && url.pathname === "/") {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/arcade/index.html";
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
  return env.ASSETS.fetch(request);
}

/** Every /api response (success or error, including 500s) carries the same CORS headers. */
function withApiCors(response: Response, request: Request, env: Env): Response {
  if (!new URL(request.url).pathname.startsWith("/api/") || response.status === 101) return response;
  const headers = corsHeaders(request, env);
  if (Object.keys(headers).length === 0) return response;
  const patched = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) patched.headers.set(name, value);
  return patched;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    let response: Response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", service: "games-worker", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      response = resultError("internal_error", "Request failed", 500, request.headers.get("x-request-id") ?? undefined);
    }
    if (response.status === 101) return response;
    response = withApiCors(response, request, env);
    try {
      response.headers.set("server-timing", `worker;dur=${Date.now() - started}`);
    } catch {
      // Immutable headers (e.g. Response.redirect); timing is best-effort.
    }
    return response;
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const result = await rpc<{ ok: boolean; cancelled: number; settled: number }>(env, "expire_stale_arcade_matches_v1", {
        p_waiting_minutes: ARCADE_EXPIRE_WAITING_MINUTES,
        p_grace_seconds: ARCADE_EXPIRE_GRACE_SECONDS,
        p_limit: 100,
      });
      console.log(JSON.stringify({ level: "info", service: "games-worker", job: "arcade.expire", ...result }));
    })());
  },
} satisfies ExportedHandler<Env>;


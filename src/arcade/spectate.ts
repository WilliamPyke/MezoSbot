/**
 * Spectator broadcast registry.
 *
 * Maps match id → set of WebSocket subscribers. When a player makes a move
 * (runtime.ts) or the match settles (notify.ts), we build a fresh snapshot
 * from the in-memory MatchRuntime and push it to every subscriber.
 *
 * Display names are resolved lazily through an injected resolver (set at bot
 * startup so this module doesn't need a hard dep on discord.js).
 */
import type { WebSocket } from "ws";
import { getRuntime } from "./runtime.js";
import { getMatch, type ArcadeMatchRow } from "./db.js";
import type { Board, GeneratedPiece } from "./types.js";

type Subscriber = {
  ws: WebSocket;
  matchId: number;
};

const subscribers = new Map<number, Set<Subscriber>>();
const pendingBroadcasts = new Map<number, ReturnType<typeof setTimeout>>();

/** display name cache: discord id → resolved label */
const displayNameCache = new Map<string, string>();

type DisplayNameResolver = (userId: string) => Promise<string | null>;
let resolveDisplayName: DisplayNameResolver = async () => null;

export function setDisplayNameResolver(resolver: DisplayNameResolver) {
  resolveDisplayName = resolver;
}

async function getDisplayName(userId: string): Promise<string> {
  if (displayNameCache.has(userId)) return displayNameCache.get(userId)!;
  try {
    const name = await resolveDisplayName(userId);
    const label = name ?? userId;
    displayNameCache.set(userId, label);
    return label;
  } catch {
    displayNameCache.set(userId, userId);
    return userId;
  }
}

export function addSpectator(matchId: number, ws: WebSocket): void {
  let set = subscribers.get(matchId);
  if (!set) {
    set = new Set();
    subscribers.set(matchId, set);
  }
  const sub: Subscriber = { ws, matchId };
  set.add(sub);

  const cleanup = () => removeSubscriber(matchId, sub);
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  console.log(`[Spectate] subscriber added to match ${matchId} (${set.size} viewers)`);
}

function removeSubscriber(matchId: number, sub: Subscriber): void {
  const set = subscribers.get(matchId);
  if (!set) return;
  if (set.delete(sub)) {
    console.log(`[Spectate] subscriber removed from match ${matchId} (${set.size} viewers)`);
  }
  if (set.size === 0) subscribers.delete(matchId);
}

export function spectatorCount(matchId: number): number {
  return subscribers.get(matchId)?.size ?? 0;
}

/** Build an immutable snapshot of the match suitable for spectator rendering. */
export async function buildSpectatorSnapshot(matchId: number) {
  const match = await getMatch(matchId);
  if (!match) return null;
  return buildSnapshotFromMatch(match);
}

async function buildSnapshotFromMatch(match: ArcadeMatchRow) {
  const runtime = getRuntime(match.id);

  const playerIds: string[] = [match.player_a_id];
  if (match.player_b_id) playerIds.push(match.player_b_id);

  const players = await Promise.all(
    playerIds.map(async (id) => {
      const state = runtime?.players.get(id);
      const isA = id === match.player_a_id;
      const submitted = isA ? match.player_a_submitted : match.player_b_submitted;
      const persistedScore = isA ? match.player_a_score : match.player_b_score;

      let board: Board | null = null;
      let score = persistedScore ?? 0;
      let level = 0;
      let multiplier = 1;
      let currentPieces: Array<GeneratedPiece | null> = [];
      let placedThisLevel: boolean[] = [];

      if (state) {
        board = state.board;
        score = state.score;
        level = state.level;
        multiplier = state.multiplier;
        placedThisLevel = state.placedThisLevel;
        if (runtime) {
          const slots = runtime.sequence[state.level] ?? [];
          currentPieces = slots.map((piece, idx) => {
            const overrideKey = `${state.level}:${idx}`;
            if (state.slotOverrides[overrideKey] !== undefined) {
              return state.slotOverrides[overrideKey];
            }
            return piece;
          });
        }
      }

      return {
        id,
        displayName: await getDisplayName(id),
        score,
        level,
        multiplier,
        board,
        placedThisLevel,
        currentPieces,
        submitted: !!submitted,
      };
    })
  );

  return {
    type: "state" as const,
    matchId: match.id,
    mode: match.mode,
    status: match.status,
    duration: match.duration_seconds,
    startedAt: match.started_at,
    completedAt: match.completed_at,
    winnerId: match.winner_id,
    stake: match.stake_amount_sats,
    winnerPayout: match.winner_payout_sats,
    players,
  };
}

async function sendBroadcastNow(matchId: number): Promise<void> {
  const set = subscribers.get(matchId);
  if (!set || set.size === 0) return;
  const snapshot = await buildSpectatorSnapshot(matchId);
  if (!snapshot) return;
  const payload = JSON.stringify(snapshot);
  for (const sub of set) {
    try {
      sub.ws.send(payload);
    } catch {
      // best-effort; client will be cleaned up on close
    }
  }
}

/** Schedule a coalesced snapshot push to every subscriber for this match. */
export async function broadcastMatchState(matchId: number): Promise<void> {
  const set = subscribers.get(matchId);
  if (!set || set.size === 0 || pendingBroadcasts.has(matchId)) return;

  const timer = setTimeout(() => {
    pendingBroadcasts.delete(matchId);
    sendBroadcastNow(matchId).catch((err) => {
      console.error("[Spectate] broadcast error:", (err as Error)?.message ?? err);
    });
  }, 80);
  pendingBroadcasts.set(matchId, timer);
}

/** Send final snapshot, then close all spectator sockets for this match. */
export async function closeMatchSpectators(matchId: number): Promise<void> {
  const set = subscribers.get(matchId);
  if (!set || set.size === 0) return;
  const pending = pendingBroadcasts.get(matchId);
  if (pending) {
    clearTimeout(pending);
    pendingBroadcasts.delete(matchId);
  }
  const snapshot = await buildSpectatorSnapshot(matchId);
  const payload = snapshot ? JSON.stringify(snapshot) : null;
  for (const sub of set) {
    try {
      if (payload) sub.ws.send(payload);
      sub.ws.close(1000, "match completed");
    } catch {
      // ignore
    }
  }
  subscribers.delete(matchId);
}

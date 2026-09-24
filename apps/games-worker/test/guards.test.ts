import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { safeCloseCode } from "../src/arcade-room";
import { PLAY_REDIRECT_ENDS_AT, playRedirect, publicMatch } from "../src/policy";
import { encounterAt, revealTiles, townAt } from "../src/satscape-rules";
import { issuePlayToken, verifyPlayToken } from "../src/tokens";
import { signCanonicalRequest } from "@mezosbot/contracts";
import { applyMove, canEnter, createPlayerState, generatePieceSequence, hashSeed, isChestAt, MAP_H, MAP_W, type Move } from "@mezosbot/game-core";

const SECRET = "test-play-secret";

type RpcCall = { name: string; body: Record<string, unknown> };

/** A fake Env whose Supabase RPCs are answered by `handler`; records every call. */
function fakeEnv(handler: (name: string, body: Record<string, unknown>) => unknown) {
  const calls: RpcCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const name = url.pathname.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ name, body });
    return new Response(JSON.stringify(handler(name, body)), { status: 200, headers: { "content-type": "application/json" } });
  });
  const broadcasts: unknown[] = [];
  const testEnv = {
    ...env,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    INTERNAL_SIGNING_SECRET: "internal",
    PLAY_TOKEN_SECRET: SECRET,
    ARCADE_ORIGIN: "https://arcade.mallard.sh",
    SATSCAPE_ORIGIN: "https://satscape.mallard.sh",
    ARCADE_ROOMS: { getByName: () => ({ broadcast: async (message: unknown) => { broadcasts.push(message); return 0; } }) },
  } as unknown as Env;
  return { testEnv, calls, broadcasts };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

function arcadeView(overrides: Record<string, unknown> = {}, moves: unknown[] = []) {
  return {
    match: {
      id: 7, mode: "staked_pvp", status: "active", seed: "secret-seed", player_a_id: "a", player_b_id: "b",
      duration_seconds: 180, started_at: new Date().toISOString(), player_a_ready: true, player_b_ready: true,
      player_a_submitted: false, player_b_submitted: false, winner_id: null, player_a_score: 0, player_b_score: 55,
      ...overrides,
    },
    deadline_at: new Date(Date.now() + 120_000).toISOString(),
    submission: { move_log: moves },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("play tokens", () => {
  it("rejects tokens without a numeric exp", async () => {
    const payload = btoa(JSON.stringify({ sub: "a", game: "arcade", matchId: 1 })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const forged = `${payload}.${await signCanonicalRequest(SECRET, payload)}`;
    expect(await verifyPlayToken(SECRET, forged, "arcade")).toBeNull();
    const stringExp = await issuePlayToken(SECRET, { sub: "a", game: "arcade", exp: "9999999999999" as unknown as number });
    expect(await verifyPlayToken(SECRET, stringExp, "arcade")).toBeNull();
  });

  it("accepts a fresh token and rejects an expired one or the wrong game", async () => {
    const token = await issuePlayToken(SECRET, { sub: "a", game: "arcade", matchId: 3, exp: Date.now() + 60_000 });
    expect(await verifyPlayToken(SECRET, token, "arcade")).toMatchObject({ sub: "a", matchId: 3 });
    expect(await verifyPlayToken(SECRET, token, "satscape")).toBeNull();
    expect(await verifyPlayToken(SECRET, token, "arcade", Date.now() + 120_000)).toBeNull();
  });
});

describe("worker hygiene", () => {
  it("redirects play.mallard.sh until the end date, then returns 410", async () => {
    const url = new URL("https://play.mallard.sh/satscape?x=1");
    const origins = { arcade: "https://arcade.mallard.sh", satscape: "https://satscape.mallard.sh" };
    const before = playRedirect(url, origins, PLAY_REDIRECT_ENDS_AT - 1);
    expect(before.status).toBe(308);
    expect(before.headers.get("location")).toBe("https://satscape.mallard.sh/satscape?x=1");
    expect(playRedirect(url, origins, PLAY_REDIRECT_ENDS_AT).status).toBe(410);
    expect(new Date(PLAY_REDIRECT_ENDS_AT).toISOString()).toBe("2026-10-24T00:00:00.000Z");
  });

  it("adds CORS headers to /api error responses", async () => {
    const { testEnv } = fakeEnv(() => null);
    const response = await worker.fetch(new Request("https://arcade.mallard.sh/api/v1/arcade/state", {
      headers: { origin: "https://arcade.mallard.sh" },
    }), testEnv, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://arcade.mallard.sh");
    const unknown = await worker.fetch(new Request("https://arcade.mallard.sh/api/v1/nope", {
      headers: { origin: "https://satscape.mallard.sh" },
    }), testEnv, ctx);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("access-control-allow-origin")).toBe("https://satscape.mallard.sh");
  });

  it("never echoes reserved close codes", () => {
    expect(safeCloseCode(1005)).toBe(1000);
    expect(safeCloseCode(1006)).toBe(1000);
    expect(safeCloseCode(1015)).toBe(1000);
    expect(safeCloseCode(4001)).toBe(4001);
    expect(safeCloseCode(1001)).toBe(1001);
  });

  it("answers ping with pong through the hibernation auto-response", async () => {
    const room = env.ARCADE_ROOMS.getByName("ping-test");
    const response = await room.fetch("https://room.test", { headers: { upgrade: "websocket" } });
    const socket = response.webSocket!;
    socket.accept();
    const pong = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => { if (event.data === "pong") resolve(String(event.data)); });
    });
    socket.send("ping");
    await expect(pong).resolves.toBe("pong");
    socket.close(1000, "done");
  });
});

describe("arcade fairness", () => {
  it("never sends the seed or live scores to the client", () => {
    const hidden = publicMatch({ id: 1, status: "active", seed: "s", player_a_score: 1, player_b_score: 2 });
    expect(hidden).not.toHaveProperty("seed");
    expect(hidden).not.toHaveProperty("player_b_score");
    const settled = publicMatch({ id: 1, status: "completed", seed: "s", player_a_score: 1, player_b_score: 2 });
    expect(settled).toMatchObject({ player_a_score: 1, player_b_score: 2 });
    expect(settled).not.toHaveProperty("seed");
  });

  it("state endpoint strips the seed and opponent score", async () => {
    const { testEnv } = fakeEnv((name) => name === "get_arcade_view_v1" ? arcadeView() : null);
    const token = await issuePlayToken(SECRET, { sub: "a", game: "arcade", matchId: 7, exp: Date.now() + 60_000 });
    const response = await worker.fetch(new Request(`https://arcade.mallard.sh/api/v1/arcade/state?token=${encodeURIComponent(token)}`), testEnv, ctx);
    const body = await response.json() as { value: { match: Record<string, unknown> } };
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("secret-seed");
    expect(body.value.match).not.toHaveProperty("player_b_score");
  });

  it("freezes moves after submit and past the deadline without touching the draft", async () => {
    const token = await issuePlayToken(SECRET, { sub: "a", game: "arcade", matchId: 7, exp: Date.now() + 60_000 });
    const move = JSON.stringify({ kind: "bank", level: 0, pieceIndex: 0 });
    const url = `https://arcade.mallard.sh/api/v1/arcade/move?token=${encodeURIComponent(token)}`;

    const submitted = fakeEnv((name) => name === "get_arcade_view_v1" ? arcadeView({ player_a_submitted: true }) : { ok: true });
    const frozen = await worker.fetch(new Request(url, { method: "POST", body: move }), submitted.testEnv, ctx);
    expect(frozen.status).toBe(409);
    expect(submitted.calls.map((call) => call.name)).not.toContain("save_arcade_draft_v1");
    vi.restoreAllMocks();

    const late = fakeEnv((name) => name === "get_arcade_view_v1"
      ? { ...arcadeView(), deadline_at: new Date(Date.now() - 60_000).toISOString() }
      : { ok: true });
    const expired = await worker.fetch(new Request(url, { method: "POST", body: move }), late.testEnv, ctx);
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: "deadline_passed" } });
    expect(late.calls.map((call) => call.name)).not.toContain("save_arcade_draft_v1");
  });

  function firstLegalMove(): Move {
    const sequence = generatePieceSequence(hashSeed("secret-seed"));
    const state = createPlayerState();
    for (let pieceIndex = 0; pieceIndex < 3; pieceIndex += 1) {
      for (let row = 0; row < 9; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          const move: Move = { kind: "place", level: state.level, pieceIndex, rotation: 0, row, col };
          if (applyMove(state, sequence, move).ok) return move;
        }
      }
    }
    throw new Error("no legal opening move");
  }

  it("saves moves with compare-and-set and does not wake the room", async () => {
    const token = await issuePlayToken(SECRET, { sub: "a", game: "arcade", matchId: 7, exp: Date.now() + 60_000 });
    const { testEnv, calls, broadcasts } = fakeEnv((name) => name === "get_arcade_view_v1" ? arcadeView() : { ok: true });
    const response = await worker.fetch(new Request(`https://arcade.mallard.sh/api/v1/arcade/move?token=${encodeURIComponent(token)}`, {
      method: "POST", body: JSON.stringify(firstLegalMove()),
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    const save = calls.find((call) => call.name === "save_arcade_draft_v1");
    expect(save?.body.p_expected_moves).toBe(0);
    expect(save?.body.p_move_log).toHaveLength(1);
    const body = await response.json() as { value: { self: { pieces: unknown[] } } };
    expect(body.value.self.pieces).toHaveLength(3);
    expect(broadcasts).toHaveLength(0);
  });
});

describe("satscape browser movement", () => {
  it("mirrors the legacy town / encounter / fog rules", () => {
    expect(townAt(127, 111)).toBe("rest");
    expect(townAt(0, 0)).toBeNull();
    expect(revealTiles(10, 10)).toHaveLength(97);
    let chest: [number, number] | null = null;
    for (let x = 0; x < MAP_W && !chest; x += 1) {
      for (let y = 0; y < MAP_H && !chest; y += 1) if (isChestAt(x, y) && !townAt(x, y)) chest = [x, y];
    }
    expect(chest).not.toBeNull();
    expect(encounterAt(chest![0], chest![1], new Set())).toBe("chest");
    expect(encounterAt(chest![0], chest![1], new Set([`${chest![0]},${chest![1]}`]))).toBeNull();
  });

  function monsterStep(): { from: [number, number]; direction: string } {
    const steps: Array<[string, number, number]> = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];
    for (let x = 1; x < MAP_W - 1; x += 1) {
      for (let y = 1; y < MAP_H - 1; y += 1) {
        if (!canEnter(x, y, { ownsBoat: false }) || encounterAt(x, y, new Set())) continue;
        for (const [direction, dx, dy] of steps) {
          if (encounterAt(x + dx, y + dy, new Set()) === "monster") return { from: [x, y], direction };
        }
      }
    }
    throw new Error("no monster tile found");
  }

  it("refuses to walk onto an encounter or with no stamina, without committing", async () => {
    const { from, direction } = monsterStep();
    const token = await issuePlayToken(SECRET, { sub: "p", game: "satscape", exp: Date.now() + 60_000 });
    const url = `https://satscape.mallard.sh/api/v1/satscape/action?token=${encodeURIComponent(token)}`;
    const snapshot = (hunger: number) => ({
      player: { active: true, x_coord: from[0], y_coord: from[1], hunger, state: "idle", state_version: 4, last_move_at: null },
      inventory: [], cleared: [],
    });

    const blocked = fakeEnv((name) => name === "get_satscape_action_snapshot_v1" ? snapshot(50) : { ok: true });
    const encounter = await worker.fetch(new Request(url, { method: "POST", body: JSON.stringify({ direction }) }), blocked.testEnv, ctx);
    expect(encounter.status).toBe(409);
    await expect(encounter.json()).resolves.toMatchObject({ error: { code: "encounter" }, encounter: "monster" });
    expect(blocked.calls.map((call) => call.name)).not.toContain("commit_satscape_action_v1");
    vi.restoreAllMocks();

    const tired = fakeEnv((name) => name === "get_satscape_action_snapshot_v1" ? snapshot(0) : { ok: true });
    const exhausted = await worker.fetch(new Request(url, { method: "POST", body: JSON.stringify({ direction }) }), tired.testEnv, ctx);
    expect(exhausted.status).toBe(409);
    await expect(exhausted.json()).resolves.toMatchObject({ error: { code: "exhausted" } });
    expect(tired.calls.map((call) => call.name)).not.toContain("commit_satscape_action_v1");
  });
});

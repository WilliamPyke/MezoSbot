import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CHUNKS_DIR = join(__dirname, "..", "satscape", "world_gen", "chunks");
import { supabase } from "../db.js";
import { biomeAt, SAT } from "../satscape/engine.js";
import {
  MAX_PLAN,
  monstersTelegraph,
  parsePlan,
  planAP,
  projectedPlayerPos,
  readMonsters,
  selectedWeaponId,
  weaponFor,
  type BattleMove,
} from "../satscape/battle.js";
import {
  basePlayerAP,
  effectivePlayerAP,
  parseStatuses,
  playerKit,
  STATUS_META,
} from "../satscape/cards.js";
import { effectiveHp, getPlayer, loadView } from "../satscape/db.js";
import {
  battleMove,
  buyItem,
  eat,
  equipItem,
  estimateTravel,
  flee,
  moveMany,
  queueCard,
  queueWait,
  refillHp,
  resolvePlan,
  selectBattleWeapon,
  travelTo,
  undoPlanAction,
} from "../satscape/game.js";
import { acceptQuest, claimQuest, getRep, payTribute, questBoard } from "../satscape/quests.js";
import { ALL_ITEMS, effectivePrice, fastTravelRadius, TERRAIN_COLOR, townAt, TOWNS } from "../satscape/towns.js";
import { verifyPlayToken } from "../satscape/web_tokens.js";
import type { Direction, ViewModel } from "../satscape/types.js";

type Claim = ReturnType<typeof verifyPlayToken>;

async function loadExploredTiles(): Promise<Array<{ x: number; y: number }>> {
  const pageSize = 1000;
  const tiles: Array<{ x: number; y: number }> = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("sat_world_explored")
      .select("x, y")
      .order("x", { ascending: true })
      .order("y", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []).map((tile) => ({ x: tile.x, y: tile.y }));
    tiles.push(...page);
    if (page.length < pageSize) return tiles;
  }
}

let exploredTilesCache: { loadedAt: number; tiles: Array<{ x: number; y: number }> } | null = null;

async function loadExploredTilesCached(ttlMs = 5000): Promise<Array<{ x: number; y: number }>> {
  const now = Date.now();
  if (exploredTilesCache && now - exploredTilesCache.loadedAt < ttlMs) return exploredTilesCache.tiles;
  const tiles = await loadExploredTiles();
  exploredTilesCache = { loadedAt: now, tiles };
  return tiles;
}

export async function handleSatscapeWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const path = url.pathname;

  if (method === "GET" && path === "/satscape") {
    sendHtml(res, 200, PAGE_HTML);
    return true;
  }

  if (method === "GET" && path === "/satscape/chunks/world.json") {
    const filePath = join(__dirname, "..", "satscape", "world.json");
    try {
      const content = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.end(content);
    } catch (err) {
      sendJson(res, 404, { error: "Not found" });
    }
    return true;
  }

  if (method === "GET" && path.startsWith("/satscape/chunks/")) {
    const filename = path.slice("/satscape/chunks/".length);
    if (filename.includes("..") || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
      sendJson(res, 400, { error: "Invalid chunk filename" });
      return true;
    }
    const filePath = join(CHUNKS_DIR, filename);
    try {
      const content = await readFile(filePath);
      const isPng = filename.endsWith(".png");
      res.statusCode = 200;
      res.setHeader("Content-Type", isPng ? "image/png" : "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.end(content);
    } catch (err) {
      sendJson(res, 404, { error: "Not found" });
    }
    return true;
  }

  if (method === "GET" && path === "/satscape/play") {
    const claim = readClaim(req);
    if (!claim) {
      sendHtml(res, 401, INVALID_PLAY_HTML);
      return true;
    }
    sendHtml(res, 200, PLAY_HTML);
    return true;
  }

  if (method === "GET" && path === "/api/satscape/players") {
    await respondSpectatorPlayers(res);
    return true;
  }

  if (method === "GET" && path === "/satscape/api/state") {
    const full = url.searchParams.get("full") === "1";
    await respond(req, res, async (claim) => buildStateResponse(claim.userId, undefined, { lite: !full }));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/move") {
    await respondAction(req, res, async (claim, body) => {
      const dir = strField(body, "dir") as Direction;
      if (!["up", "down", "left", "right"].includes(dir)) return { ok: false, note: "Bad direction." };
      return moveMany(claim.userId, dir);
    });
    return true;
  }

  if (method === "POST" && path === "/satscape/api/battle") {
    await respondAction(req, res, async (claim, body) => {
      const action = strField(body, "action");
      if (action === "move") return battleMove(claim.userId, strField(body, "dir") as BattleMove);
      if (action === "card") return queueCard(claim.userId, strField(body, "cardId"));
      if (action === "wait") return queueWait(claim.userId);
      if (action === "undo") return undoPlanAction(claim.userId);
      if (action === "resolve") return resolvePlan(claim.userId);
      if (action === "flee") return flee(claim.userId);
      if (action === "weapon") return selectBattleWeapon(claim.userId, strField(body, "itemId"));
      return { ok: false, note: "Bad battle action." };
    });
    return true;
  }

  if (method === "POST" && path === "/satscape/api/eat") {
    await respondAction(req, res, (claim) => eat(claim.userId));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/refill-hp") {
    await respondAction(req, res, (claim, body) => refillHp(claim.userId, numField(body, "sats")));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/travel") {
    await respondWithBody(req, res, async (claim, body) => {
      const tx = numField(body, "tx");
      const ty = numField(body, "ty");
      const player = await getPlayer(claim.userId);
      if (!player) return { status: 400, body: { error: "Use /satscape join first." } };
      if (body.estimate === true) {
        return { status: 200, body: { ok: true, estimate: estimateTravel(player, tx, ty), state: await buildStateResponse(claim.userId) } };
      }
      const result = await travelTo(claim.userId, tx, ty);
      return { status: 200, body: { ...result, state: await buildStateResponse(claim.userId) } };
    });
    return true;
  }

  if (method === "POST" && path === "/satscape/api/shop/buy") {
    await respondAction(req, res, (claim, body) => buyItem(claim.userId, strField(body, "itemId")));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/shop/equip") {
    await respondAction(req, res, (claim, body) => equipItem(claim.userId, strField(body, "itemId")));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/quests/accept") {
    await respondAction(req, res, (claim, body) => acceptQuest(claim.userId, strField(body, "key")));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/quests/claim") {
    await respondAction(req, res, (claim, body) => claimQuest(claim.userId, strField(body, "key")));
    return true;
  }

  if (method === "POST" && path === "/satscape/api/quests/tribute") {
    await respondAction(req, res, (claim, body) => payTribute(claim.userId, strField(body, "key")));
    return true;
  }

  return false;
}

async function respondSpectatorPlayers(res: ServerResponse): Promise<void> {
  try {
    const { data: players, error } = await supabase
      .from("sat_players")
      .select("discord_id, x_coord, y_coord, hp, max_hp, state")
      .eq("active", true)
      .neq("state", "fainted");
    if (error) throw error;

      const explored = await loadExploredTilesCached();
    const ids = (players ?? []).map((p) => p.discord_id);
    const nameById = new Map<string, string>();
    const balanceById = new Map<string, number>();
    if (ids.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("discord_id, username, display_name, balance_sats")
        .in("discord_id", ids);
      for (const u of users ?? []) {
        nameById.set(u.discord_id, u.display_name || u.username || "Adventurer");
        balanceById.set(u.discord_id, u.balance_sats ?? 0);
      }
    }

    const payload = (players ?? []).map((p) => {
      const balance = balanceById.get(p.discord_id) ?? 0;
      const hp = effectiveHp({ hp: p.hp, max_hp: p.max_hp }, balance);
      const ref = Math.max(p.max_hp ?? SAT.HP_MAX_DEFAULT, 1);
      return {
        name: nameById.get(p.discord_id) ?? "Adventurer",
        x: p.x_coord,
        y: p.y_coord,
        biome: biomeAt(p.x_coord, p.y_coord),
        state: p.state,
        hpPct: Math.round(Math.max(0, Math.min(1, hp / ref)) * 100),
      };
    });

    sendJson(res, 200, {
      towns: TOWNS.map(publicTown),
      terrainColors: TERRAIN_COLOR,
      explored,
      players: payload,
    });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? "error" });
  }
}

async function buildStateResponse(userId: string, note?: string, opts?: { lite?: boolean }): Promise<Record<string, unknown>> {
  const view = await loadView(userId);
  if (!view || !view.player.active) return { error: "Use /satscape join first." };
  // The global explored-tiles list can be tens of thousands of tiles. Only ship it on
  // a "full" request (initial load / map open). Lite responses (the poll + every action)
  // omit it — the client grows its minimap incrementally from each viewport instead.
  const lite = !!opts?.lite;
  const worldExplored = lite ? null : await loadExploredTilesCached();
  return {
    ok: true,
    note,
    player: playerState(view),
    viewport: {
      bounds: {
        minX: view.player.x_coord - SAT.VIEW_OX,
        maxX: view.player.x_coord + (SAT.VIEW_W - 1 - SAT.VIEW_OX),
        minY: view.player.y_coord - SAT.VIEW_OY,
        maxY: view.player.y_coord + (SAT.VIEW_H - 1 - SAT.VIEW_OY),
      },
      terrainColors: TERRAIN_COLOR,
      towns: TOWNS.map(publicTown),
      explored: Array.from(view.explored).map((key) => {
        const [x, y] = key.split(",").map(Number);
        return { x, y };
      }),
      entities: view.entities,
      others: view.others,
    },
    minimap: {
      explored: worldExplored, // null on lite — client keeps its accumulated set
      towns: TOWNS.map(publicTown),
    },
    combat: combatState(view),
    inventory: inventoryState(view),
    town: await townState(userId, view),
  };
}

function playerState(view: ViewModel): Record<string, unknown> {
  return {
    x: view.player.x_coord,
    y: view.player.y_coord,
    hp: view.hp,
    maxHp: view.maxHp,
    balance: view.balance,
    stamina: view.player.hunger,
    state: view.player.state,
    stepsPerMove: view.player.steps_per_move,
    travelRadius: fastTravelRadius(view.player),
    equipped: {
      weapon: view.player.equipped_weapon,
      armor: view.player.equipped_armor,
      accessory: view.player.equipped_accessory,
      boots: view.player.equipped_boots,
    },
  };
}

function combatState(view: ViewModel): Record<string, unknown> | null {
  const combat = view.combat;
  if (!combat) return null;
  const plan = parsePlan(combat.battle_plan);
  const weapon = weaponFor(view.player, selectedWeaponId(combat, view.player));
  const playerStatus = parseStatuses(combat.player_status);
  const maxAp = basePlayerAP(view.player);
  const availableAp = effectivePlayerAP(view.player, playerStatus);
  const spentAp = planAP(plan);
  const kit = playerKit(view.player).map((c) => ({
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    apCost: c.apCost,
    kind: c.kind,
    shape: c.shape ?? null,
    desc: c.desc,
    affordable: c.apCost <= availableAp - spentAp,
  }));
  const telegraph = monstersTelegraph(combat);
  const roster = readMonsters(combat);
  // Full monster roster, each with its own telegraph + status badges (drives the
  // chess-like board). Dead monsters drop out of the telegraph but stay listed so
  // the client can fade them out.
  const monsters = roster.map((mm) => {
    const tele = telegraph.find((t) => t.monster.id === mm.id);
    return {
      id: mm.id,
      name: mm.name,
      level: mm.level,
      hp: mm.hp,
      maxHp: mm.maxHp,
      attack: mm.attack,
      reward: mm.reward,
      x: mm.x,
      y: mm.y,
      dead: mm.hp <= 0,
      intents: tele ? tele.intents : [],
      status: statusBadges(mm.status),
    };
  });
  const primaryMon = roster[0];
  return {
    monster: {
      name: primaryMon ? primaryMon.name : combat.monster_name,
      level: primaryMon ? primaryMon.level : combat.monster_level,
      hp: primaryMon ? primaryMon.hp : combat.monster_current_hp,
      maxHp: primaryMon ? primaryMon.maxHp : combat.monster_max_hp,
      attack: primaryMon ? primaryMon.attack : combat.monster_attack,
      reward: combat.reward_sats,
      x: primaryMon ? primaryMon.x : combat.monster_battle_x,
      y: primaryMon ? primaryMon.y : combat.monster_battle_y,
    },
    monsters,
    player: { x: combat.player_battle_x, y: combat.player_battle_y },
    turn: combat.turn_number,
    plan,
    projected: projectedPlayerPos(combat, plan),
    intents: telegraph.length ? telegraph[0].intents : [],
    kit,
    ap: { max: maxAp, available: availableAp, spent: spentAp, ticks: plan.length, maxTicks: MAX_PLAN },
    playerStatus: statusBadges(playerStatus),
    monsterStatus: statusBadges(parseStatuses(combat.monster_status)),
    weapon,
    selectedWeaponId: selectedWeaponId(combat, view.player),
  };
}

/** Compact status descriptors for the UI badges. */
function statusBadges(list: ReturnType<typeof parseStatuses>): Array<{ kind: string; emoji: string; label: string; amount: number; turns: number }> {
  return list.map((s) => ({ kind: s.kind, emoji: STATUS_META[s.kind].emoji, label: STATUS_META[s.kind].label, amount: s.amount, turns: s.turns }));
}

function inventoryState(view: ViewModel): Record<string, unknown> {
  const equipped = new Set([
    view.player.equipped_weapon,
    view.player.equipped_armor,
    view.player.equipped_accessory,
    view.player.equipped_boots,
  ].filter(Boolean));
  return {
    ownedItemIds: view.ownedItemIds,
    items: ALL_ITEMS.filter((item) => view.ownedItemIds.includes(item.id)).map((item) => ({
      id: item.id,
      name: item.name,
      slot: item.slot,
      power: item.power,
      emoji: item.emoji,
      stepBonus: item.stepBonus ?? 0,
      equipped: equipped.has(item.id),
    })),
  };
}

async function townState(userId: string, view: ViewModel): Promise<Record<string, unknown> | null> {
  const town = townAt(view.player.x_coord, view.player.y_coord);
  if (!town) return null;
  const [rep, quests] = await Promise.all([getRep(userId, town.id), questBoard(userId, town.id)]);
  const equipped = new Set([
    view.player.equipped_weapon,
    view.player.equipped_armor,
    view.player.equipped_accessory,
    view.player.equipped_boots,
  ].filter(Boolean));
  return {
    id: town.id,
    name: town.name,
    keeper: town.keeper,
    rep,
    catalog: town.catalog.map((item) => ({
      id: item.id,
      name: item.name,
      slot: item.slot,
      power: item.power,
      emoji: item.emoji,
      stepBonus: item.stepBonus ?? 0,
      price: effectivePrice(item, town.keeper, rep),
      repReq: item.repReq ?? 0,
      locked: !!item.repReq && rep < item.repReq,
      owned: view.ownedItemIds.includes(item.id),
      equipped: equipped.has(item.id),
    })),
    quests,
  };
}

function publicTown(t: (typeof TOWNS)[number]) {
  return { id: t.id, name: t.name, cx: t.cx, cy: t.cy, safeRadius: t.safeRadius, palette: t.palette };
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (claim: NonNullable<Claim>) => Promise<unknown>,
): Promise<void> {
  const claim = readClaim(req);
  if (!claim) return sendJson(res, 401, { error: "Invalid or expired token" });
  try {
    const out = await handler(claim);
    if (out && typeof out === "object" && "error" in out) return sendJson(res, 400, out);
    sendJson(res, 200, out);
  } catch (err) {
    console.error("[SatscapeWeb] handler error:", (err as Error)?.message ?? err);
    sendJson(res, 500, { error: "Internal error" });
  }
}

async function respondAction(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (claim: NonNullable<Claim>, body: Record<string, unknown>) => Promise<{ ok: boolean; note: string }>,
): Promise<void> {
  await respondWithBody(req, res, async (claim, body) => {
    const result = await handler(claim, body);
    // Action responses are always lite — the client grows its minimap from the viewport.
    return { status: 200, body: { ...result, state: await buildStateResponse(claim.userId, result.note, { lite: true }) } };
  });
}

async function respondWithBody(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (
    claim: NonNullable<Claim>,
    body: Record<string, unknown>,
  ) => Promise<{ status: number; body: unknown }>,
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
    console.error("[SatscapeWeb] handler error:", (err as Error)?.message ?? err);
    sendJson(res, 500, { error: "Internal error" });
  }
}

function readClaim(req: IncomingMessage): NonNullable<Claim> | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const fromQuery = url.searchParams.get("t");
  const fromHeader = req.headers["x-satscape-token"];
  const token = (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) || fromQuery || null;
  return verifyPlayToken(token);
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
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Bad field: ${key}`);
  return Math.trunc(v);
}

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v) throw new Error(`Bad field: ${key}`);
  return v;
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

const INVALID_PLAY_HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SatScape</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10151c;color:#edf2f7;font-family:Inter,Segoe UI,Arial,sans-serif}main{max-width:520px;padding:24px}p{color:#a8b3c2}</style></head>
<body><main><h1>Open SatScape from Discord</h1><p>This browser link is missing or has an expired token. Run /satscape map in Discord and open the fresh play button.</p></main></body></html>`;

const PLAY_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SatScape · Adventurer's Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Spectral:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --ink:#0a0e13; --ink-2:#0d131b;
    --panel-a:#151e28; --panel-b:#0e151d;
    --line:#2c3a47; --line-soft:#1b2630;
    --gold:#e8c15a; --gold-deep:#b8861f; --gold-soft:#f6e3a6;
    --parchment:#ece0c4;
    --text:#e7e0cf; --muted:#9a917c;
    --emerald:#5ee08a; --crimson:#fb7185; --cyan:#38d6ee;
    --shadow:0 12px 34px rgba(0,0,0,.55);
    --r:12px;
    --display:'Cinzel','Trajan Pro',Georgia,serif;
    --body:'Spectral','Iowan Old Style',Georgia,serif;
  }
  * { box-sizing:border-box; }
  html, body { min-height:100%; }
  body {
    margin:0; color:var(--text); font-family:var(--body); -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(1100px 560px at 50% -12%, rgba(232,193,90,.12), transparent 60%),
      radial-gradient(900px 520px at 50% 118%, rgba(56,214,238,.06), transparent 60%),
      linear-gradient(180deg,#0a0e13,#080b10 55%,#06080c);
    background-attachment:fixed;
  }
  /* film grain + torch vignette */
  body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; opacity:.045; mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
  body::after { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; box-shadow:inset 0 0 220px 50px rgba(0,0,0,.72); }
  button, input, select { font:inherit; }
  button {
    font-family:var(--display); letter-spacing:1px; text-transform:uppercase; font-size:11px; font-weight:600;
    color:var(--gold-soft); border:1px solid var(--line); border-radius:8px; padding:9px 10px; cursor:pointer;
    background:linear-gradient(180deg,#1e2a35,#141c25);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.05), 0 2px 7px rgba(0,0,0,.45);
    transition:transform .08s ease, border-color .15s, box-shadow .18s, color .15s, background .15s;
  }
  button:hover { border-color:var(--gold-deep); color:#fff8e6; box-shadow:0 0 16px rgba(232,193,90,.28), 0 3px 9px rgba(0,0,0,.5); }
  button:active { transform:translateY(1px); }
  button:disabled { opacity:.38; cursor:not-allowed; filter:grayscale(.5); box-shadow:none; }
  button.primary { background:linear-gradient(180deg,#1f7a45,#0e5631); border-color:#2fbf6b; color:#eafff1; text-shadow:0 1px 0 rgba(0,0,0,.4); }
  button.primary:hover { box-shadow:0 0 18px rgba(94,224,138,.5); border-color:#5ee08a; }
  button.danger { background:linear-gradient(180deg,#7a2230,#4d1521); border-color:#fb7185; color:#ffe4e9; }
  button.danger:hover { box-shadow:0 0 16px rgba(251,113,133,.45); }
  input, select {
    width:100%; font-family:var(--body); border:1px solid var(--line); background:#0b1219; color:var(--text);
    border-radius:8px; padding:8px 9px; transition:border-color .15s, box-shadow .15s;
  }
  input:focus, select:focus { outline:none; border-color:var(--gold-deep); box-shadow:0 0 0 3px rgba(232,193,90,.13); }
  ::-webkit-scrollbar { width:9px; height:9px; }
  ::-webkit-scrollbar-thumb { background:#2a3744; border-radius:9px; border:2px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:#3c4d5e; }

  .app { position:relative; z-index:1; display:grid; grid-template-columns:minmax(380px,1fr) 360px; justify-content:center; max-width:1120px; margin:0 auto; gap:14px; min-height:100dvh; padding:16px; }
  .stage, .side { min-width:0; }

  .top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
  .brand { display:flex; align-items:center; gap:11px; }
  .sigil { width:38px; height:38px; flex:none; display:grid; place-items:center; border-radius:50%; font-family:var(--display); font-weight:700; font-size:19px; color:#3a2a08;
    background:radial-gradient(circle at 34% 28%, #fbe8a8, #d6a32a 46%, #6b4a12); box-shadow:0 0 0 1px rgba(232,193,90,.55), 0 0 18px rgba(232,193,90,.38), inset 0 -3px 6px rgba(0,0,0,.35); }
  h1 { margin:0; font-family:var(--display); font-weight:700; font-size:23px; letter-spacing:4px; color:var(--parchment); text-shadow:0 1px 0 #000, 0 0 22px rgba(232,193,90,.28); }
  .tagline { font-family:var(--body); font-style:italic; font-size:11.5px; letter-spacing:.5px; color:var(--muted); margin-top:1px; }
  .coords { font-family:var(--body); font-size:12.5px; color:var(--parchment); background:linear-gradient(180deg,#1a2330,#10171f); border:1px solid var(--gold-deep); border-radius:999px; padding:7px 13px; white-space:nowrap; box-shadow:0 0 16px rgba(232,193,90,.12), inset 0 1px 0 rgba(255,255,255,.05); }

  .bars { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px; }
  .bar { position:relative; border:1px solid var(--line); border-radius:10px; padding:9px 12px; background:linear-gradient(180deg,#141d27,#0d141c); box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.04); }
  .bar label { display:flex; justify-content:space-between; font-family:var(--display); letter-spacing:1.5px; text-transform:uppercase; font-size:10px; color:var(--muted); margin-bottom:7px; }
  .bar label span:last-child { color:var(--parchment); letter-spacing:.5px; }
  .fill { height:12px; border-radius:999px; background:#0a1118; overflow:hidden; box-shadow:inset 0 1px 3px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,255,255,.03); }
  .fill span { position:relative; display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#2f9d5b,#5ee08a); box-shadow:0 0 12px rgba(94,224,138,.5); transition:width .4s cubic-bezier(.4,0,.2,1); }
  .fill.hp span { background:linear-gradient(90deg,#7a1f2e,#fb7185); box-shadow:0 0 12px rgba(251,113,133,.5); }
  .fill span::after { content:""; position:absolute; inset:0; background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent); transform:translateX(-110%); animation:shimmer 2.8s linear infinite; }
  @keyframes shimmer { to { transform:translateX(110%); } }

  .map-frame { position:relative; padding:10px; border-radius:14px; border:1px solid var(--gold-deep);
    background:linear-gradient(180deg,#1a232d,#0b121a); box-shadow:var(--shadow), inset 0 0 0 1px rgba(232,193,90,.16), inset 0 0 70px rgba(0,0,0,.6); }
  canvas#play { width:100%; max-height:calc(100dvh - 168px); display:block; background:#070b10; border:1px solid var(--line-soft); border-radius:8px; image-rendering:pixelated; touch-action:none; aspect-ratio:1/1; }
  #minimap { width:100%; height:120px; display:block; background:#070b10; border:1px solid var(--line-soft); border-radius:8px; image-rendering:pixelated; }

  .side { display:flex; flex-direction:column; gap:12px; max-height:calc(100dvh - 20px); overflow:auto; padding-right:2px; }
  .panel { position:relative; background:linear-gradient(180deg,var(--panel-a),var(--panel-b)); border:1px solid var(--line); border-radius:var(--r); padding:12px; box-shadow:var(--shadow); animation:rise .5s both; }
  .panel::before { content:""; position:absolute; left:12px; right:12px; top:0; height:1px; background:linear-gradient(90deg,transparent,var(--gold-deep),transparent); opacity:.55; }
  .panel:nth-child(1){animation-delay:.04s} .panel:nth-child(2){animation-delay:.09s} .panel:nth-child(3){animation-delay:.14s}
  .panel:nth-child(4){animation-delay:.19s} .panel:nth-child(5){animation-delay:.24s} .panel:nth-child(6){animation-delay:.29s} .panel:nth-child(7){animation-delay:.34s}
  @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
  .panel h2 { margin:0 0 9px; font-family:var(--display); font-weight:600; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:var(--gold-soft); display:flex; align-items:center; gap:8px; }
  .panel h2::before { content:""; width:6px; height:6px; transform:rotate(45deg); background:var(--gold); box-shadow:0 0 9px var(--gold); }

  .grid4 { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
  .grid4 button { padding:12px 0; }
  .grid4 .up { grid-column:2; } .grid4 .left { grid-column:1; } .grid4 .down { grid-column:2; } .grid4 .right { grid-column:3; }
  .row { display:flex; gap:6px; align-items:center; }
  .row > * { flex:1; }

  #battleControls { border-color:var(--gold-deep); box-shadow:var(--shadow), 0 0 0 1px rgba(232,193,90,.12), 0 0 46px rgba(232,193,90,.06); }
  #battleControls h2 { color:#ffe9b0; }
  #apText { font-family:var(--display); letter-spacing:1px; font-size:12px; color:var(--gold-soft); text-shadow:0 0 10px rgba(232,193,90,.3); }
  #cardTray { display:flex; flex-wrap:wrap; gap:7px; }
  #cardTray button { flex:1 1 calc(50% - 4px); min-width:118px; text-align:left; text-transform:none; letter-spacing:.2px; font-family:var(--body); font-size:13px; font-weight:500; padding:10px 11px; border-radius:10px; border-color:#3b6f95; color:#d6ecff; background:linear-gradient(160deg,#15212e,#0e1822); }
  #cardTray button:hover { transform:translateY(-2px); box-shadow:0 0 16px rgba(59,125,168,.3), 0 4px 10px rgba(0,0,0,.5); }
  #cardTray button.primary { border-color:var(--gold-deep); color:var(--gold-soft); background:linear-gradient(160deg,#241c10,#15110a); text-shadow:none; }
  #cardTray button.primary:hover { box-shadow:0 0 16px rgba(232,193,90,.32), 0 4px 10px rgba(0,0,0,.5); }
  #statusRow { font-family:var(--body); font-size:12px; color:var(--muted); display:grid; gap:3px; }

  .tabs { display:flex; gap:6px; }
  .tabs button { flex:1; }
  .tabs button.active { border-color:var(--gold); color:var(--gold-soft); background:linear-gradient(180deg,#241c10,#15110a); box-shadow:0 0 13px rgba(232,193,90,.2); }
  .list { display:flex; flex-direction:column; max-height:172px; overflow:auto; }
  .item { display:grid; grid-template-columns:1fr auto; gap:10px; align-items:center; border-top:1px solid var(--line-soft); padding:8px 2px; font-size:13px; font-family:var(--body); }
  .item:first-child { border-top:0; }
  .item button { padding:6px 11px; }

  .muted { color:var(--muted); font-size:12px; font-family:var(--body); }
  .note { font-family:var(--body); font-style:italic; color:var(--parchment); white-space:pre-wrap; font-size:13.5px; line-height:1.5; min-height:42px; max-height:98px; overflow:auto; border-left:3px solid var(--gold-deep); padding-left:11px; background:linear-gradient(90deg,rgba(232,193,90,.05),transparent); }
  .turn-track { display:grid; gap:6px; margin-top:8px; }
  .turn-step { border:1px solid var(--line-soft); border-left:3px solid var(--line); border-radius:8px; padding:7px 9px; background:#0d141c; font-size:12px; font-family:var(--body); }
  .turn-step.attack { border-left-color:var(--crimson); color:#fecdd3; background:linear-gradient(90deg,rgba(251,113,133,.09),transparent); }
  .turn-step.advance { border-left-color:var(--gold); color:#fde68a; }
  .turn-step.rest { border-left-color:#475569; color:#cbd5e1; }
  .turn-slot { display:inline-flex; align-items:center; justify-content:center; min-width:46px; height:32px; margin:0 5px 5px 0; border:1px solid var(--line); border-radius:8px; background:#0d141c; font-size:12px; font-family:var(--body); color:var(--muted); }
  .turn-slot.filled { border-color:var(--gold); color:var(--gold-soft); box-shadow:0 0 11px rgba(232,193,90,.22); }
  .log-label { font-family:var(--display); font-size:10px; letter-spacing:2px; text-transform:uppercase; color:var(--muted); margin-top:11px; }
  #battleLog { margin-top:5px; max-height:132px; overflow:auto; font-family:var(--body); font-size:12px; line-height:1.6; border:1px solid var(--line-soft); border-radius:8px; padding:8px 10px; background:linear-gradient(180deg,#0a0f15,#0c1219); box-shadow:inset 0 0 22px rgba(0,0,0,.55); }
  .toggle { display:flex; align-items:center; gap:8px; margin-top:8px; color:var(--muted); font-size:12px; font-family:var(--body); }
  .toggle input { width:auto; }

  @media (max-width: 860px) { .app { grid-template-columns:1fr; } .side { max-height:none; overflow:visible; } canvas#play { max-height:none; } }
  @media (prefers-reduced-motion: reduce) { .panel { animation:none; } .fill span::after { animation:none; } }
</style>
</head>
<body>
<main class="app">
  <section class="stage">
    <div class="top">
      <div class="brand"><span class="sigil">₿</span><div><h1>SATSCAPE</h1><div class="tagline">Adventurer's Ledger</div></div></div>
      <div class="coords" id="coords">loading</div>
    </div>
    <div class="bars">
      <div class="bar"><label><span>HP</span><span id="hpText">0/0</span></label><div class="fill hp"><span id="hpFill"></span></div></div>
      <div class="bar"><label><span>Stamina</span><span id="stText">0%</span></label><div class="fill"><span id="stFill"></span></div></div>
    </div>
    <div class="map-frame"><canvas id="play" width="512" height="512"></canvas></div>
  </section>
  <aside class="side">
    <div class="panel note" id="note">Opening SatScape...</div>
    <div class="panel"><canvas id="minimap" width="320" height="118"></canvas></div>
    <div class="panel">
      <h2>Move</h2>
      <div class="grid4">
        <button class="up" data-move="up" title="Move north">Up</button>
        <button class="left" data-move="left" title="Move west">Left</button>
        <button class="down" data-move="down" title="Move south">Down</button>
        <button class="right" data-move="right" title="Move east">Right</button>
      </div>
      <div class="row" style="margin-top:8px"><button id="eat">Eat</button><button id="refresh">Refresh</button></div>
    </div>
    <div class="panel">
      <h2>HP Refill</h2>
      <div class="row"><input id="hpInput" type="number" min="0" step="1"><button id="refill" class="primary">Refill</button></div>
      <div class="muted" id="bankText"></div>
    </div>
    <div class="panel" id="battleControls">
      <h2>Battle</h2>
      <div class="muted" id="apText" style="margin-bottom:6px"></div>
      <div id="cardTray" style="display:flex;flex-wrap:wrap;gap:6px"></div>
      <div class="row" style="margin-top:6px"><button data-bmove="up" title="Queue north (1 AP)">Up</button><button data-bmove="down" title="Queue south (1 AP)">Down</button><button data-bmove="left" title="Queue west (1 AP)">Left</button><button data-bmove="right" title="Queue east (1 AP)">Right</button></div>
      <div class="row" style="margin-top:6px"><select id="weapon"></select><button id="weaponBtn">Ready</button></div>
      <div class="row" style="margin-top:6px"><button id="wait">Wait</button><button id="undo">Undo</button><button id="resolve" class="primary">Resolve</button><button id="flee" class="danger">Flee</button></div>
      <div id="statusRow" style="margin-top:7px;font-size:12px"></div>
      <div class="muted" id="battleTurnText" style="margin-top:7px"></div>
      <div id="battlePlan" style="margin-top:6px"></div>
      <div class="turn-track" id="monsterPlan"></div>
      <div class="log-label">Battle Log</div>
      <div id="battleLog"></div>
    </div>
    <div class="panel">
      <h2>Travel</h2>
      <div class="row"><input id="tx" type="number" placeholder="x"><input id="ty" type="number" placeholder="y"></div>
      <label class="toggle"><input id="clickTravel" type="checkbox"> Click map to fast travel</label>
      <div class="row" style="margin-top:6px"><button id="estimate">Estimate</button><button id="travel" class="primary">Travel</button></div>
      <div class="muted" id="travelText"></div>
    </div>
    <div class="panel">
      <div class="tabs"><button id="tabShop">Shop</button><button id="tabQuests">Quests</button><button id="tabGear">Gear</button></div>
      <div class="list" id="list" style="margin-top:10px"></div>
    </div>
  </aside>
</main>
<script>
(function(){
  var token = new URLSearchParams(location.search).get("t") || localStorage.getItem("satscapeToken") || "";
  if (token) localStorage.setItem("satscapeToken", token);
  var state = null, activeTab = location.hash === "#quests" ? "quests" : location.hash === "#shop" ? "shop" : "gear";
  var clickTravel = false, showWorldMap = false, battleAnimStart = performance.now(), lastCombatKey = "";
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var inflight = 0;   // battle POSTs in flight — pause the poll so it can't clobber optimistic state
  var playing = false; // a resolution playback animation is running
  var pb = null;       // playback driver state
  var play = document.getElementById("play"), ctx = play.getContext("2d");
  var minimap = document.getElementById("minimap"), mini = minimap.getContext("2d");
  var note = document.getElementById("note");
  var chunkCache = {};
  var biomeGrid = null;
  fetch("/satscape/chunks/world.json")
    .then(function(r){ return r.json(); })
    .then(function(data){
      var binary = atob(data.biome);
      var bytes = new Uint8Array(binary.length);
      for(var i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
      biomeGrid = bytes;
      if (typeof render === "function") render();
      else if (typeof draw === "function") draw();
    }).catch(function(e){ console.error("Failed to load biomeGrid:", e); });
  var WORLD_ART = { tile: 18, chunkTiles: 32, cols: 12, rows: 11, worldTilesX: 380, worldTilesY: 335 };
  function getChunkImage(col, row) {
    var key = col + "," + row;
    if (chunkCache[key]) {
      return chunkCache[key].loaded ? chunkCache[key].img : null;
    }
    var img = new Image();
    chunkCache[key] = { img: img, loaded: false };
    img.onload = function() {
      chunkCache[key].loaded = true;
      render();
    };
    img.src = "/satscape/chunks/chunk_" + col + "_" + row + ".png";
    return null;
  }
  function inSight(x, y) {
    var dx = x - state.player.x;
    var dy = y - state.player.y;
    return dx * dx + dy * dy <= 30;
  }
  function api(path, body) {
    return fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type":"application/json", "X-Satscape-Token": token }, body: body ? JSON.stringify(body) : undefined })
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || "Request failed"); return j; }); });
  }
  // Minimap tiles accumulate client-side: a "full" payload seeds them; every (lite)
  // payload merges in the current viewport, so the minimap stays fresh without the
  // server shipping the whole world's explored set each time.
  var minimapTiles = [], minimapSeen = {};
  function ingestMinimap(st){
    if(!st) return;
    var mm = st.minimap;
    if(mm && Array.isArray(mm.explored)){
      minimapTiles = mm.explored.slice(); minimapSeen = {};
      for(var i=0;i<minimapTiles.length;i++) minimapSeen[minimapTiles[i].x+","+minimapTiles[i].y]=1;
    }
    var vp = (st.viewport && st.viewport.explored) || [];
    for(var j=0;j<vp.length;j++){ var t=vp[j], k=t.x+","+t.y; if(!minimapSeen[k]){ minimapSeen[k]=1; minimapTiles.push({x:t.x,y:t.y}); } }
    if(!st.minimap) st.minimap = {};
    st.minimap.explored = minimapTiles;
  }
  var hadCombat = false;
  function setState(s) {
    state = s.state || s;
    ingestMinimap(state);
    var nowCombat = !!(state && state.combat);
    if(nowCombat && !hadCombat) clearBattleLog(); // fresh fight — start a clean log
    hadCombat = nowCombat;
    var combatKey = state && state.combat ? state.combat.turn + ":" + state.combat.monster.hp + ":" + (state.combat.plan || []).length : "";
    if (combatKey !== lastCombatKey) { battleAnimStart = performance.now(); lastCombatKey = combatKey; }
    if (s.estimate) {
      document.getElementById("travelText").textContent = s.estimate.steps + " steps, " + s.estimate.breadNeeded + " bread, " + s.estimate.satCost + " sats.";
    }
    if (s.note) note.textContent = s.note; else if (state.note) note.textContent = state.note;
    render();
  }
  function act(path, body) { api(path, body).then(setState).catch(function(e){ note.textContent = e.message; }); }

  /* ─── combat: client mirrors of the server rules (for instant, optimistic input) ─── */
  function clampA(n){ return Math.max(0, Math.min(7, Math.round(n))); }
  function livingMonsters(c){ return (c.monsters || (c.monster ? [c.monster] : [])).filter(function(m){ return !m.dead && m.hp > 0; }); }
  function nearestMonster(c, from){
    var ms = livingMonsters(c), best = null, bd = Infinity;
    for(var i=0;i<ms.length;i++){ var d = Math.abs(ms[i].x-from.x)+Math.abs(ms[i].y-from.y); if(d<bd){ bd=d; best=ms[i]; } }
    return best;
  }
  // Mirror of battle.ts projectedPlayerPos: walk the move plan, blocked by any living monster.
  function projectClient(c, plan){
    var pos = { x:c.player.x, y:c.player.y };
    var DELTA = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
    var blockers = livingMonsters(c);
    for(var i=0;i<plan.length;i++){
      var a = plan[i]; if(a.kind !== "move") continue;
      var d = DELTA[a.dir]; if(!d) continue;
      var next = { x:clampA(pos.x+d.x), y:clampA(pos.y+d.y) };
      var blocked = false; for(var j=0;j<blockers.length;j++){ if(blockers[j].x===next.x && blockers[j].y===next.y){ blocked=true; break; } }
      if(!blocked) pos = next;
    }
    return pos;
  }
  function attackDirJS(from, to){
    var dx = to.x-from.x, dy = to.y-from.y;
    if(Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
    return dy > 0 ? "down" : "up";
  }
  // Mirror of battle.ts attackTilesForShape (geometry only) — for the on-board preview.
  function attackTilesJS(from, target, shape){
    var dir = attackDirJS(from, target);
    var DELTA = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
    var d = DELTA[dir];
    var lateral = (dir === "up" || dir === "down") ? {x:1,y:0} : {x:0,y:1};
    function f(n){ return { x:from.x+d.x*n, y:from.y+d.y*n }; }
    var raw = [];
    if(shape === "longsword"){ raw.push(f(1), f(2)); }
    else if(shape === "spear"){ raw.push(f(1), f(2), f(3)); }
    else if(shape === "hammer"){ var a=f(1); raw.push(a, {x:a.x+lateral.x,y:a.y+lateral.y}, f(2), {x:a.x+lateral.x+d.x,y:a.y+lateral.y+d.y}); }
    else if(shape === "cleave" || shape === "arc"){ var cc=f(1); raw.push(cc, {x:cc.x+lateral.x,y:cc.y+lateral.y}, {x:cc.x-lateral.x,y:cc.y-lateral.y}); }
    else if(shape === "star"){ raw.push({x:from.x-1,y:from.y-1},{x:from.x+1,y:from.y-1},{x:from.x-1,y:from.y+1},{x:from.x+1,y:from.y+1}, f(2)); }
    else if(shape === "slam"){ for(var yy=from.y-1;yy<=from.y+1;yy++) for(var xx=from.x-1;xx<=from.x+1;xx++) if(xx!==from.x||yy!==from.y) raw.push({x:xx,y:yy}); }
    else if(shape === "bolt"){ for(var i=1;i<8;i++) raw.push(f(i)); }
    else if(shape === "nova"){ for(var y2=from.y-2;y2<=from.y+2;y2++) for(var x2=from.x-2;x2<=from.x+2;x2++) if(x2!==from.x||y2!==from.y) raw.push({x:x2,y:y2}); }
    else { raw.push(f(1), f(2), f(3)); } // line / default
    var out = [], seen = {};
    for(var k=0;k<raw.length;k++){ var p=raw[k]; if(p.x<0||p.x>7||p.y<0||p.y>7) continue; var key=p.x+","+p.y; if(seen[key]) continue; seen[key]=1; out.push(p); }
    return out;
  }
  function kitCard(c, id){ var k = c.kit || []; for(var i=0;i<k.length;i++) if(k[i].id===id) return k[i]; return null; }
  function actionCost(c, a){ if(!a) return 0; if(a.kind==="move") return 1; if(a.kind==="wait") return 0; var card=kitCard(c,a.cardId); return card ? card.apCost : 0; }
  function recomputeAffordable(c){
    var ap = c.ap || {available:3, spent:0}; var remain = ap.available - ap.spent;
    (c.kit||[]).forEach(function(card){ card.affordable = card.apCost <= remain; });
  }
  // Apply a queued action locally so the board + plan update instantly, before the POST returns.
  function queueOptimistic(c, action){
    var ap = c.ap || {available:3, spent:0, ticks:0, maxTicks:3};
    if(ap.ticks >= ap.maxTicks) return false;
    var cost = actionCost(c, action);
    if(ap.spent + cost > ap.available) return false;
    if(action.kind === "move"){
      var before = projectClient(c, c.plan);
      var after = projectClient(c, c.plan.concat([action]));
      if(before.x===after.x && before.y===after.y) return false; // blocked step
    }
    c.plan = (c.plan||[]).concat([action]);
    c.ap = { max:ap.max, available:ap.available, spent:ap.spent+cost, ticks:ap.ticks+1, maxTicks:ap.maxTicks };
    c.projected = projectClient(c, c.plan);
    recomputeAffordable(c);
    return true;
  }
  function undoOptimistic(c){
    if(!c.plan || !c.plan.length) return false;
    var popped = c.plan.pop();
    var cost = actionCost(c, popped), ap = c.ap;
    c.ap = { max:ap.max, available:ap.available, spent:Math.max(0,ap.spent-cost), ticks:Math.max(0,ap.ticks-1), maxTicks:ap.maxTicks };
    c.projected = projectClient(c, c.plan);
    recomputeAffordable(c);
    return true;
  }
  // Queue a battle action: reflect it instantly, then POST and reconcile with the authoritative state.
  function battleQueue(action, body){
    if(playing) return;
    var c = state && state.combat;
    if(c){ if(!queueOptimistic(c, action)){ /* server will explain */ } render(); }
    inflight++;
    api("/satscape/api/battle", body).then(function(s){ inflight--; setState(s); }).catch(function(e){
      inflight--; note.textContent = e.message; api("/satscape/api/state").then(setState).catch(function(){});
    });
  }
  function battleUndo(){
    if(playing) return;
    var c = state && state.combat;
    if(c && c.plan && c.plan.length){ undoOptimistic(c); render(); }
    inflight++;
    api("/satscape/api/battle", { action:"undo" }).then(function(s){ inflight--; setState(s); }).catch(function(e){
      inflight--; note.textContent = e.message; api("/satscape/api/state").then(setState).catch(function(){});
    });
  }
  // Resolve, then animate the round step-by-step before applying the final state.
  function resolveBattle(){
    if(playing) return;
    inflight++;
    api("/satscape/api/battle", { action:"resolve" }).then(function(s){
      inflight--;
      if(s.playback && s.playback.steps && s.playback.steps.length && !reduceMotion && !showWorldMap){
        startPlayback(s.playback, function(){ setState(s); });
      } else { setState(s); }
    }).catch(function(e){ inflight--; note.textContent = e.message; });
  }
  // Persistent battle log ("the stack") — accumulates across the fight, capped.
  function logEvent(text, cls){
    var el = document.getElementById("battleLog"); if(!el || !text) return;
    var d = document.createElement("div"); if(cls) d.className = cls;
    if(cls === "log-turn"){ d.style.color = "#94a3b8"; d.style.margin = "4px 0 2px"; d.style.fontWeight = "700"; }
    else if(/hit you|took|🩸/.test(text)) d.style.color = "#fca5a5";
    else if(/hit|dealt|defeat|🗡️|🏆/.test(text)) d.style.color = "#86efac";
    d.textContent = text;
    el.appendChild(d);
    while(el.childNodes.length > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function clearBattleLog(){ var el = document.getElementById("battleLog"); if(el) el.innerHTML = ""; }
  function startPlayback(data, done){
    var c = state.combat; if(!c){ done(); return; }
    var prevMons = {}; (c.monsters || [c.monster]).forEach(function(m){ if(m) prevMons[m.id || "m0"] = { x:m.x, y:m.y, hp:m.hp, maxHp:m.maxHp, name:m.name }; });
    logEvent("— Turn " + c.turn + " —", "log-turn");
    pb = {
      steps: data.steps, idx: 0, start: performance.now(), stepMs: 620, shownIdx: -1,
      prevPlayer: { x:c.player.x, y:c.player.y }, prevMons: prevMons, done: done,
    };
    playing = true;
  }
  function key(x,y){ return x + "," + y; }
  function exploredSet(){ var out={}; (state.viewport.explored||[]).forEach(function(t){ out[key(t.x,t.y)] = true; }); return out; }
  function biomeAt(x, y){
    var towns = (state && state.viewport && state.viewport.towns) || [];
    var best = null, bd = Infinity;
    towns.forEach(function(t){ var d = Math.hypot(x - t.cx, y - t.cy); if(d < bd){ bd = d; best = t; } });
    if (best && bd <= best.safeRadius) return "town";
    if (biomeGrid && x >= 0 && x < 380 && y >= 0 && y < 335) {
      var idx = y * 380 + x;
      var biomeId = biomeGrid[idx];
      var BIOME_TERRAINS = ["oasis","oasis","desert","desert","plains","plains","forest","forest","forest","monsoon","hills","snow","oasis","oasis","plains","plains","plains","forest","town","town","town","plains","forest","forest","plains","jungle","desert","plains","plains"];
      return BIOME_TERRAINS[biomeId] || "oasis";
    }
    if (!best) return "town";
    var wx = x + Math.sin(y * 0.12) * 4, wy = y + Math.cos(x * 0.12) * 4;
    var cx = Math.floor(wx / 22), cy = Math.floor(wy / 22);
    var h = Math.abs(Math.sin(cx * 1.7 * 12.9898 + cy * 2.3 * 78.233 + 99) * 43758.5453) % 1;
    return best.palette[h < 0.34 ? 0 : h < 0.67 ? 1 : 2];
  }
  function drawMap(){
    if(!state) return;
    var p = state.player, b = state.viewport.bounds, ex = exploredSet();
    var tw = play.width / 16, th = play.height / 16;
    
    // Draw background (chunks or fallback solid color)
    ctx.fillStyle = "#04121f"; // OCEAN_BASE
    ctx.fillRect(0, 0, play.width, play.height);

    var chunkTiles = WORLD_ART.chunkTiles;
    var artTile = WORLD_ART.tile;
    var minCol = Math.floor(b.minX / chunkTiles);
    var maxCol = Math.floor(b.maxX / chunkTiles);
    var minRow = Math.floor(b.minY / chunkTiles);
    var maxRow = Math.floor(b.maxY / chunkTiles);

    for (var r = minRow; r <= maxRow; r++) {
      for (var c = minCol; c <= maxCol; c++) {
        if (c < 0 || r < 0 || c >= WORLD_ART.cols || r >= WORLD_ART.rows) continue;
        var wx0 = Math.max(b.minX, c * chunkTiles);
        var wx1 = Math.min(b.maxX + 1, (c + 1) * chunkTiles, WORLD_ART.worldTilesX);
        var wy0 = Math.max(b.minY, r * chunkTiles);
        var wy1 = Math.min(b.maxY + 1, (r + 1) * chunkTiles, WORLD_ART.worldTilesY);
        if (wx1 <= wx0 || wy1 <= wy0) continue;

        var img = getChunkImage(c, r);
        if (img) {
          var sx = (wx0 - c * chunkTiles) * artTile;
          var sy = (wy0 - r * chunkTiles) * artTile;
          var sw = (wx1 - wx0) * artTile;
          var sh = (wy1 - wy0) * artTile;
          var dx = (wx0 - b.minX) * tw;
          var dy = (wy0 - b.minY) * th;
          var dw = (wx1 - wx0) * tw;
          var dh = (wy1 - wy0) * th;
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        } else {
          // Fallback to solid tiles for this chunk's viewport intersection
          for (var ty = wy0; ty < wy1; ty++) {
            for (var tx = wx0; tx < wx1; tx++) {
              var sx = (tx - b.minX) * tw, sy = (ty - b.minY) * th;
              if (!ex[key(tx, ty)]) {
                ctx.fillStyle = "#05070b";
              } else {
                ctx.fillStyle = state.viewport.terrainColors[biomeAt(tx, ty)] || "#334155";
              }
              ctx.fillRect(sx, sy, Math.ceil(tw), Math.ceil(th));
            }
          }
        }
      }
    }

    // Fog overlay
    for(var y=b.minY;y<=b.maxY;y++) for(var x=b.minX;x<=b.maxX;x++){
      var sx = (x - b.minX) * tw, sy = (y - b.minY) * th;
      var seen = inSight(x, y);
      var known = seen || ex[key(x, y)];
      if (!known) {
        ctx.fillStyle = "#060a14"; // FOG
        ctx.fillRect(sx, sy, Math.ceil(tw), Math.ceil(th));
      } else if (!seen) {
        // explored but out of sight -> dim memory overlay
        ctx.fillStyle = "rgba(2,6,23,0.5)";
        ctx.fillRect(sx, sy, Math.ceil(tw), Math.ceil(th));
      }
      ctx.strokeStyle = "rgba(15,23,42,.35)"; 
      ctx.strokeRect(sx, sy, tw, th);
    }

    (state.viewport.entities||[]).forEach(function(e){
      if(!ex[key(e.x,e.y)]) return;
      var sx=(e.x-b.minX+.5)*tw, sy=(e.y-b.minY+.5)*th;
      ctx.fillStyle = e.type === "chest" ? "#facc15" : "#fb923c";
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(5, tw*.18), 0, Math.PI*2); ctx.fill();
    });
    (state.viewport.others||[]).forEach(function(o){
      var sx=(o.x-b.minX+.5)*tw, sy=(o.y-b.minY+.5)*th;
      ctx.fillStyle = o.state === "combat" ? "#f97316" : "#60a5fa";
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(5, tw*.16), 0, Math.PI*2); ctx.fill();
    });
    var px=(p.x-b.minX+.5)*tw, py=(p.y-b.minY+.5)*th;
    ctx.fillStyle = "#f43f5e"; ctx.beginPath(); ctx.arc(px, py, Math.max(7, tw*.22), 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();

    // Fast-travel reach — a Chebyshev square around the player (boots widen it).
    var rad = p.travelRadius || 0;
    if(rad > 0){
      var rx = (p.x - rad - b.minX) * tw, ry = (p.y - rad - b.minY) * th, side = rad * 2 + 1;
      ctx.strokeStyle = "rgba(253,224,71,.55)"; ctx.lineWidth = 2; ctx.setLineDash([5,4]);
      ctx.strokeRect(rx, ry, side * tw, side * th); ctx.setLineDash([]);
    }
  }
  var MON_COLORS = ["#fb923c","#f472b6","#c084fc","#f87171","#fbbf24"];
  function monColor(i){ return MON_COLORS[i % MON_COLORS.length]; }
  function battleMonsters(c){ return c.monsters || (c.monster ? [{ id:"m0", name:c.monster.name, hp:c.monster.hp, maxHp:c.monster.maxHp, x:c.monster.x, y:c.monster.y, dead:false, intents:c.intents||[], status:c.monsterStatus||[] }] : []); }
  function drawArenaGrid(s){
    ctx.fillStyle="#10151c"; ctx.fillRect(0,0,play.width,play.height);
    for(var y=0;y<8;y++) for(var x=0;x<8;x++){ ctx.fillStyle=(x+y)%2?"#17212c":"#1f2a36"; ctx.fillRect(x*s,y*s,s,s); ctx.strokeStyle="#304052"; ctx.strokeRect(x*s,y*s,s,s); }
  }
  function drawHpBar(s, cx, topY, hp, maxHp, color){
    var w = s*0.72, h = 5, x = cx - w/2;
    ctx.fillStyle="rgba(2,6,23,.85)"; ctx.fillRect(x-1,topY-1,w+2,h+2);
    ctx.fillStyle="#0f172a"; ctx.fillRect(x,topY,w,h);
    ctx.fillStyle=color; ctx.fillRect(x,topY,w*Math.max(0,Math.min(1,hp/Math.max(1,maxHp))),h);
  }
  function drawMonsterToken(s, mx, my, color, alpha, glow){
    var cx = mx*s+s/2, cy = my*s+s/2;
    ctx.globalAlpha = alpha==null?1:alpha;
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(cx,cy,s*.3,0,Math.PI*2); ctx.fill();
    if(glow){ ctx.strokeStyle="rgba(248,113,113,"+(0.55+glow*0.4)+")"; ctx.lineWidth=4; ctx.beginPath(); ctx.arc(cx,cy,s*(.38+glow*.16),0,Math.PI*2); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  // Faithful per-tick preview mirroring the server: walk the queued plan tick-by-tick,
  // moving the player AND advancing each monster along its telegraph, so a card's tiles
  // are oriented toward where the target ACTUALLY is when that card fires. With two
  // cleaves and a monster that steps between them, the two arcs point different ways —
  // exactly what resolution will do.
  function previewPlan(c){
    var plan = c.plan || [];
    var DELTA = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
    var mons = battleMonsters(c).filter(function(m){ return !m.dead && m.hp > 0; });
    // monster position at the START of tick k (when the player acts) = intents[k].from
    function monAt(m, k){
      var its = m.intents || [], it = its[k];
      if(it && it.from) return { x:it.from.x, y:it.from.y };
      var last = its.length ? its[its.length-1] : null;
      return last && last.to ? { x:last.to.x, y:last.to.y } : { x:m.x, y:m.y };
    }
    var ppos = { x:c.player.x, y:c.player.y };
    var attacks = [];
    for(var k=0;k<plan.length;k++){
      var a = plan[k];
      var monPos = mons.map(function(m){ return monAt(m, k); });
      if(a.kind === "move"){
        var d = DELTA[a.dir];
        if(d){
          var nx = clampA(ppos.x+d.x), ny = clampA(ppos.y+d.y), blocked = false;
          for(var b=0;b<monPos.length;b++){ if(monPos[b].x===nx && monPos[b].y===ny){ blocked = true; break; } }
          if(!blocked) ppos = { x:nx, y:ny };
        }
      } else if(a.kind === "card"){
        var card = kitCard(c, a.cardId);
        if(card && card.kind !== "buff" && card.shape && monPos.length){
          var tgt = null, bd = Infinity;
          for(var i=0;i<monPos.length;i++){ var dd = Math.abs(monPos[i].x-ppos.x)+Math.abs(monPos[i].y-ppos.y); if(dd<bd){ bd = dd; tgt = monPos[i]; } }
          attacks.push({ order: attacks.length+1, tiles: attackTilesJS({x:ppos.x,y:ppos.y}, {x:tgt.x,y:tgt.y}, card.shape), from: {x:ppos.x,y:ppos.y}, target: tgt, emoji: card.emoji });
        }
      }
    }
    return attacks;
  }
  function drawArrow(x1,y1,x2,y2,color){
    var len = Math.hypot(x2-x1, y2-y1); if(len < 6) return;
    var ang = Math.atan2(y2-y1, x2-x1), ex = x1 + Math.cos(ang)*(len-9), ey = y1 + Math.sin(ang)*(len-9), ah = 7;
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(ex + Math.cos(ang)*ah, ey + Math.sin(ang)*ah);
    ctx.lineTo(ex + Math.cos(ang+2.5)*ah, ey + Math.sin(ang+2.5)*ah);
    ctx.lineTo(ex + Math.cos(ang-2.5)*ah, ey + Math.sin(ang-2.5)*ah);
    ctx.closePath(); ctx.fill();
  }
  function drawCardPreview(s, c){
    var attacks = previewPlan(c);
    attacks.forEach(function(atk){
      atk.tiles.forEach(function(t){
        ctx.fillStyle = "rgba(34,211,238,.26)"; ctx.fillRect(t.x*s,t.y*s,s,s);
        ctx.strokeStyle = "rgba(34,211,238,.85)"; ctx.lineWidth = 1.5; ctx.strokeRect(t.x*s+1.5,t.y*s+1.5,s-3,s-3);
        // order badge, corner offset by order so stacked attacks stay legible
        var bx = t.x*s + (atk.order % 2 === 1 ? 2 : s - 15), by = t.y*s + (atk.order <= 2 ? 2 : s - 15);
        ctx.fillStyle = "#0e7490"; ctx.fillRect(bx, by, 13, 13);
        ctx.fillStyle = "#e0f2fe"; ctx.font = "bold 10px sans-serif"; ctx.fillText(String(atk.order), bx + 3, by + 10);
      });
      // direction arrow from the firing position toward the target at that tick
      drawArrow(atk.from.x*s+s/2, atk.from.y*s+s/2, atk.target.x*s+s/2, atk.target.y*s+s/2, "rgba(34,211,238,.95)");
      // ghost ring where the player will be standing when this attack fires (if moved)
      if(atk.from.x !== c.player.x || atk.from.y !== c.player.y){
        ctx.strokeStyle = "rgba(96,165,250,.8)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(atk.from.x*s+s/2, atk.from.y*s+s/2, s*.22, 0, Math.PI*2); ctx.stroke();
      }
    });
  }
  function drawBattle(){
    var c = state && state.combat;
    if(!c) return;
    if(playing && pb){ drawPlaybackFrame(); return; }
    var s = play.width / 8;
    var frameMs = 1200;
    drawArenaGrid(s);
    var monsters = battleMonsters(c);
    // 1) telegraph tiles + intent arrows for every living monster
    monsters.forEach(function(m){
      if(m.dead || m.hp<=0) return;
      var intents = m.intents || [];
      var anim = reduceMotion || !intents.length ? 0 : (performance.now() - battleAnimStart) % (frameMs * intents.length);
      var active = intents.length ? Math.floor(anim / frameMs) : 0;
      var local = reduceMotion || !intents.length ? 0 : (anim % frameMs) / frameMs;
      var pulse = reduceMotion ? 0.35 : 0.25 + Math.sin(local * Math.PI) * 0.35;
      intents.forEach(function(intent, idx){
        var isActive = idx === active;
        if(intent.attackTiles && intent.attackTiles.length){
          intent.attackTiles.forEach(function(t){ ctx.fillStyle=isActive ? "rgba(248,113,113," + (0.30 + pulse) + ")" : "rgba(248,113,113,.16)"; ctx.fillRect(t.x*s,t.y*s,s,s); });
        }
        ctx.strokeStyle = intent.act === "attack" ? "#fb7185" : intent.act === "advance" ? "#facc15" : "#64748b";
        ctx.lineWidth = isActive ? 3 : 1.5;
        ctx.beginPath(); ctx.moveTo(intent.from.x*s+s/2,intent.from.y*s+s/2); ctx.lineTo(intent.to.x*s+s/2,intent.to.y*s+s/2); ctx.stroke();
        ctx.fillStyle = isActive ? "#f8fafc" : "#facc15"; ctx.font="bold 12px sans-serif"; ctx.fillText(String(intent.order), intent.to.x*s+5, intent.to.y*s+15);
      });
    });
    // 2) player move + card previews
    drawCardPreview(s, c);
    if(c.projected && (c.projected.x !== c.player.x || c.projected.y !== c.player.y)){
      ctx.strokeStyle="#fde047"; ctx.lineWidth=3; ctx.setLineDash([6,4]);
      ctx.beginPath(); ctx.moveTo(c.player.x*s+s/2,c.player.y*s+s/2); ctx.lineTo(c.projected.x*s+s/2,c.projected.y*s+s/2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle="#60a5fa"; ctx.beginPath(); ctx.arc(c.player.x*s+s/2,c.player.y*s+s/2,s*.28,0,Math.PI*2); ctx.fill();
    if(c.projected && (c.projected.x !== c.player.x || c.projected.y !== c.player.y)){ ctx.fillStyle="rgba(147,197,253,.7)"; ctx.beginPath(); ctx.arc(c.projected.x*s+s/2,c.projected.y*s+s/2,s*.2,0,Math.PI*2); ctx.fill(); }
    // 3) monster tokens (animate toward the active telegraphed tile) + HP bars
    monsters.forEach(function(m, mi){
      if(m.dead || m.hp<=0) return;
      var intents = m.intents || [];
      var anim = reduceMotion || !intents.length ? 0 : (performance.now() - battleAnimStart) % (frameMs * Math.max(1, intents.length));
      var active = intents.length ? Math.floor(anim / frameMs) : 0;
      var local = reduceMotion || !intents.length ? 0 : (anim % frameMs) / frameMs;
      var pulse = reduceMotion ? 0.35 : 0.25 + Math.sin(local * Math.PI) * 0.35;
      var dx = m.x, dy = m.y, ai = intents[active];
      if(ai && !reduceMotion){ var ease = 1 - Math.pow(1 - Math.min(1, local * 1.35), 3); dx = ai.from.x + (ai.to.x - ai.from.x) * ease; dy = ai.from.y + (ai.to.y - ai.from.y) * ease; }
      drawMonsterToken(s, dx, dy, monColor(mi), 1, ai && ai.act === "attack" && !reduceMotion ? pulse : 0);
      drawHpBar(s, dx*s+s/2, dy*s+s/2 - s*.42, m.hp, m.maxHp, monColor(mi));
    });
    ctx.fillStyle="#e5e7eb"; ctx.font="13px sans-serif";
    var label = monsters.filter(function(m){ return !m.dead && m.hp>0; }).map(function(m){ return m.name + " " + m.hp + "/" + m.maxHp; }).join("   ");
    ctx.fillText(label || "Victory!", 10, play.height - 12);
  }
  // One frame of the post-resolve playback: interpolate everyone toward this step's
  // positions, flash the tiles struck, then advance to the next step when done.
  function drawPlaybackFrame(){
    var s = play.width / 8;
    var now = performance.now();
    var step = pb.steps[pb.idx];
    if(!step){ playing = false; var d0 = pb.done; pb = null; if(d0) d0(); return; }
    var local = Math.min(1, (now - pb.start) / pb.stepMs);
    var ease = 1 - Math.pow(1 - local, 3);
    var flash = 0.25 + Math.sin(local * Math.PI) * 0.4;
    // Screen shake when the player takes a hit this step (decays over the step).
    var shake = step.taken > 0 ? Math.sin(local * Math.PI * 7) * (1 - local) * 4 : 0;
    var slashA = Math.max(0, 1 - Math.abs(local - 0.35) / 0.35); // slash visible mid-step
    ctx.save();
    ctx.translate(shake, 0);
    drawArenaGrid(s);
    (step.monsters || []).forEach(function(m){ (m.attackTiles || []).forEach(function(t){ ctx.fillStyle="rgba(248,113,113," + (0.25 + flash) + ")"; ctx.fillRect(t.x*s,t.y*s,s,s); }); });
    (step.attackTiles || []).forEach(function(t){ ctx.fillStyle="rgba(34,211,238," + (0.22 + flash) + ")"; ctx.fillRect(t.x*s,t.y*s,s,s); ctx.strokeStyle="rgba(34,211,238,.8)"; ctx.lineWidth=1.5; ctx.strokeRect(t.x*s+1,t.y*s+1,s-2,s-2); });
    var pp = { x: pb.prevPlayer.x + (step.playerPos.x - pb.prevPlayer.x) * ease, y: pb.prevPlayer.y + (step.playerPos.y - pb.prevPlayer.y) * ease };
    var ppx = pp.x*s+s/2, ppy = pp.y*s+s/2;
    (step.monsters || []).forEach(function(m, mi){
      var prev = pb.prevMons[m.id] || { x:m.x, y:m.y, hp:m.hp, maxHp:m.maxHp, name:m.name };
      var mx = prev.x + (m.x - prev.x) * ease, my = prev.y + (m.y - prev.y) * ease;
      var attacking = m.attackTiles && m.attackTiles.length;
      // lunge: a quick thrust toward the player that peaks mid-step then recoils
      if(attacking){
        var cx0 = mx*s+s/2, cy0 = my*s+s/2;
        var ldx = ppx - cx0, ldy = ppy - cy0, ld = Math.hypot(ldx, ldy) || 1;
        var lunge = Math.sin(local * Math.PI) * s * 0.3;
        mx += (ldx/ld) * lunge / s; my += (ldy/ld) * lunge / s;
      }
      var dyingNow = (m.act === "dead" || m.hp <= 0);
      var alpha = dyingNow ? Math.max(0.12, 1 - local) : 1;
      drawMonsterToken(s, mx, my, monColor(mi), alpha, attacking ? flash : 0);
      if(attacking && slashA > 0){
        var scx = mx*s+s/2, scy = my*s+s/2;
        ctx.strokeStyle = "rgba(255,255,255," + (0.65 * slashA) + ")"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(scx, scy, s*0.46, local*4, local*4 + Math.PI*0.8); ctx.stroke();
      }
      if(!dyingNow) drawHpBar(s, mx*s+s/2, my*s+s/2 - s*.42, m.hp, m.maxHp || prev.maxHp || m.hp, monColor(mi));
      var dealtM = Math.max(0, (prev.hp != null ? prev.hp : m.hp) - m.hp);
      if(dealtM > 0){ ctx.fillStyle = "rgba(134,239,172," + Math.max(0,1-local) + ")"; ctx.font = "bold 16px sans-serif"; ctx.fillText("-" + dealtM, mx*s+s/2-6, my*s+s/2 - s*0.5 - local*14); }
    });
    // player token — briefly flares toward red when struck this step
    var hitT = step.taken > 0 ? Math.max(0, 1 - local) : 0;
    ctx.fillStyle = hitT > 0 ? ("rgb(" + Math.round(96+159*hitT) + "," + Math.round(165-120*hitT) + "," + Math.round(250-180*hitT) + ")") : "#60a5fa";
    ctx.beginPath(); ctx.arc(ppx, ppy, s*.28 + hitT*2, 0, Math.PI*2); ctx.fill();
    if(step.taken > 0){ ctx.fillStyle="rgba(248,113,113," + Math.max(0,1-local) + ")"; ctx.font="bold 18px sans-serif"; ctx.fillText("-" + step.taken, ppx-8, ppy - s*0.5 - local*16); }
    ctx.restore();
    if(pb.shownIdx !== pb.idx){
      var line = step.line || "";
      var dot = line.indexOf(". "); if(dot >= 0 && dot <= 2) line = line.slice(dot+2); else if(line.indexOf("• ") === 0) line = line.slice(2);
      if(line){ note.textContent = line; logEvent(line); }
      pb.shownIdx = pb.idx;
    }
    ctx.fillStyle="#e5e7eb"; ctx.font="13px sans-serif"; ctx.fillText("Resolving… " + (pb.idx+1) + "/" + pb.steps.length, 10, play.height - 12);
    if(local >= 1){
      pb.prevPlayer = { x:step.playerPos.x, y:step.playerPos.y };
      pb.prevMons = {}; (step.monsters || []).forEach(function(m){ pb.prevMons[m.id] = { x:m.x, y:m.y, hp:m.hp, maxHp:m.maxHp, name:m.name }; });
      pb.idx++; pb.start = now;
      if(pb.idx >= pb.steps.length){ playing = false; var d = pb.done; pb = null; if(d) d(); }
    }
  }
  function drawKnownMap(target, width, height, pad, labels){
    var tiles = state.minimap && state.minimap.explored || [];
    var p = state.player, b = state.viewport.bounds;
    target.fillStyle = "#070b11"; target.fillRect(0,0,width,height);
    if(!tiles.length) return;
    var minX=p.x, maxX=p.x, minY=p.y, maxY=p.y;
    tiles.forEach(function(t){ if(t.x<minX)minX=t.x; if(t.x>maxX)maxX=t.x; if(t.y<minY)minY=t.y; if(t.y>maxY)maxY=t.y; });
    (state.minimap.towns||[]).forEach(function(t){ if(t.cx<minX)minX=t.cx; if(t.cx>maxX)maxX=t.cx; if(t.cy<minY)minY=t.cy; if(t.cy>maxY)maxY=t.cy; });
    var sx = (width - pad*2) / Math.max(1, maxX - minX + 1);
    var sy = (height - pad*2) / Math.max(1, maxY - minY + 1);
    var scale = Math.min(sx, sy);
    if(!Number.isFinite(scale) || scale <= 0) scale = 1;
    var ox = (width - (maxX - minX + 1) * scale) / 2;
    var oy = (height - (maxY - minY + 1) * scale) / 2;
    function mx(x){ return ox + (x - minX) * scale; }
    function my(y){ return oy + (y - minY) * scale; }
    tiles.forEach(function(t){
      var inView = t.x >= b.minX && t.x <= b.maxX && t.y >= b.minY && t.y <= b.maxY;
      target.globalAlpha = inView ? 1 : 0.32;
      target.fillStyle = state.viewport.terrainColors[biomeAt(t.x,t.y)] || "#334155";
      target.fillRect(mx(t.x), my(t.y), Math.max(1, Math.ceil(scale)), Math.max(1, Math.ceil(scale)));
    });
    target.globalAlpha = 1;
    target.strokeStyle = "#f8fafc"; target.lineWidth = labels ? 2 : 1.5;
    target.strokeRect(mx(b.minX), my(b.minY), (b.maxX - b.minX + 1) * scale, (b.maxY - b.minY + 1) * scale);
    (state.minimap.towns||[]).forEach(function(t){
      target.fillStyle = "#bfdbfe";
      target.fillRect(mx(t.cx)-3, my(t.cy)-3, 6, 6);
      if(labels && scale > 2){
        target.fillStyle = "#e5e7eb";
        target.font = "12px sans-serif";
        target.fillText(t.name, mx(t.cx) + 6, my(t.cy) - 6);
      }
    });
    target.fillStyle = "#fb7185";
    target.beginPath(); target.arc(mx(p.x)+scale/2, my(p.y)+scale/2, labels ? 7 : 4, 0, Math.PI*2); target.fill();
    if(labels){
      target.strokeStyle = "#f8fafc"; target.lineWidth = 2; target.stroke();
      target.fillStyle = "rgba(7,11,17,.78)"; target.fillRect(10, 10, 168, 26);
      target.fillStyle = "#e5e7eb"; target.font = "13px sans-serif"; target.fillText("Hold M: world map", 18, 28);
    }
  }
  function drawMinimap(){
    if(!state) return;
    drawKnownMap(mini, minimap.width, minimap.height, 8, false);
  }
  function drawExpandedMap(){
    if(!state) return;
    drawKnownMap(ctx, play.width, play.height, 18, true);
  }
  function tileLabel(p){ return String.fromCharCode(65 + p.x) + (p.y + 1); }
  function cardName(id){ var k = (state.combat && state.combat.kit) || []; for(var i=0;i<k.length;i++) if(k[i].id===id) return k[i].emoji + " " + k[i].name; return id; }
  function actionLabel(a){
    if(!a) return "Empty";
    if(a.kind === "move") return a.dir.charAt(0).toUpperCase() + a.dir.slice(1);
    if(a.kind === "card") return cardName(a.cardId);
    return "Wait";
  }
  function renderBattleSummary(){
    var c = state && state.combat, planEl = document.getElementById("battlePlan"), monsterEl = document.getElementById("monsterPlan"), turnEl = document.getElementById("battleTurnText"), statusEl = document.getElementById("statusRow"), apEl = document.getElementById("apText");
    planEl.innerHTML = ""; monsterEl.innerHTML = ""; statusEl.innerHTML = "";
    if(!c){
      turnEl.textContent = "Not in combat."; apEl.textContent = "";
      document.getElementById("resolve").disabled = true;
      document.querySelectorAll("[data-bmove]").forEach(function(b){ b.disabled = true; });
      document.getElementById("wait").disabled = true;
      document.getElementById("undo").disabled = true;
      return;
    }
    var plan = c.plan || [], ap = c.ap || { max:3, available:3, spent:0, ticks:0, maxTicks:3 };
    var remainingAp = ap.available - ap.spent, ticksLeft = ap.maxTicks - ap.ticks;
    apEl.textContent = "⚡ AP " + ap.spent + "/" + ap.available + (ap.available < ap.max ? " (stunned)" : "") + " · " + ticksLeft + " action" + (ticksLeft === 1 ? "" : "s") + " left";
    turnEl.textContent = "Turn " + c.turn + " — play cards & moves, then Resolve.";
    for(var i=0;i<ap.maxTicks;i++){
      var slot = document.createElement("span");
      slot.className = "turn-slot" + (plan[i] ? " filled" : "");
      slot.textContent = (i + 1) + ". " + actionLabel(plan[i]);
      planEl.appendChild(slot);
    }
    function badgeRow(label, arr){
      if(!arr || !arr.length) return;
      var d = document.createElement("div");
      d.textContent = label + ": " + arr.map(function(s){ return s.emoji + " " + s.label + " " + s.amount + " (" + s.turns + ")"; }).join("   ");
      statusEl.appendChild(d);
    }
    badgeRow("You", c.playerStatus);
    var monsters = battleMonsters(c);
    monsters.forEach(function(m){
      var head = document.createElement("div");
      head.className = "turn-step";
      head.textContent = (m.dead || m.hp <= 0) ? (m.name + " — 💀 defeated") : (m.name + " — " + m.hp + "/" + m.maxHp + " HP");
      monsterEl.appendChild(head);
      if(m.status && m.status.length) badgeRow(m.name, m.status);
      if(m.dead || m.hp <= 0) return;
      (m.intents || []).forEach(function(intent){
        var el = document.createElement("div");
        el.className = "turn-step " + intent.act;
        var target = tileLabel(intent.to);
        var fx = intent.apply && intent.apply.length ? " +" + intent.apply.map(function(e){ return e.kind; }).join("/") : "";
        var detail = intent.act === "attack" ? "hits " + (intent.attackTiles || []).length + " tiles for " + intent.damage + fx : intent.description;
        el.textContent = "  " + intent.order + ". " + intent.name + " -> " + target + " - " + detail;
        monsterEl.appendChild(el);
      });
    });
    document.getElementById("resolve").disabled = playing;
    var noTicks = ticksLeft <= 0 || playing;
    document.querySelectorAll("[data-bmove]").forEach(function(b){ b.disabled = noTicks || remainingAp < 1; });
    document.getElementById("wait").disabled = noTicks;
    document.getElementById("undo").disabled = plan.length === 0 || playing;
  }
  function renderPanels(){
    var p = state.player, needed = Math.max(0, Math.min(p.maxHp - p.hp, p.balance - p.hp));
    document.getElementById("coords").textContent = "⬡ " + p.x + ", " + p.y + "   ·   ₿ " + p.balance;
    document.getElementById("hpText").textContent = p.hp + "/" + p.maxHp;
    document.getElementById("hpFill").style.width = Math.max(0, Math.min(100, p.hp / Math.max(1,p.maxHp) * 100)) + "%";
    document.getElementById("stText").textContent = p.stamina + "%";
    document.getElementById("stFill").style.width = Math.max(0, Math.min(100, p.stamina)) + "%";
    document.getElementById("hpInput").max = String(needed);
    document.getElementById("hpInput").placeholder = String(needed);
    document.getElementById("bankText").textContent = needed > 0 ? needed + " banked sats can be committed to HP." : "No HP refill available.";
    document.getElementById("battleControls").style.opacity = state.combat ? "1" : ".45";
    var tray = document.getElementById("cardTray"); tray.innerHTML = "";
    ((state.combat && state.combat.kit) || []).forEach(function(card){
      var b = document.createElement("button");
      b.textContent = card.emoji + " " + card.name + " " + card.apCost + "⚡";
      b.title = card.desc;
      b.className = card.kind === "buff" ? "" : "primary";
      b.disabled = !card.affordable;
      b.onclick = function(){ battleQueue({ kind:"card", cardId:card.id }, { action:"card", cardId:card.id }); };
      tray.appendChild(b);
    });
    var weap = document.getElementById("weapon"); weap.innerHTML = "";
    (state.inventory.items||[]).filter(function(i){ return i.slot === "weapon"; }).forEach(function(i){ var o=document.createElement("option"); o.value=i.id; o.textContent=i.name; weap.appendChild(o); });
    if(state.combat && state.combat.selectedWeaponId) weap.value = state.combat.selectedWeaponId;
    renderBattleSummary();
    renderList();
  }
  function renderList(){
    ["Shop","Quests","Gear"].forEach(function(n){ document.getElementById("tab"+n).className = activeTab === n.toLowerCase() ? "active" : ""; });
    var list = document.getElementById("list"); list.innerHTML = "";
    if(activeTab === "shop"){
      if(!state.town) { list.innerHTML = '<div class="muted">Reach a town to shop.</div>'; return; }
      state.town.catalog.forEach(function(i){ addItem(i.name + " - " + i.price + " sats", i.owned ? (i.equipped ? "Equipped" : "Owned") : (i.locked ? "Locked" : "Buy"), function(){ if(!i.owned && !i.locked) act("/satscape/api/shop/buy", { itemId:i.id }); else if(i.owned) act("/satscape/api/shop/equip", { itemId:i.id }); }); });
    } else if(activeTab === "quests"){
      if(!state.town) { list.innerHTML = '<div class="muted">Reach a town to see quests.</div>'; return; }
      var qs = state.town.quests.offered.concat(state.town.quests.carry);
      qs.forEach(function(q){ var label = q.def.title + " - " + q.status + " " + q.progress + "/" + q.def.target; var btn = q.status === "available" ? "Accept" : q.status === "claimable" ? "Claim" : q.def.type === "tribute" && q.status !== "claimed" ? "Pay" : ""; addItem(label, btn || q.status, function(){ if(btn==="Accept") act("/satscape/api/quests/accept", { key:q.def.key }); else if(btn==="Claim") act("/satscape/api/quests/claim", { key:q.def.key }); else if(btn==="Pay") act("/satscape/api/quests/tribute", { key:q.def.key }); }); });
    } else {
      (state.inventory.items||[]).forEach(function(i){ addItem(i.name + " (" + i.slot + ")", i.equipped ? "Equipped" : "Equip", function(){ if(!i.equipped) act("/satscape/api/shop/equip", { itemId:i.id }); }); });
      if(!(state.inventory.items||[]).length) list.innerHTML = '<div class="muted">No gear yet.</div>';
    }
  }
  function addItem(label, button, cb){ var el=document.createElement("div"); el.className="item"; var s=document.createElement("span"); s.textContent=label; var b=document.createElement("button"); b.textContent=button; b.onclick=cb; el.appendChild(s); el.appendChild(b); document.getElementById("list").appendChild(el); }
  function render(){ if(!state || state.error) return; if(showWorldMap) drawExpandedMap(); else if(state.combat) drawBattle(); else drawMap(); drawMinimap(); renderPanels(); }
  document.querySelectorAll("[data-move]").forEach(function(b){ b.onclick=function(){ act("/satscape/api/move", { dir:b.dataset.move }); }; });
  document.querySelectorAll("[data-bmove]").forEach(function(b){ b.onclick=function(){ battleQueue({ kind:"move", dir:b.dataset.bmove }, { action:"move", dir:b.dataset.bmove }); }; });
  document.getElementById("eat").onclick=function(){ act("/satscape/api/eat", {}); };
  document.getElementById("refresh").onclick=function(){ api("/satscape/api/state?full=1").then(setState).catch(function(e){ note.textContent=e.message; }); };
  document.getElementById("refill").onclick=function(){ act("/satscape/api/refill-hp", { sats:Number(document.getElementById("hpInput").value || 0) }); };
  document.getElementById("weaponBtn").onclick=function(){ act("/satscape/api/battle", { action:"weapon", itemId:document.getElementById("weapon").value }); };
  document.getElementById("wait").onclick=function(){ battleQueue({ kind:"wait" }, { action:"wait" }); };
  document.getElementById("undo").onclick=function(){ battleUndo(); };
  document.getElementById("resolve").onclick=function(){ resolveBattle(); };
  document.getElementById("flee").onclick=function(){ act("/satscape/api/battle", { action:"flee" }); };
  document.getElementById("estimate").onclick=function(){ act("/satscape/api/travel", { estimate:true, tx:Number(document.getElementById("tx").value), ty:Number(document.getElementById("ty").value) }); };
  document.getElementById("travel").onclick=function(){ act("/satscape/api/travel", { tx:Number(document.getElementById("tx").value), ty:Number(document.getElementById("ty").value) }); };
  document.getElementById("clickTravel").onchange=function(e){ clickTravel = !!e.target.checked; document.getElementById("travelText").textContent = clickTravel ? "Click any visible map tile to travel immediately." : ""; };
  play.addEventListener("click", function(e){
    if(!state || state.combat || showWorldMap) return;
    var r = play.getBoundingClientRect(), b = state.viewport.bounds;
    var x = Math.floor((e.clientX - r.left) / r.width * 16) + b.minX;
    var y = Math.floor((e.clientY - r.top) / r.height * 16) + b.minY;
    document.getElementById("tx").value = String(x);
    document.getElementById("ty").value = String(y);
    var rad = state.player.travelRadius || 0;
    var reach = Math.max(Math.abs(x - state.player.x), Math.abs(y - state.player.y));
    if(clickTravel){
      if(reach > rad){ document.getElementById("travelText").textContent = "Out of fast-travel range (" + (rad*2+1) + "×" + (rad*2+1) + ")."; return; }
      document.getElementById("travelText").textContent = "Travelling to (" + x + ", " + y + ")...";
      act("/satscape/api/travel", { tx:x, ty:y });
    } else {
      document.getElementById("travelText").textContent = "Target (" + x + ", " + y + ")" + (reach > rad ? " — out of range" : "") + ".";
    }
  });
  ["Shop","Quests","Gear"].forEach(function(n){ document.getElementById("tab"+n).onclick=function(){ activeTab=n.toLowerCase(); renderList(); }; });
  function typingTarget(el){ return el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable); }
  function directionKey(e){ return { ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right", w:"up", W:"up", s:"down", S:"down", a:"left", A:"left", d:"right", D:"right" }[e.key]; }
  window.addEventListener("keydown", function(e){
    if(typingTarget(document.activeElement)) return;
    if(e.key === "m" || e.key === "M"){
      e.preventDefault();
      if(!showWorldMap){ showWorldMap = true; render(); if(!(state && state.combat)) api("/satscape/api/state?full=1").then(setState).catch(function(){}); }
      return;
    }
    var d = directionKey(e);
    if(d){
      e.preventDefault();
      if(state && state.combat) battleQueue({ kind:"move", dir:d }, { action:"move", dir:d });
      else act("/satscape/api/move", { dir:d });
      return;
    }
    if(!state) return;
    if(e.key === "r" || e.key === "R"){ e.preventDefault(); api("/satscape/api/state").then(setState).catch(function(err){ note.textContent=err.message; }); return; }
    if(e.key === "e" || e.key === "E"){ e.preventDefault(); act("/satscape/api/eat", {}); return; }
    if(!state.combat) return;
    if(e.key === " " || e.key === "Enter"){ e.preventDefault(); resolveBattle(); return; }
    if(e.key === "q" || e.key === "Q"){ e.preventDefault(); battleQueue({ kind:"wait" }, { action:"wait" }); return; }
    if(e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U"){ e.preventDefault(); battleUndo(); return; }
    if(e.key === "f" || e.key === "F"){ e.preventDefault(); act("/satscape/api/battle", { action:"flee" }); return; }
    var cardIdx = "123456789".indexOf(e.key);
    if(cardIdx >= 0){
      e.preventDefault();
      var kit = state.combat.kit || [];
      if(kit[cardIdx] && kit[cardIdx].affordable) battleQueue({ kind:"card", cardId:kit[cardIdx].id }, { action:"card", cardId:kit[cardIdx].id });
    }
  });
  window.addEventListener("keyup", function(e){
    if(e.key !== "m" && e.key !== "M") return;
    if(typingTarget(document.activeElement)) return;
    e.preventDefault();
    if(showWorldMap){ showWorldMap = false; render(); }
  });
  function animate(){
    if(!document.hidden && state && state.combat && !showWorldMap && (!reduceMotion || playing)) drawBattle();
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  api("/satscape/api/state?full=1").then(setState).catch(function(e){ note.textContent=e.message; });
  // Live state poll — lite (no heavy minimap payload) and PAUSED during combat (turn-based,
  // so action responses already carry fresh state) or while an action/playback is running.
  // This removes the per-2s full-world fetch that caused most of the in-fight lag.
  setInterval(function(){ if(playing || inflight > 0 || (state && state.combat)) return; api("/satscape/api/state").then(setState).catch(function(){}); }, 2500);
})();
</script>
</body>
</html>`;

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SatScape - Global Map</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #020617; color: #f8fafc; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; }
  h1 { font-size: 18px; letter-spacing: 2px; margin: 0; font-weight: 800; }
  .meta { color: #64748b; font-size: 12px; }
  .wrap { display: flex; justify-content: center; padding: 0 16px 24px; }
  canvas { background: #020617; border: 1px solid #1e293b; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.5); max-width: 100%; touch-action: none; }
  .hint { text-align: center; color: #475569; font-size: 11px; padding-bottom: 24px; }
</style>
</head>
<body>
  <header><h1>SATSCAPE - GLOBAL MAP</h1><span class="meta" id="meta">connecting...</span></header>
  <div class="wrap"><canvas id="map" width="900" height="640"></canvas></div>
  <p class="hint">Towns and their territories - drag to pan - scroll to zoom - live every 2s</p>
<script>
(function () {
  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var meta = document.getElementById("meta");
  var state = { towns: [], terrainColors: {}, explored: [], exploredKeys: {}, players: [] };
  var scale = 3, ox = 0, oy = 0, dragging = false, lastX = 0, lastY = 0;
  var biomeGrid = null;
  fetch("/satscape/chunks/world.json")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var binary = atob(data.biome);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      biomeGrid = bytes;
      if (typeof render === "function") render();
      else if (typeof draw === "function") draw();
    }).catch(function(e) { console.error("Failed to load biomeGrid:", e); });

  function worldToScreen(wx, wy) { return [canvas.width / 2 + (wx * scale) + ox, canvas.height / 2 + (wy * scale) + oy]; }
  function hash01(a, b, s) { return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + s) * 43758.5453) % 1; }
  function biomeAt(x, y) {
    var best = null, bd = Infinity;
    var towns = state.towns || [];
    for (var i = 0; i < towns.length; i++) { var t = towns[i]; var d = Math.hypot(x - t.cx, y - t.cy); if (d < bd) { bd = d; best = t; } }
    if (best && bd <= best.safeRadius) return "town";

    if (biomeGrid && x >= 0 && x < 380 && y >= 0 && y < 335) {
      var idx = y * 380 + x;
      var biomeId = biomeGrid[idx];
      var BIOME_TERRAINS = ["oasis","oasis","desert","desert","plains","plains","forest","forest","forest","monsoon","hills","snow","oasis","oasis","plains","plains","plains","forest","town","town","town","plains","forest","forest","plains","jungle","desert","plains","plains"];
      return BIOME_TERRAINS[biomeId] || "oasis";
    }

    if (!best) return "town";
    var wx = x + Math.sin(y * 0.12) * 4, wy = y + Math.cos(x * 0.12) * 4;
    var cx = Math.floor(wx / 22), cy = Math.floor(wy / 22);
    var h = hash01(cx * 1.7, cy * 2.3, 99);
    return best.palette[h < 0.34 ? 0 : h < 0.67 ? 1 : 2];
  }
  function color(t) { return state.terrainColors[t] || "#1f2937"; }
  function key(x, y) { return x + "," + y; }
  function isExplored(x, y) { return !!state.exploredKeys[key(x, y)]; }
  function draw() {
    ctx.fillStyle = "#020617"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!state.towns.length) return;
    var cxp = canvas.width / 2 + ox, cyp = canvas.height / 2 + oy;
    var minTX = Math.floor((0 - cxp) / scale - 0.5), maxTX = Math.ceil((canvas.width - cxp) / scale + 0.5);
    var minTY = Math.floor((0 - cyp) / scale - 0.5), maxTY = Math.ceil((canvas.height - cyp) / scale + 0.5);
    for (var ty = minTY; ty <= maxTY; ty++) for (var tx = minTX; tx <= maxTX; tx++) {
      ctx.fillStyle = isExplored(tx, ty) ? color(biomeAt(tx, ty)) : "#060a14";
      ctx.fillRect(cxp + (tx - 0.5) * scale, cyp + (ty - 0.5) * scale, scale + 1, scale + 1);
    }
    ctx.textAlign = "center";
    state.towns.forEach(function (t) {
      if (!isExplored(t.cx, t.cy)) return;
      var c = worldToScreen(t.cx, t.cy);
      ctx.strokeStyle = "#bfdbfe"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c[0], c[1], t.safeRadius * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#e2e8f0"; ctx.font = "bold 12px monospace"; ctx.fillText(t.name, c[0], c[1] - t.safeRadius * scale - 6);
    });
    ctx.textAlign = "left";
    state.players.forEach(function (p) {
      if (!isExplored(p.x, p.y)) return;
      var s = worldToScreen(p.x, p.y);
      ctx.fillStyle = p.state === "combat" ? "#f97316" : "#f43f5e"; ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 1.5; ctx.stroke();
      var label = p.name + "  " + p.hpPct + "%";
      ctx.font = "11px monospace"; var tw = ctx.measureText(label).width + 6;
      ctx.fillStyle = "rgba(2,6,23,0.7)"; ctx.fillRect(s[0] + 8, s[1] - 9, tw, 14);
      ctx.fillStyle = "#f8fafc"; ctx.fillText(label, s[0] + 11, s[1] + 2);
    });
  }
  function fetchPlayers() {
    fetch("/api/satscape/players").then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.players) {
        state = d; state.exploredKeys = {};
        (state.explored || []).forEach(function (tile) { state.exploredKeys[key(tile.x, tile.y)] = true; });
        meta.textContent = state.players.length + " adventurer" + (state.players.length === 1 ? "" : "s") + " - " + (state.explored || []).length + " tiles charted";
      }
      draw();
    }).catch(function () { meta.textContent = "offline"; });
  }
  canvas.addEventListener("mousedown", function (e) { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener("mouseup", function () { dragging = false; });
  window.addEventListener("mousemove", function (e) { if (!dragging) return; ox += e.clientX - lastX; oy += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; draw(); });
  canvas.addEventListener("wheel", function (e) { e.preventDefault(); scale = Math.max(2, Math.min(40, scale * (e.deltaY < 0 ? 1.1 : 0.9))); draw(); }, { passive: false });
  fetchPlayers(); setInterval(fetchPlayers, 2000);
})();
</script>
</body>
</html>`;

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
import { UI } from "./satscape_ui_assets.js";

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

  if (method === "GET" && (path === "/satscape" || path === "/satscape/")) {
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
    --frame: url("${UI.frameMap}");
    --wood: url("${UI.panelWoodPlain}");
    --woodDetail: url("${UI.panelWood}");
    --inset: url("${UI.panelInset}");
    --banner: url("${UI.banner}");
    --btn: url("${UI.btn}"); --btnDown: url("${UI.btnPressed}");
    --btnLong: url("${UI.btnLong}"); --btnLongDown: url("${UI.btnLongPressed}");
    --btnBlue: url("${UI.btnBlue}"); --btnBlueDown: url("${UI.btnBluePressed}");
    --gold:#f6e3a6; --gold-deep:#b8861f;
    --ink:#3a2a14; --ink-soft:#5a3f1c; --parch:#f3e4c2;
    --text:#f2ead6; --muted:#9a8155;
    --display:'Cinzel','Trajan Pro',Georgia,serif;
    --body:'Spectral','Iowan Old Style',Georgia,serif;
  }
  * { box-sizing:border-box; }
  html, body { min-height:100%; }
  body {
    margin:0; color:var(--text); font-family:var(--body); -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(1200px 640px at 50% -10%, rgba(120,84,40,.30), transparent 60%),
      radial-gradient(900px 560px at 50% 120%, rgba(40,60,80,.16), transparent 60%),
      #14100b;
    background-attachment:fixed;
  }
  body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; opacity:.05; mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
  body::after { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; box-shadow:inset 0 0 260px 60px rgba(0,0,0,.62); }
  button, input, select { font:inherit; }

  /* wood sprite buttons */
  button {
    position:relative; font-family:var(--display); letter-spacing:1px; text-transform:uppercase; font-size:11px; font-weight:700;
    color:#fff3da; text-shadow:0 1px 2px rgba(0,0,0,.55); border:0; cursor:pointer; padding:11px 12px; min-height:42px;
    background:var(--btnLong) center/100% 100% no-repeat; transition:filter .12s, transform .06s; }
  button:hover { filter:brightness(1.1); }
  button:active { background-image:var(--btnLongDown); transform:translateY(1px); }
  button:disabled { filter:grayscale(.7) brightness(.8); opacity:.55; cursor:not-allowed; }
  button.primary { background-image:var(--btnBlue); color:#eaf4ff; }
  button.primary:active { background-image:var(--btnBlueDown); }
  button.danger { color:#ffd9d4; }
  button.danger::after { content:""; position:absolute; inset:0; border-radius:9px; box-shadow:inset 0 0 0 2px rgba(180,52,31,.55); pointer-events:none; }
  button.sq { background-image:var(--btn); min-width:44px; min-height:46px; padding:0; }
  button.sq:active { background-image:var(--btnDown); }

  input, select {
    width:100%; font-family:var(--body); color:var(--ink); border:0; padding:9px 11px; min-height:42px;
    background:var(--inset) center/100% 100% no-repeat; }
  input:focus, select:focus { outline:none; filter:brightness(1.05) drop-shadow(0 0 4px rgba(184,134,31,.5)); }
  select { color:var(--ink); }
  ::-webkit-scrollbar { width:9px; height:9px; }
  ::-webkit-scrollbar-thumb { background:rgba(90,58,22,.55); border-radius:9px; border:2px solid transparent; background-clip:padding-box; }

  kbd { font-family:var(--display); font-size:10px; font-weight:700; color:#3a2a12; background:linear-gradient(180deg,#f3e4c2,#d8c08c);
    border:1px solid #9a6a2c; border-bottom-width:2px; border-radius:5px; padding:1px 5px; min-width:16px; display:inline-block; text-align:center;
    box-shadow:0 1px 0 rgba(0,0,0,.25); line-height:1.5; }

  .app { position:relative; z-index:1; display:grid; grid-template-columns:1fr 360px; gap:14px; height:100dvh; padding:14px; }
  .stage { position:relative; min-width:0; min-height:0; display:flex; flex-direction:column; }
  .side { min-width:0; }

  /* slim HUD bar above the map */
  .hudbar { flex:0 0 auto; display:flex; align-items:center; gap:14px; margin-bottom:10px; }
  .brand { display:flex; align-items:center; gap:10px; flex:0 0 auto; }
  .sigil { width:36px; height:36px; flex:none; display:grid; place-items:center; border-radius:50%; font-family:var(--display); font-weight:700; font-size:18px; color:#3a2a08;
    background:radial-gradient(circle at 34% 28%, #fbe8a8, #d6a32a 46%, #6b4a12); box-shadow:0 0 0 1px rgba(232,193,90,.55), 0 0 18px rgba(232,193,90,.38), inset 0 -3px 6px rgba(0,0,0,.35); }
  h1 { margin:0; font-family:var(--display); font-weight:800; font-size:19px; letter-spacing:3px; color:var(--parch); text-shadow:0 1px 0 #000, 0 0 22px rgba(232,193,90,.28); }
  .tagline { font-family:var(--body); font-style:italic; font-size:11px; letter-spacing:.5px; color:var(--muted); margin-top:1px; }
  .vitals { flex:1 1 auto; display:flex; gap:12px; min-width:0; max-width:540px; }
  .vitals .bar { flex:1 1 0; min-width:0; }
  .toolbelt { flex:0 0 auto; display:flex; gap:7px; align-items:center; margin-left:auto; }
  .toolbelt button { min-height:40px; padding:8px 11px; font-size:10px; }
  .coords { font-family:var(--display); font-size:12px; letter-spacing:1px; color:#fff3da; padding:8px 14px;
    border-style:solid; border-width:12px 22px; border-color:transparent; border-image:var(--btn) 16 18 fill / 12px 22px / 0 stretch; white-space:nowrap; }

  .bar { position:relative; padding:6px 12px; color:var(--ink);
    border-style:solid; border-width:13px; border-color:transparent; border-image:var(--wood) 30 fill / 12px / 0 stretch; }
  .bar label { display:flex; justify-content:space-between; font-family:var(--display); letter-spacing:1.2px; text-transform:uppercase; font-size:9.5px; color:#6b4a18; margin-bottom:5px; }
  .bar label span:last-child { color:#3a2a12; font-weight:700; }
  .fill { height:11px; border-radius:999px; background:#3a2c18; overflow:hidden; box-shadow:inset 0 1px 3px rgba(0,0,0,.6); }
  .fill span { position:relative; display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#3f8f54,#7ad08a); box-shadow:0 0 10px rgba(122,208,138,.5); transition:width .4s cubic-bezier(.4,0,.2,1); }
  .fill.hp span { background:linear-gradient(90deg,#9a2230,#e0566a); box-shadow:0 0 10px rgba(224,86,106,.5); }

  /* map = the hero: a square that fills all remaining stage height */
  .map-wrap { position:relative; flex:1 1 auto; min-height:0; display:grid; place-items:center; overflow:hidden; }
  .map-frame { position:relative; width:min(100%, calc(100dvh - 96px)); aspect-ratio:1/1; padding:8px;
    border-style:solid; border-width:22px; border-color:transparent; border-image:var(--frame) 22 fill / 22px / 0 stretch; }
  canvas#play { width:100%; height:100%; display:block; background:#0e0a04; border-radius:4px; image-rendering:pixelated; touch-action:none; cursor:crosshair; }
  body.in-combat canvas#play { cursor:default; }
  .map-badge { position:absolute; left:18px; top:18px; z-index:3; font-family:var(--display); font-weight:700; font-size:10px; letter-spacing:2px; text-transform:uppercase;
    color:#fff3da; padding:5px 11px; border-radius:7px; background:rgba(40,24,8,.74); box-shadow:0 0 0 1px rgba(202,164,90,.4); pointer-events:none; }
  .map-badge::after { content:"Exploring"; }
  body.in-combat .map-badge { color:#ffd9c0; box-shadow:0 0 0 1px rgba(224,86,106,.55), 0 0 16px rgba(224,86,106,.3); }
  body.in-combat .map-badge::after { content:"⚔ Battle"; }
  /* note ribbon overlaid on the map's lower-left (stays clear of the D-pad) */
  .note-ribbon { position:absolute; left:18px; bottom:18px; max-width:min(58%, 460px); z-index:3; pointer-events:none;
    background:linear-gradient(180deg,rgba(243,228,194,.95),rgba(228,208,160,.95)); border-radius:9px; padding:8px 13px;
    box-shadow:0 6px 16px rgba(0,0,0,.45), inset 0 0 0 1px rgba(90,58,22,.4); max-height:34%; overflow:hidden; }

  /* on-map D-pad (single, context-aware: walks the world or queues a battle step) */
  .dpad { position:absolute; right:16px; bottom:16px; z-index:3; display:grid; grid-template-columns:repeat(3,40px); grid-template-rows:repeat(3,40px); gap:4px; pointer-events:none; }
  .dpad button { pointer-events:auto; min-height:40px; min-width:40px; padding:0; font-size:15px; opacity:.92; }
  .dpad .up { grid-area:1/2; } .dpad .left { grid-area:2/1; } .dpad .right { grid-area:2/3; } .dpad .down { grid-area:3/2; }

  /* side ledger */
  .side { display:flex; flex-direction:column; gap:13px; min-height:0; max-height:100%; overflow:auto; padding-right:2px; }
  .panel { position:relative; color:var(--ink); padding:6px;
    border-style:solid; border-width:18px; border-color:transparent; border-image:var(--wood) 30 fill / 18px / 0 stretch;
    filter:drop-shadow(0 10px 20px rgba(0,0,0,.4)); }
  .sheet { border-style:solid; border-width:16px; border-color:transparent; border-image:var(--inset) 28 fill / 14px / 0 stretch; padding:10px 12px 11px; }
  .panel h2 { margin:0 0 9px; font-family:var(--display); font-weight:700; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#5a3a16;
    display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid rgba(90,58,22,.28); padding-bottom:7px; }
  .panel h2 .hint { font-family:var(--body); font-weight:400; font-size:10.5px; letter-spacing:0; text-transform:none; color:#7a5a2a; }

  .row { display:flex; gap:7px; align-items:center; }
  .row > * { flex:1; }
  .muted { color:#6b542f; font-size:12px; font-family:var(--body); }

  /* context visibility */
  .only-combat { display:none; }
  body.in-combat .only-combat { display:block; }
  body.in-combat .only-explore { display:none; }

  /* note ribbon under the map */
  #note { font-family:var(--body); font-style:italic; color:#3a2a12; white-space:pre-wrap; font-size:13.5px; line-height:1.5; min-height:24px; }

  #minimap { width:100%; height:120px; display:block; border-radius:4px; image-rendering:pixelated; background:#0e0a04; }

  /* travel */
  #travelText { margin-top:8px; min-height:18px; }

  /* combat */
  #battleControls { border-image:var(--woodDetail) 22 fill / 18px / 0 stretch; }
  .ap-line { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  #apText { font-family:var(--display); letter-spacing:.5px; font-size:12px; font-weight:700; color:#6b3f10; }
  #cardTray { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-bottom:9px; }
  #cardTray button { text-transform:none; letter-spacing:.2px; font-family:var(--body); font-size:12.5px; font-weight:600; text-align:left;
    padding:9px 10px 9px 28px; min-height:46px; color:#fff3da; }
  #cardTray button .hot { position:absolute; left:6px; top:6px; }
  #cardTray button b { color:var(--gold); font-weight:700; }
  .actbar { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:9px; }
  .actbar .wide { grid-column:1 / -1; }
  .actbar button .hot, .toolbelt button .hot, #travel .hot { margin-left:6px; }
  #weapon { font-size:12px; min-height:38px; }
  #weaponBtn { flex:0 0 auto; min-width:72px; min-height:38px; padding:8px 12px; font-size:10px; }
  #statusRow { font-family:var(--body); font-size:12px; color:#5a3f1c; display:grid; gap:3px; margin-top:8px; }
  #battleTurnText { margin-top:8px; font-size:12px; color:#6b542f; }
  .turn-track { display:grid; gap:5px; margin-top:7px; max-height:118px; overflow:auto; }
  .turn-step { border-left:3px solid rgba(90,58,22,.4); border-radius:5px; padding:5px 8px; background:rgba(255,250,235,.45); font-size:11.5px; color:#4a3318; }
  .turn-step.attack { border-left-color:#c2433f; color:#7a241f; background:rgba(224,86,106,.12); }
  .turn-step.advance { border-left-color:#c08a1a; color:#6b4a10; }
  .turn-step.rest { border-left-color:#7a6a4a; }
  .turn-slot { display:inline-flex; align-items:center; justify-content:center; min-width:48px; height:30px; margin:0 5px 5px 0; border:1px solid rgba(90,58,22,.4); border-radius:6px; background:rgba(255,250,235,.4); font-size:11.5px; color:#6b542f; }
  .turn-slot.filled { border-color:#c08a1a; color:#6b3f10; font-weight:700; box-shadow:0 0 8px rgba(192,138,26,.25); }
  .log-label { font-family:var(--display); font-size:10px; letter-spacing:2px; text-transform:uppercase; color:#7a5a2a; margin-top:11px; }
  #battleLog { margin-top:5px; max-height:118px; overflow:auto; font-family:var(--body); font-size:12px; line-height:1.55; border-radius:6px; padding:7px 9px; background:rgba(30,18,6,.5); color:#e8dcc0; box-shadow:inset 0 0 18px rgba(0,0,0,.45); }
  #battleLog .log-turn { color:#caa45a !important; }

  /* tabs / lists */
  .tabs { display:flex; gap:6px; margin-bottom:9px; }
  .tabs button { flex:1; min-height:38px; padding:8px 6px; font-size:10px; }
  .tabs button.active { background-image:var(--btnBlue); color:#eaf4ff; }
  .list { display:flex; flex-direction:column; max-height:188px; overflow:auto; }
  .item { display:grid; grid-template-columns:1fr auto; gap:10px; align-items:center; border-top:1px solid rgba(90,58,22,.22); padding:8px 2px; font-size:13px; font-family:var(--body); color:#4a3318; }
  .item:first-child { border-top:0; }
  .item button { min-height:34px; padding:6px 12px; }

  /* keyboard legend */
  details.keys { padding:6px; border-style:solid; border-width:18px; border-color:transparent; border-image:var(--wood) 30 fill / 18px / 0 stretch; }
  details.keys > summary { cursor:pointer; list-style:none; font-family:var(--display); font-weight:700; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#5a3a16; }
  details.keys > summary::-webkit-details-marker { display:none; }
  details.keys[open] > summary { margin-bottom:8px; border-bottom:1px solid rgba(90,58,22,.28); padding-bottom:7px; }
  .keys .klist { display:grid; grid-template-columns:1fr 1fr; gap:5px 12px; font-size:12px; color:#4a3318; }
  .keys .klist div { display:flex; align-items:center; gap:6px; }

  @media (max-width: 880px) {
    .app { grid-template-columns:1fr; height:auto; min-height:100dvh; }
    .stage { min-height:70dvh; }
    .hudbar { flex-wrap:wrap; }
    .vitals { order:3; flex-basis:100%; max-width:none; }
    .map-frame { width:min(100%, 70dvh); }
    .side { max-height:none; overflow:visible; }
  }
  @media (prefers-reduced-motion: reduce) { .fill span { transition:none; } }
</style>
</head>
<body>
<main class="app">
  <section class="stage">
    <div class="hudbar">
      <div class="brand"><span class="sigil">₿</span><div><h1>SATSCAPE</h1><div class="tagline">Adventurer's Ledger</div></div></div>
      <div class="vitals">
        <div class="bar"><label><span>Health</span><span id="hpText">0/0</span></label><div class="fill hp"><span id="hpFill"></span></div></div>
        <div class="bar"><label><span>Stamina</span><span id="stText">0%</span></label><div class="fill"><span id="stFill"></span></div></div>
      </div>
      <div class="toolbelt">
        <button id="eat" title="Eat bread to restore stamina (E)">Eat <kbd>E</kbd></button>
        <button id="refresh" title="Refresh the realm (R)">↻ <kbd>R</kbd></button>
        <div class="coords" id="coords">loading</div>
      </div>
    </div>
    <div class="map-wrap">
      <div class="map-frame">
        <div class="map-badge"></div>
        <canvas id="play" width="512" height="512"></canvas>
        <div class="dpad">
          <button class="sq up" data-move="up" title="North (W / ↑)">▲</button>
          <button class="sq left" data-move="left" title="West (A / ←)">◀</button>
          <button class="sq right" data-move="right" title="East (D / →)">▶</button>
          <button class="sq down" data-move="down" title="South (S / ↓)">▼</button>
        </div>
      </div>
      <div class="note-ribbon"><div id="note">Opening SatScape…</div></div>
    </div>
  </section>
  <aside class="side">
    <!-- COMBAT: shown only while fighting -->
    <div class="panel only-combat" id="battleControls">
      <div class="sheet">
        <h2>Battle <span class="hint" id="battleTurnText"></span></h2>
        <div class="ap-line"><span id="apText"></span></div>
        <div id="battlePlan"></div>
        <div id="cardTray"></div>
        <div class="row"><select id="weapon"></select><button id="weaponBtn">Ready</button></div>
        <div class="actbar">
          <button id="resolve" class="primary wide">Resolve <kbd>↵</kbd></button>
          <button id="undo">Undo <kbd>Z</kbd></button>
          <button id="wait">Wait <kbd>Q</kbd></button>
          <button id="flee" class="danger wide">Flee <kbd>F</kbd></button>
        </div>
        <div id="statusRow"></div>
        <div class="turn-track" id="monsterPlan"></div>
        <div class="log-label">Battle Log</div>
        <div id="battleLog"></div>
      </div>
    </div>

    <!-- EXPLORING: hidden during combat -->
    <div class="panel only-explore"><div class="sheet">
      <h2>The Known World <span class="hint">hold <kbd>M</kbd> for atlas</span></h2>
      <canvas id="minimap" width="320" height="118"></canvas>
    </div></div>
    <div class="panel only-explore"><div class="sheet">
      <h2>Fast Travel <span class="hint">click a tile in range</span></h2>
      <div id="travelText" class="muted">Click anywhere on the map to set a destination.</div>
      <input id="tx" type="hidden"><input id="ty" type="hidden">
      <label style="display:flex;align-items:center;gap:7px;margin-top:8px;font-size:12.5px;cursor:pointer;color:#5a3f1c">
        <input id="instantTravel" type="checkbox" style="cursor:pointer"> One-click travel <span class="hint">skip confirm</span>
      </label>
      <button id="travel" class="primary" style="width:100%;margin-top:8px" disabled>Travel</button>
    </div></div>
    <div class="panel only-explore"><div class="sheet">
      <h2>Provisions</h2>
      <div class="row"><input id="hpInput" type="number" min="0" step="1" placeholder="sats"><button id="refill" class="primary">Refill HP</button></div>
      <div class="muted" id="bankText" style="margin-top:7px"></div>
    </div></div>
    <div class="panel only-explore"><div class="sheet">
      <div class="tabs"><button id="tabGear">Gear</button><button id="tabShop">Shop</button><button id="tabQuests">Quests</button></div>
      <div class="list" id="list"></div>
    </div></div>

    <details class="keys">
      <summary>Keyboard</summary>
      <div class="klist">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</div>
        <div><kbd>M</kbd> Atlas (hold)</div>
        <div><kbd>E</kbd> Eat</div>
        <div><kbd>R</kbd> Refresh</div>
        <div><kbd>1</kbd>–<kbd>9</kbd> Cards</div>
        <div><kbd>↵</kbd> Resolve</div>
        <div><kbd>Q</kbd> Wait</div>
        <div><kbd>Z</kbd> Undo</div>
        <div><kbd>F</kbd> Flee</div>
        <div><span class="muted">click map</span> Travel</div>
      </div>
    </details>
  </aside>
</main>
<script>
(function(){
  var token = new URLSearchParams(location.search).get("t") || localStorage.getItem("satscapeToken") || "";
  if (token) localStorage.setItem("satscapeToken", token);
  var state = null, activeTab = location.hash === "#quests" ? "quests" : location.hash === "#shop" ? "shop" : "gear";
  var showWorldMap = false, battleAnimStart = performance.now(), lastCombatKey = "";
  var BREAD_STAMINA = ${SAT.BREAD_STAMINA}; // mirrors server SAT.BREAD_STAMINA — lets us cost a trip locally, no round-trip
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
    // Match battle.ts simulateBattle: attack cards auto-orient toward the monster's
    // destination for this tick, so a tick-3 card uses intent 3 rather than the
    // start of tick 3 (which is where intent 2 ended).
    function monTargetAt(m, k){
      var its = m.intents || [], it = its[k];
      if(it && it.to) return { x:it.to.x, y:it.to.y };
      return { x:m.x, y:m.y };
    }
    function monBlockerAt(m, k){
      var its = m.intents || [], it = its[k];
      if(it && it.from) return { x:it.from.x, y:it.from.y };
      return { x:m.x, y:m.y };
    }
    var ppos = { x:c.player.x, y:c.player.y };
    var attacks = [];
    for(var k=0;k<plan.length;k++){
      var a = plan[k];
      var monTargets = mons.map(function(m){ return monTargetAt(m, k); });
      if(a.kind === "move"){
        var d = DELTA[a.dir];
        if(d){
          var nx = clampA(ppos.x+d.x), ny = clampA(ppos.y+d.y), blocked = false;
          var blockers = mons.map(function(m){ return monBlockerAt(m, k); });
          for(var b=0;b<blockers.length;b++){ if(blockers[b].x===nx && blockers[b].y===ny){ blocked = true; break; } }
          if(!blocked) ppos = { x:nx, y:ny };
        }
      } else if(a.kind === "card"){
        var card = kitCard(c, a.cardId);
        if(card && card.kind !== "buff" && card.shape && monTargets.length){
          var tgt = null, bd = Infinity;
          for(var i=0;i<monTargets.length;i++){ var dd = Math.abs(monTargets[i].x-ppos.x)+Math.abs(monTargets[i].y-ppos.y); if(dd<bd){ bd = dd; tgt = monTargets[i]; } }
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
      document.querySelectorAll("[data-move]").forEach(function(b){ b.disabled = false; });
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
    document.querySelectorAll("[data-move]").forEach(function(b){ b.disabled = noTicks || remainingAp < 1; });
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
    ((state.combat && state.combat.kit) || []).forEach(function(card, idx){
      var b = document.createElement("button");
      var hot = idx < 9 ? '<span class="hot"><kbd>' + (idx + 1) + '</kbd></span>' : '';
      b.innerHTML = hot + card.emoji + " " + card.name + " <b>" + card.apCost + "⚡</b>";
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
  function render(){ if(!state || state.error) return; document.body.classList.toggle("in-combat", !!state.combat); if(showWorldMap) drawExpandedMap(); else if(state.combat) drawBattle(); else drawMap(); drawMinimap(); renderPanels(); }
  // One context-aware D-pad: walks the overworld, or queues a battle step when fighting.
  document.querySelectorAll("[data-move]").forEach(function(b){ b.onclick=function(){ var d=b.dataset.move; if(state && state.combat) battleQueue({ kind:"move", dir:d }, { action:"move", dir:d }); else act("/satscape/api/move", { dir:d }); }; });
  document.getElementById("eat").onclick=function(){ act("/satscape/api/eat", {}); };
  document.getElementById("refresh").onclick=function(){ api("/satscape/api/state?full=1").then(setState).catch(function(e){ note.textContent=e.message; }); };
  document.getElementById("refill").onclick=function(){ act("/satscape/api/refill-hp", { sats:Number(document.getElementById("hpInput").value || 0) }); };
  document.getElementById("weaponBtn").onclick=function(){ act("/satscape/api/battle", { action:"weapon", itemId:document.getElementById("weapon").value }); };
  document.getElementById("wait").onclick=function(){ battleQueue({ kind:"wait" }, { action:"wait" }); };
  document.getElementById("undo").onclick=function(){ battleUndo(); };
  document.getElementById("resolve").onclick=function(){ resolveBattle(); };
  document.getElementById("flee").onclick=function(){ act("/satscape/api/battle", { action:"flee" }); };
  var travelBtn = document.getElementById("travel");
  travelBtn.onclick=function(){ if(travelBtn.disabled) return; act("/satscape/api/travel", { tx:Number(document.getElementById("tx").value), ty:Number(document.getElementById("ty").value) }); };
  // One-click-travel toggle: persisted so it survives reloads.
  var instantChk = document.getElementById("instantTravel");
  try { instantChk.checked = localStorage.getItem("satscape:instantTravel") === "1"; } catch(e){}
  instantChk.onchange = function(){ try { localStorage.setItem("satscape:instantTravel", instantChk.checked ? "1" : "0"); } catch(e){} };
  // Cost a trip locally — same Manhattan/bread math the server uses — so the estimate
  // is instant on click instead of waiting on a round-trip.
  function costTrip(x, y){
    var p = state.player;
    var steps = Math.abs(x - p.x) + Math.abs(y - p.y);
    var bread = Math.ceil(Math.max(0, steps - p.stamina) / BREAD_STAMINA);
    return steps + " steps, " + bread + " bread, " + bread + " sats.";
  }
  // Click-to-travel: clicking a reachable tile shows the local cost and arms Travel —
  // or, with one-click-travel on, departs immediately.
  play.addEventListener("click", function(e){
    if(!state || state.combat || showWorldMap) return;
    var r = play.getBoundingClientRect(), b = state.viewport.bounds;
    var x = Math.floor((e.clientX - r.left) / r.width * 16) + b.minX;
    var y = Math.floor((e.clientY - r.top) / r.height * 16) + b.minY;
    document.getElementById("tx").value = String(x);
    document.getElementById("ty").value = String(y);
    var rad = state.player.travelRadius || 0;
    var reach = Math.max(Math.abs(x - state.player.x), Math.abs(y - state.player.y));
    if(reach > rad){
      travelBtn.disabled = true; travelBtn.textContent = "Travel";
      document.getElementById("travelText").textContent = "(" + x + ", " + y + ") is beyond your reach (" + (rad*2+1) + "×" + (rad*2+1) + " around you).";
      return;
    }
    if(instantChk.checked){
      document.getElementById("travelText").textContent = costTrip(x, y);
      act("/satscape/api/travel", { tx:x, ty:y });
      return;
    }
    travelBtn.disabled = false; travelBtn.textContent = "Travel → (" + x + ", " + y + ")";
    document.getElementById("travelText").textContent = costTrip(x, y);
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>SatScape · World Map</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&family=Spectral:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --frame: url("${UI.frameMap}");
    --wood: url("${UI.panelWoodPlain}");
    --woodDetail: url("${UI.panelWood}");
    --inset: url("${UI.panelInset}");
    --banner: url("${UI.banner}");
    --btn: url("${UI.btn}");
    --btnDown: url("${UI.btnPressed}");
    --ink:#2a1c10; --parch:#f3e4c2; --parch-deep:#e6d2a4; --gold:#f6e3a6;
    --display:'Cinzel',Georgia,serif; --body:'Spectral',Georgia,serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; color: #f2ead6; font-family: var(--body); -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(1200px 700px at 50% -10%, rgba(120,84,40,.30), transparent 60%),
      radial-gradient(900px 600px at 50% 120%, rgba(40,60,80,.18), transparent 60%),
      #14100b;
  }
  /* full-bleed map: the canvas IS the page */
  canvas#map { position:fixed; inset:0; width:100vw; height:100vh; display:block; background:#0e1622; touch-action:none; cursor:grab; z-index:0; }
  canvas#map.dragging { cursor:grabbing; }
  /* parchment-fiber grain + torch vignette float just above the map, below the HUD */
  body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.05; mix-blend-mode:overlay; z-index:1;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
  body::after { content:""; position:fixed; inset:0; pointer-events:none; z-index:1; box-shadow:inset 0 0 280px 90px rgba(0,0,0,.66); }

  /* HUD overlay — covers the viewport, only its children catch clicks */
  .hud { position:fixed; inset:0; z-index:5; pointer-events:none; }
  .hud > * { pointer-events:auto; }

  .title { position:absolute; left:18px; top:16px; display:flex; flex-direction:column; align-items:flex-start; gap:4px; }
  .banner {
    position:relative; padding:10px 26px 12px; text-align:center;
    border-style:solid; border-width:20px 52px; border-color:transparent;
    border-image: var(--banner) 22 56 fill / 20px 52px / 0 stretch;
    filter: drop-shadow(0 8px 16px rgba(0,0,0,.55));
  }
  h1 { margin:0; font-family:var(--display); font-weight:800; font-size:clamp(18px,2.6vw,26px); letter-spacing:5px;
    color:#fff5df; text-shadow:0 2px 0 #6e2b25, 0 0 18px rgba(0,0,0,.35); }
  .meta { font-family:var(--display); font-size:11px; letter-spacing:2.5px; text-transform:uppercase; color:var(--gold);
    text-shadow:0 1px 3px rgba(0,0,0,.8); padding-left:6px; }

  /* compass + zoom controls dock, bottom-left */
  .dock { position:absolute; left:18px; bottom:18px; display:flex; align-items:flex-end; gap:14px; }
  .compass { position:relative; width:96px; height:96px; pointer-events:none; filter: drop-shadow(0 4px 8px rgba(0,0,0,.6)); opacity:.95; }
  .compass span { position:absolute; width:28px; height:28px; background-size:100% 100%; background-repeat:no-repeat; }
  .compass .c-hub { left:34px; top:34px; width:28px; height:28px; border-radius:50%;
    background:radial-gradient(circle at 38% 32%, #fbe8a8, #b8861f 60%, #5a3c10); box-shadow:0 0 0 2px rgba(0,0,0,.4), 0 0 12px rgba(246,227,166,.5); }
  .compass .c-n { left:34px; top:0;  background-image:url("${UI.compassN}"); }
  .compass .c-s { left:34px; bottom:0; background-image:url("${UI.compassS}"); }
  .compass .c-w { left:0;  top:34px; background-image:url("${UI.compassW}"); }
  .compass .c-e { right:0; top:34px; background-image:url("${UI.compassE}"); }
  .controls { display:flex; flex-direction:column; gap:8px; }
  .ctl { width:44px; height:44px; border:0; cursor:pointer; background:transparent; background-image:var(--btn);
    background-size:100% 100%; background-repeat:no-repeat; color:#fff3da; font-family:var(--display); font-weight:700; font-size:20px;
    text-shadow:0 1px 2px rgba(0,0,0,.6); display:grid; place-items:center; transition:filter .12s; }
  .ctl:hover { filter:brightness(1.12); }
  .ctl:active { background-image:var(--btnDown); transform:translateY(1px); }
  .ctl.wide { width:auto; padding:0 12px; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; }

  /* right ledger rail, floating over the map */
  .rail { position:absolute; right:14px; top:16px; bottom:16px; width:262px; display:flex; flex-direction:column; gap:12px; overflow:auto; padding-right:2px; }
  .rail.collapsed { transform:translateX(calc(100% + 18px)); }
  .rail-toggle { position:absolute; top:24px; right:286px; width:34px; height:46px; border:0; cursor:pointer; z-index:6;
    background:var(--btn) center/100% 100% no-repeat; color:#fff3da; font-family:var(--display); font-weight:700; font-size:16px;
    text-shadow:0 1px 2px rgba(0,0,0,.6); transition:right .25s; }
  .rail.collapsed ~ .rail-toggle, .hud .rail-toggle.shifted { right:14px; }
  .panel { position:relative; padding:10px; color:#3a2a14; border-style:solid; border-width:18px; border-color:transparent;
    border-image: var(--wood) 30 fill / 18px / 0 stretch; filter: drop-shadow(0 10px 20px rgba(0,0,0,.5)); }
  .panel .sheet { border-style:solid; border-width:16px; border-color:transparent; border-image: var(--inset) 28 fill / 16px / 0 stretch; padding:6px 8px 4px; }
  .panel h2 { margin:0 0 10px; font-family:var(--display); font-weight:700; font-size:13px; letter-spacing:2px; text-transform:uppercase;
    color:#5a3a16; border-bottom:1px solid rgba(90,58,22,.3); padding-bottom:7px; }

  .stat { display:flex; align-items:baseline; justify-content:space-between; padding:5px 0; font-family:var(--body); font-size:14px; color:#4a3318; }
  .stat .v { font-family:var(--display); font-weight:700; font-size:18px; color:#7a4a14; }

  .legend { display:grid; gap:9px; }
  .legend .row { display:flex; align-items:center; gap:10px; font-size:13.5px; color:#4a3318; }
  .legend .ico { width:18px; height:18px; flex:none; background-size:contain; background-repeat:no-repeat; background-position:center; }
  .legend .ring { width:18px; height:18px; border:2px solid #9a6a2c; border-radius:50%; background:rgba(154,106,44,.12); }
  .legend .swatch { width:16px; height:16px; flex:none; border-radius:3px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.25); }

  .roster { display:flex; flex-direction:column; gap:7px; max-height:38vh; overflow:auto; }
  .who { display:grid; grid-template-columns:auto 1fr auto; gap:9px; align-items:center; font-size:13px; color:#3f2c12; }
  .who .dot { width:11px; height:11px; border-radius:50%; box-shadow:0 0 0 2px rgba(0,0,0,.25); }
  .who .nm { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .who .hp { font-family:var(--display); font-size:11px; color:#7a4a14; }
  .who.combat .nm::after { content:" ⚔"; color:#b4341f; }
  .empty { font-style:italic; color:#6b542f; font-size:13px; }

  .hint { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); white-space:nowrap; text-align:center; color:#d9c89a; font-style:italic; font-size:12px; font-family:var(--body);
    background:rgba(20,12,6,.5); padding:5px 14px; border-radius:999px; text-shadow:0 1px 2px rgba(0,0,0,.7); }

  @media (max-width: 720px) {
    .rail { width:200px; top:auto; bottom:90px; max-height:46vh; }
    .rail-toggle { right:224px; }
    .title .banner { border-width:18px 40px; }
    .dock { gap:8px; }
  }
</style>
</head>
<body>
  <canvas id="map" width="900" height="640"></canvas>
  <div class="hud">
    <div class="title">
      <div class="banner"><h1>SATSCAPE</h1></div>
      <div class="meta" id="meta">charting the realm…</div>
    </div>
    <aside class="rail" id="rail">
      <div class="panel"><div class="sheet">
        <h2>The Realm</h2>
        <div class="stat"><span>Adventurers afield</span><span class="v" id="sPlayers">—</span></div>
        <div class="stat"><span>In battle</span><span class="v" id="sCombat">—</span></div>
        <div class="stat"><span>Tiles charted</span><span class="v" id="sTiles">—</span></div>
        <div class="stat"><span>Townships</span><span class="v" id="sTowns">—</span></div>
      </div></div>
      <div class="panel"><div class="sheet">
        <h2>Legend</h2>
        <div class="legend">
          <div class="row"><span class="ico" style="background-image:url('${UI.iconStar}')"></span> Township</div>
          <div class="row"><span class="ring"></span> Safe territory</div>
          <div class="row"><span class="ico" style="background-image:url('${UI.iconJewelRed}')"></span> Adventurer</div>
          <div class="row"><span class="ico" style="background-image:url('${UI.iconExcl}')"></span> In battle</div>
        </div>
      </div></div>
      <div class="panel"><div class="sheet">
        <h2>Adventurers</h2>
        <div class="roster" id="roster"><div class="empty">Listening for travellers…</div></div>
      </div></div>
    </aside>
    <button class="rail-toggle" id="railToggle" title="Hide panel">⟩</button>
    <div class="dock">
      <div class="compass"><span class="c-n"></span><span class="c-e"></span><span class="c-s"></span><span class="c-w"></span><span class="c-hub"></span></div>
      <div class="controls">
        <button class="ctl" id="zin" title="Zoom in">+</button>
        <button class="ctl" id="zout" title="Zoom out">−</button>
        <button class="ctl wide" id="recenter" title="Recenter">Home</button>
      </div>
    </div>
    <p class="hint">Drag to pan · scroll to zoom · live every 2s</p>
  </div>
<script>
(function () {
  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var meta = document.getElementById("meta");
  var roster = document.getElementById("roster");
  var state = { towns: [], terrainColors: {}, explored: [], exploredKeys: {}, players: [] };
  var scale = 3, ox = 0, oy = 0, dragging = false, lastX = 0, lastY = 0;
  var biomeGrid = null;

  // Sprite markers from the Kenney pack, drawn onto the canvas once loaded.
  var sprites = {};
  function loadSprite(name, src) { var im = new Image(); im.onload = function(){ draw(); }; im.src = src; sprites[name] = im; }
  loadSprite("ring", "${UI.ringTown}");
  loadSprite("star", "${UI.iconStar}");
  loadSprite("player", "${UI.iconJewelRed}");
  loadSprite("combat", "${UI.iconExcl}");
  function ready(im) { return im && im.complete && im.naturalWidth; }

  fetch("/satscape/chunks/world.json")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var binary = atob(data.biome);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
      biomeGrid = bytes;
      draw();
    }).catch(function(e) { console.error("Failed to load biomeGrid:", e); });

  // Full-viewport backing store, crisp on HiDPI.
  function fit() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    draw();
  }

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
  function color(t) { return state.terrainColors[t] || "#3a2c1a"; }
  function key(x, y) { return x + "," + y; }
  function isExplored(x, y) { return !!state.exploredKeys[key(x, y)]; }

  function draw() {
    var W = canvas.width, H = canvas.height;
    // unexplored = aged-parchment void
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#191207"); g.addColorStop(1, "#0e0a04");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (!state.towns.length) return;
    var cxp = W / 2 + ox, cyp = H / 2 + oy;
    var minTX = Math.floor((0 - cxp) / scale - 0.5), maxTX = Math.ceil((W - cxp) / scale + 0.5);
    var minTY = Math.floor((0 - cyp) / scale - 0.5), maxTY = Math.ceil((H - cyp) / scale + 0.5);
    for (var ty = minTY; ty <= maxTY; ty++) for (var tx = minTX; tx <= maxTX; tx++) {
      if (!isExplored(tx, ty)) continue;
      ctx.fillStyle = color(biomeAt(tx, ty));
      ctx.fillRect(cxp + (tx - 0.5) * scale, cyp + (ty - 0.5) * scale, scale + 1, scale + 1);
    }

    // town territories: pack ring sprite scaled to the safe radius, with a star at the heart
    state.towns.forEach(function (t) {
      if (!isExplored(t.cx, t.cy)) return;
      var c = worldToScreen(t.cx, t.cy);
      var d = Math.max(28, t.safeRadius * scale * 2 + 8);
      if (ready(sprites.ring)) ctx.drawImage(sprites.ring, c[0] - d / 2, c[1] - d / 2, d, d);
      else { ctx.strokeStyle = "#caa45a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c[0], c[1], t.safeRadius * scale, 0, Math.PI * 2); ctx.stroke(); }
      var ss = 22;
      if (ready(sprites.star)) ctx.drawImage(sprites.star, c[0] - ss / 2, c[1] - ss / 2, ss, ss);
      label(t.name, c[0], c[1] - d / 2 - 4, "#fff0c8", "rgba(40,24,8,.72)", true);
    });

    // adventurers
    state.players.forEach(function (p) {
      if (!isExplored(p.x, p.y)) return;
      var s = worldToScreen(p.x, p.y);
      var combat = p.state === "combat";
      var im = combat ? sprites.combat : sprites.player;
      var iw = combat ? 14 : 18, ih = combat ? 26 : 18;
      if (ready(im)) ctx.drawImage(im, s[0] - iw / 2, s[1] - ih / 2, iw, ih);
      else { ctx.fillStyle = combat ? "#f97316" : "#f43f5e"; ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill(); }
      label(p.name + "  " + p.hpPct + "%", s[0] + 12, s[1] - 8, "#fdf3df", "rgba(40,24,8,.7)", false);
    });
  }

  function label(text, x, y, fg, bg, center) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.font = "600 " + Math.round(12 * dpr) + "px 'Spectral', Georgia, serif";
    ctx.textAlign = center ? "center" : "left";
    ctx.textBaseline = "middle";
    var tw = ctx.measureText(text).width;
    var padX = 6 * dpr, h = 18 * dpr;
    var bx = center ? x - tw / 2 - padX : x - padX;
    ctx.fillStyle = bg;
    roundRect(bx, y - h / 2, tw + padX * 2, h, 5 * dpr); ctx.fill();
    ctx.strokeStyle = "rgba(202,164,90,.5)"; ctx.lineWidth = dpr; ctx.stroke();
    ctx.fillStyle = fg; ctx.fillText(text, x, y);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function renderRoster() {
    var ps = state.players || [];
    if (!ps.length) { roster.innerHTML = '<div class="empty">No adventurers afield right now.</div>'; return; }
    var sorted = ps.slice().sort(function (a, b) { return b.hpPct - a.hpPct; });
    roster.innerHTML = sorted.map(function (p) {
      var combat = p.state === "combat";
      var dot = combat ? "#e0662b" : "#c2433f";
      return '<div class="who ' + (combat ? "combat" : "") + '">' +
        '<span class="dot" style="background:' + dot + '"></span>' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="hp">' + p.hpPct + '%</span></div>';
    }).join("");
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function fetchPlayers() {
    fetch("/api/satscape/players").then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.players) {
        state = d; state.exploredKeys = {};
        (state.explored || []).forEach(function (tile) { state.exploredKeys[key(tile.x, tile.y)] = true; });
        var combat = state.players.filter(function (p) { return p.state === "combat"; }).length;
        var n = state.players.length;
        meta.textContent = n + " adventurer" + (n === 1 ? "" : "s") + " · " + (state.explored || []).length + " tiles charted";
        document.getElementById("sPlayers").textContent = n;
        document.getElementById("sCombat").textContent = combat;
        document.getElementById("sTiles").textContent = (state.explored || []).length.toLocaleString();
        document.getElementById("sTowns").textContent = (state.towns || []).length;
        renderRoster();
      }
      draw();
    }).catch(function () { meta.textContent = "the realm is offline"; });
  }

  function zoom(factor) { scale = Math.max(2, Math.min(40, scale * factor)); draw(); }
  document.getElementById("zin").addEventListener("click", function () { zoom(1.25); });
  document.getElementById("zout").addEventListener("click", function () { zoom(0.8); });
  document.getElementById("recenter").addEventListener("click", function () { ox = 0; oy = 0; scale = 3; draw(); });
  (function(){ var rail = document.getElementById("rail"), tg = document.getElementById("railToggle");
    tg.addEventListener("click", function(){ var c = rail.classList.toggle("collapsed"); tg.textContent = c ? "⟨" : "⟩"; tg.title = c ? "Show panel" : "Hide panel"; }); })();

  canvas.addEventListener("mousedown", function (e) { dragging = true; canvas.classList.add("dragging"); lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener("mouseup", function () { dragging = false; canvas.classList.remove("dragging"); });
  window.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ox += (e.clientX - lastX) * dpr; oy += (e.clientY - lastY) * dpr; lastX = e.clientX; lastY = e.clientY; draw();
  });
  canvas.addEventListener("wheel", function (e) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
  // touch pan
  canvas.addEventListener("touchstart", function (e) { if (e.touches.length === 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; } }, { passive: true });
  canvas.addEventListener("touchmove", function (e) {
    if (!dragging || e.touches.length !== 1) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ox += (e.touches[0].clientX - lastX) * dpr; oy += (e.touches[0].clientY - lastY) * dpr;
    lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; draw();
  }, { passive: true });
  canvas.addEventListener("touchend", function () { dragging = false; });

  window.addEventListener("resize", fit);
  fit();
  fetchPlayers(); setInterval(fetchPlayers, 2000);
})();
</script>
</body>
</html>`;

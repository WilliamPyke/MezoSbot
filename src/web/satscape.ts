import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { supabase } from "../db.js";
import { biomeAt, SAT } from "../satscape/engine.js";
import {
  ATTACK_MODES,
  monsterPlan,
  parsePlan,
  projectedPlayerPos,
  selectedWeaponId,
  weaponFor,
  type AttackMode,
  type BattleMove,
} from "../satscape/battle.js";
import { effectiveHp, getPlayer, loadView } from "../satscape/db.js";
import {
  battleMove,
  buyItem,
  eat,
  equipItem,
  estimateTravel,
  flee,
  moveMany,
  queueStrike,
  queueWait,
  refillHp,
  resolvePlan,
  selectBattleWeapon,
  travelTo,
  undoPlanAction,
} from "../satscape/game.js";
import { acceptQuest, claimQuest, getRep, payTribute, questBoard } from "../satscape/quests.js";
import { ALL_ITEMS, effectivePrice, TERRAIN_COLOR, townAt, TOWNS } from "../satscape/towns.js";
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
    await respond(req, res, async (claim) => buildStateResponse(claim.userId));
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
      if (action === "strike") return queueStrike(claim.userId, (body.mode as AttackMode | undefined) ?? "line");
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

async function buildStateResponse(userId: string, note?: string): Promise<Record<string, unknown>> {
  const view = await loadView(userId);
  if (!view || !view.player.active) return { error: "Use /satscape join first." };
  const worldExplored = await loadExploredTilesCached();
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
      explored: worldExplored,
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
  return {
    monster: {
      name: combat.monster_name,
      level: combat.monster_level,
      hp: combat.monster_current_hp,
      maxHp: combat.monster_max_hp,
      attack: combat.monster_attack,
      reward: combat.reward_sats,
      x: combat.monster_battle_x,
      y: combat.monster_battle_y,
    },
    player: { x: combat.player_battle_x, y: combat.player_battle_y },
    turn: combat.turn_number,
    plan,
    projected: projectedPlayerPos(combat, plan),
    intents: monsterPlan(combat, view.player),
    attackModes: ATTACK_MODES,
    weapon,
    selectedWeaponId: selectedWeaponId(combat, view.player),
  };
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
    return { status: 200, body: { ...result, state: await buildStateResponse(claim.userId, result.note) } };
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
<title>SatScape Play</title>
<style>
  :root { color-scheme: dark; --bg:#10151c; --panel:#18212b; --line:#2a3644; --text:#edf2f7; --muted:#9aa8b7; --accent:#4ade80; --danger:#fb7185; --gold:#facc15; }
  * { box-sizing: border-box; }
  html, body { min-height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,Segoe UI,Arial,sans-serif; }
  button, input, select { font: inherit; }
  button { border:1px solid var(--line); background:#223040; color:var(--text); border-radius:6px; padding:7px 9px; cursor:pointer; }
  button:hover { border-color:#52657a; }
  button.primary { background:#166534; border-color:#22c55e; }
  button.danger { background:#5f1f2b; border-color:#fb7185; }
  input, select { width:100%; border:1px solid var(--line); background:#111820; color:var(--text); border-radius:6px; padding:7px; }
  .app { display:grid; grid-template-columns:minmax(380px, 560px) 340px; justify-content:center; gap:10px; min-height:100dvh; padding:10px; }
  .stage, .side { min-width:0; }
  .top { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
  h1 { margin:0; font-size:18px; letter-spacing:0; }
  .coords { color:var(--muted); font-size:12px; }
  .bars { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
  .bar { border:1px solid var(--line); border-radius:6px; padding:7px; background:#141c25; }
  .bar label { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; margin-bottom:5px; }
  .fill { height:8px; border-radius:999px; background:#303b48; overflow:hidden; }
  .fill span { display:block; height:100%; background:var(--accent); }
  .fill.hp span { background:#fb7185; }
  canvas { width:100%; max-height:calc(100dvh - 104px); display:block; background:#080c12; border:1px solid var(--line); border-radius:8px; image-rendering:pixelated; touch-action:none; aspect-ratio:1/1; }
  #minimap { height:118px; max-height:118px; aspect-ratio:auto; }
  .side { display:flex; flex-direction:column; gap:8px; max-height:calc(100dvh - 20px); overflow:auto; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px; }
  .panel h2 { margin:0 0 6px; font-size:13px; }
  .grid4 { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
  .grid4 .up { grid-column:2; }.grid4 .left { grid-column:1; }.grid4 .down { grid-column:2; }.grid4 .right { grid-column:3; }
  .row { display:flex; gap:5px; align-items:center; }
  .row > * { flex:1; }
  .tabs { display:flex; gap:5px; }
  .tabs button { flex:1; padding:7px; }
  .tabs button.active { border-color:var(--accent); color:#bbf7d0; }
  .list { display:flex; flex-direction:column; gap:5px; max-height:150px; overflow:auto; }
  .item { display:grid; grid-template-columns:1fr auto; gap:7px; align-items:center; border-top:1px solid var(--line); padding-top:6px; font-size:13px; }
  .item:first-child { border-top:0; padding-top:0; }
  .muted { color:var(--muted); font-size:12px; }
  .note { min-height:34px; max-height:86px; overflow:auto; color:#dbeafe; white-space:pre-wrap; font-size:13px; }
  @media (max-width: 860px) { .app { grid-template-columns:1fr; } .side { max-height:none; overflow:visible; } canvas { max-height:none; } }
</style>
</head>
<body>
<main class="app">
  <section class="stage">
    <div class="top"><h1>SatScape</h1><div class="coords" id="coords">loading</div></div>
    <div class="bars">
      <div class="bar"><label><span>HP</span><span id="hpText">0/0</span></label><div class="fill hp"><span id="hpFill"></span></div></div>
      <div class="bar"><label><span>Stamina</span><span id="stText">0%</span></label><div class="fill"><span id="stFill"></span></div></div>
    </div>
    <canvas id="play" width="512" height="512"></canvas>
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
      <div class="row"><button data-bmove="up" title="Queue north">Up</button><button data-bmove="down" title="Queue south">Down</button><button data-bmove="left" title="Queue west">Left</button><button data-bmove="right" title="Queue east">Right</button></div>
      <div class="row" style="margin-top:6px"><select id="strikeMode"></select><button id="strike" class="primary">Strike</button></div>
      <div class="row" style="margin-top:6px"><select id="weapon"></select><button id="weaponBtn">Ready</button></div>
      <div class="row" style="margin-top:6px"><button id="wait">Wait</button><button id="undo">Undo</button><button id="resolve" class="primary">Resolve</button><button id="flee" class="danger">Flee</button></div>
    </div>
    <div class="panel">
      <h2>Travel</h2>
      <div class="row"><input id="tx" type="number" placeholder="x"><input id="ty" type="number" placeholder="y"></div>
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
  var play = document.getElementById("play"), ctx = play.getContext("2d");
  var minimap = document.getElementById("minimap"), mini = minimap.getContext("2d");
  var note = document.getElementById("note");
  function api(path, body) {
    return fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type":"application/json", "X-Satscape-Token": token }, body: body ? JSON.stringify(body) : undefined })
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || "Request failed"); return j; }); });
  }
  function setState(s) {
    state = s.state || s;
    if (s.estimate) {
      document.getElementById("travelText").textContent = s.estimate.steps + " steps, " + s.estimate.breadNeeded + " bread, " + s.estimate.satCost + " sats.";
    }
    if (s.note) note.textContent = s.note; else if (state.note) note.textContent = state.note;
    render();
  }
  function act(path, body) { api(path, body).then(setState).catch(function(e){ note.textContent = e.message; }); }
  function key(x,y){ return x + "," + y; }
  function exploredSet(){ var out={}; (state.viewport.explored||[]).forEach(function(t){ out[key(t.x,t.y)] = true; }); return out; }
  function biomeAt(x,y){
    var towns = state.viewport.towns, best = towns[0], bd = Infinity;
    towns.forEach(function(t){ var d = Math.hypot(x - t.cx, y - t.cy); if(d < bd){ bd = d; best = t; } });
    if (bd <= best.safeRadius) return "town";
    var wx = x + Math.sin(y * 0.12) * 4, wy = y + Math.cos(x * 0.12) * 4;
    var cx = Math.floor(wx / 22), cy = Math.floor(wy / 22);
    var h = Math.abs(Math.sin(cx * 1.7 * 12.9898 + cy * 2.3 * 78.233 + 99) * 43758.5453) % 1;
    return best.palette[h < 0.34 ? 0 : h < 0.67 ? 1 : 2];
  }
  function drawMap(){
    if(!state) return;
    var p = state.player, b = state.viewport.bounds, ex = exploredSet();
    var tw = play.width / 16, th = play.height / 16;
    ctx.fillStyle = "#070b11"; ctx.fillRect(0,0,play.width,play.height);
    for(var y=b.minY;y<=b.maxY;y++) for(var x=b.minX;x<=b.maxX;x++){
      var sx = (x - b.minX) * tw, sy = (y - b.minY) * th;
      if(!ex[key(x,y)]) { ctx.fillStyle = "#05070b"; }
      else { ctx.fillStyle = state.viewport.terrainColors[biomeAt(x,y)] || "#334155"; }
      ctx.fillRect(sx, sy, Math.ceil(tw), Math.ceil(th));
      ctx.strokeStyle = "rgba(15,23,42,.35)"; ctx.strokeRect(sx, sy, tw, th);
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
  }
  function drawBattle(){
    var c = state && state.combat;
    if(!c) return;
    var s = play.width / 8;
    ctx.fillStyle="#10151c"; ctx.fillRect(0,0,play.width,play.height);
    for(var y=0;y<8;y++) for(var x=0;x<8;x++){ ctx.fillStyle=(x+y)%2?"#17212c":"#1f2a36"; ctx.fillRect(x*s,y*s,s,s); ctx.strokeStyle="#304052"; ctx.strokeRect(x*s,y*s,s,s); }
    (c.intents||[]).forEach(function(intent){
      (intent.attackTiles||[]).forEach(function(t){ ctx.fillStyle="rgba(248,113,113,.55)"; ctx.fillRect(t.x*s,t.y*s,s,s); });
      ctx.fillStyle="#facc15"; ctx.font="14px sans-serif"; ctx.fillText(String(intent.order), intent.to.x*s+6, intent.to.y*s+16);
    });
    if(c.projected){
      ctx.strokeStyle="#fde047"; ctx.lineWidth=3; ctx.setLineDash([6,4]);
      ctx.beginPath(); ctx.moveTo(c.player.x*s+s/2,c.player.y*s+s/2); ctx.lineTo(c.projected.x*s+s/2,c.projected.y*s+s/2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle="#60a5fa"; ctx.beginPath(); ctx.arc(c.player.x*s+s/2,c.player.y*s+s/2,s*.28,0,Math.PI*2); ctx.fill();
    if(c.projected && (c.projected.x !== c.player.x || c.projected.y !== c.player.y)){ ctx.fillStyle="#93c5fd"; ctx.beginPath(); ctx.arc(c.projected.x*s+s/2,c.projected.y*s+s/2,s*.2,0,Math.PI*2); ctx.fill(); }
    ctx.fillStyle="#fb923c"; ctx.beginPath(); ctx.arc(c.monster.x*s+s/2,c.monster.y*s+s/2,s*.3,0,Math.PI*2); ctx.fill();
    ctx.fillStyle="#e5e7eb"; ctx.font="14px sans-serif"; ctx.fillText(c.monster.name + " " + c.monster.hp + "/" + c.monster.maxHp, 10, play.height - 12);
  }
  function drawMinimap(){
    if(!state) return;
    var tiles = state.minimap && state.minimap.explored || [];
    var p = state.player, b = state.viewport.bounds, pad = 8;
    mini.fillStyle = "#070b11"; mini.fillRect(0,0,minimap.width,minimap.height);
    if(!tiles.length) return;
    var minX=p.x, maxX=p.x, minY=p.y, maxY=p.y;
    tiles.forEach(function(t){ if(t.x<minX)minX=t.x; if(t.x>maxX)maxX=t.x; if(t.y<minY)minY=t.y; if(t.y>maxY)maxY=t.y; });
    (state.minimap.towns||[]).forEach(function(t){ if(t.cx<minX)minX=t.cx; if(t.cx>maxX)maxX=t.cx; if(t.cy<minY)minY=t.cy; if(t.cy>maxY)maxY=t.cy; });
    var sx = (minimap.width - pad*2) / Math.max(1, maxX - minX + 1);
    var sy = (minimap.height - pad*2) / Math.max(1, maxY - minY + 1);
    var scale = Math.max(1, Math.min(sx, sy));
    var ox = (minimap.width - (maxX - minX + 1) * scale) / 2;
    var oy = (minimap.height - (maxY - minY + 1) * scale) / 2;
    function mx(x){ return ox + (x - minX) * scale; }
    function my(y){ return oy + (y - minY) * scale; }
    tiles.forEach(function(t){
      var inView = t.x >= b.minX && t.x <= b.maxX && t.y >= b.minY && t.y <= b.maxY;
      mini.globalAlpha = inView ? 1 : 0.28;
      mini.fillStyle = state.viewport.terrainColors[biomeAt(t.x,t.y)] || "#334155";
      mini.fillRect(mx(t.x), my(t.y), Math.ceil(scale), Math.ceil(scale));
    });
    mini.globalAlpha = 1;
    mini.strokeStyle = "#f8fafc"; mini.lineWidth = 1.5;
    mini.strokeRect(mx(b.minX), my(b.minY), (b.maxX - b.minX + 1) * scale, (b.maxY - b.minY + 1) * scale);
    (state.minimap.towns||[]).forEach(function(t){
      mini.fillStyle = "#bfdbfe";
      mini.fillRect(mx(t.cx)-2, my(t.cy)-2, 4, 4);
    });
    mini.fillStyle = "#fb7185";
    mini.beginPath(); mini.arc(mx(p.x)+scale/2, my(p.y)+scale/2, 4, 0, Math.PI*2); mini.fill();
  }
  function renderPanels(){
    var p = state.player, needed = Math.max(0, Math.min(p.maxHp - p.hp, p.balance - p.hp));
    document.getElementById("coords").textContent = "(" + p.x + ", " + p.y + ") balance " + p.balance;
    document.getElementById("hpText").textContent = p.hp + "/" + p.maxHp;
    document.getElementById("hpFill").style.width = Math.max(0, Math.min(100, p.hp / Math.max(1,p.maxHp) * 100)) + "%";
    document.getElementById("stText").textContent = p.stamina + "%";
    document.getElementById("stFill").style.width = Math.max(0, Math.min(100, p.stamina)) + "%";
    document.getElementById("hpInput").max = String(needed);
    document.getElementById("hpInput").placeholder = String(needed);
    document.getElementById("bankText").textContent = needed > 0 ? needed + " banked sats can be committed to HP." : "No HP refill available.";
    document.getElementById("battleControls").style.opacity = state.combat ? "1" : ".45";
    var sm = document.getElementById("strikeMode"); sm.innerHTML = "";
    ((state.combat && state.combat.attackModes) || []).forEach(function(m){ var o=document.createElement("option"); o.value=m.mode; o.textContent=m.name; sm.appendChild(o); });
    var weap = document.getElementById("weapon"); weap.innerHTML = "";
    (state.inventory.items||[]).filter(function(i){ return i.slot === "weapon"; }).forEach(function(i){ var o=document.createElement("option"); o.value=i.id; o.textContent=i.name; weap.appendChild(o); });
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
  function render(){ if(!state || state.error) return; if(state.combat) drawBattle(); else drawMap(); drawMinimap(); renderPanels(); }
  document.querySelectorAll("[data-move]").forEach(function(b){ b.onclick=function(){ act("/satscape/api/move", { dir:b.dataset.move }); }; });
  document.querySelectorAll("[data-bmove]").forEach(function(b){ b.onclick=function(){ act("/satscape/api/battle", { action:"move", dir:b.dataset.bmove }); }; });
  document.getElementById("eat").onclick=function(){ act("/satscape/api/eat", {}); };
  document.getElementById("refresh").onclick=function(){ api("/satscape/api/state").then(setState).catch(function(e){ note.textContent=e.message; }); };
  document.getElementById("refill").onclick=function(){ act("/satscape/api/refill-hp", { sats:Number(document.getElementById("hpInput").value || 0) }); };
  document.getElementById("strike").onclick=function(){ act("/satscape/api/battle", { action:"strike", mode:document.getElementById("strikeMode").value || "line" }); };
  document.getElementById("weaponBtn").onclick=function(){ act("/satscape/api/battle", { action:"weapon", itemId:document.getElementById("weapon").value }); };
  document.getElementById("wait").onclick=function(){ act("/satscape/api/battle", { action:"wait" }); };
  document.getElementById("undo").onclick=function(){ act("/satscape/api/battle", { action:"undo" }); };
  document.getElementById("resolve").onclick=function(){ act("/satscape/api/battle", { action:"resolve" }); };
  document.getElementById("flee").onclick=function(){ act("/satscape/api/battle", { action:"flee" }); };
  document.getElementById("estimate").onclick=function(){ act("/satscape/api/travel", { estimate:true, tx:Number(document.getElementById("tx").value), ty:Number(document.getElementById("ty").value) }); };
  document.getElementById("travel").onclick=function(){ act("/satscape/api/travel", { tx:Number(document.getElementById("tx").value), ty:Number(document.getElementById("ty").value) }); };
  play.addEventListener("click", function(e){
    if(!state || state.combat) return;
    var r = play.getBoundingClientRect(), b = state.viewport.bounds;
    var x = Math.floor((e.clientX - r.left) / r.width * 16) + b.minX;
    var y = Math.floor((e.clientY - r.top) / r.height * 16) + b.minY;
    document.getElementById("tx").value = String(x);
    document.getElementById("ty").value = String(y);
    document.getElementById("travelText").textContent = "Target set to (" + x + ", " + y + ").";
  });
  ["Shop","Quests","Gear"].forEach(function(n){ document.getElementById("tab"+n).onclick=function(){ activeTab=n.toLowerCase(); renderList(); }; });
  function typingTarget(el){ return el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable); }
  function directionKey(e){ return { ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right", w:"up", W:"up", s:"down", S:"down", a:"left", A:"left", d:"right", D:"right" }[e.key]; }
  window.addEventListener("keydown", function(e){
    if(typingTarget(document.activeElement)) return;
    var d = directionKey(e);
    if(d){
      e.preventDefault();
      if(state && state.combat) act("/satscape/api/battle", { action:"move", dir:d });
      else act("/satscape/api/move", { dir:d });
      return;
    }
    if(!state) return;
    if(e.key === "r" || e.key === "R"){ e.preventDefault(); api("/satscape/api/state").then(setState).catch(function(err){ note.textContent=err.message; }); return; }
    if(e.key === "e" || e.key === "E"){ e.preventDefault(); act("/satscape/api/eat", {}); return; }
    if(!state.combat) return;
    if(e.key === " " || e.key === "Enter"){ e.preventDefault(); act("/satscape/api/battle", { action:"resolve" }); return; }
    if(e.key === "q" || e.key === "Q"){ e.preventDefault(); act("/satscape/api/battle", { action:"wait" }); return; }
    if(e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U"){ e.preventDefault(); act("/satscape/api/battle", { action:"undo" }); return; }
    if(e.key === "f" || e.key === "F"){ e.preventDefault(); act("/satscape/api/battle", { action:"flee" }); return; }
    var modeIndex = { "1":0, "2":1, "3":2 }[e.key];
    if(modeIndex !== undefined){
      e.preventDefault();
      var modes = state.combat.attackModes || [];
      var mode = modes[modeIndex] && modes[modeIndex].mode || "line";
      document.getElementById("strikeMode").value = mode;
      act("/satscape/api/battle", { action:"strike", mode:mode });
    }
  });
  api("/satscape/api/state").then(setState).catch(function(e){ note.textContent=e.message; });
  setInterval(function(){ api("/satscape/api/state").then(setState).catch(function(){}); }, 2000);
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
  function worldToScreen(wx, wy) { return [canvas.width / 2 + (wx * scale) + ox, canvas.height / 2 + (wy * scale) + oy]; }
  function hash01(a, b, s) { return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + s) * 43758.5453) % 1; }
  function biomeAt(x, y) {
    var best = null, bd = Infinity;
    for (var i = 0; i < state.towns.length; i++) { var t = state.towns[i]; var d = Math.hypot(x - t.cx, y - t.cy); if (d < bd) { bd = d; best = t; } }
    if (!best) return "town";
    if (bd <= best.safeRadius) return "town";
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

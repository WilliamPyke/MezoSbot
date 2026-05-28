import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { supabase } from "../db.js";
import { biomeAt } from "../satscape/engine.js";
import { TERRAIN_COLOR, TOWNS } from "../satscape/towns.js";

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

/**
 * Public, view-only companion map for SatScape. Self-contained HTML+canvas page
 * (no auth) plus a JSON feed. Fog is the shared co-op discovery state.
 *
 * Privacy: HP *is* a player's real withdrawable balance, so we never expose
 * absolute sats or discord_id — only display name, coordinates, state, and a
 * coarse HP percentage relative to the player's run high-water mark.
 */
export async function handleSatscapeWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" && url.pathname === "/satscape") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(PAGE_HTML);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/satscape/players") {
    try {
      const { data: players, error } = await supabase
        .from("sat_players")
        .select("discord_id, x_coord, y_coord, hunger, display_max_hp, state")
        .eq("active", true)
        .neq("state", "fainted");
      if (error) throw error;

      const explored = await loadExploredTiles();

      const ids = (players ?? []).map((p) => p.discord_id);
      const nameById = new Map<string, string>();
      const hpById = new Map<string, number>();
      if (ids.length > 0) {
        const { data: users } = await supabase
          .from("users")
          .select("discord_id, username, display_name, balance_sats")
          .in("discord_id", ids);
        for (const u of users ?? []) {
          nameById.set(u.discord_id, u.display_name || u.username || "Adventurer");
          hpById.set(u.discord_id, u.balance_sats ?? 0);
        }
      }

      const payload = (players ?? []).map((p) => {
        const hp = hpById.get(p.discord_id) ?? 0;
        const ref = Math.max(p.display_max_hp, hp, 1);
        return {
          name: nameById.get(p.discord_id) ?? "Adventurer",
          x: p.x_coord,
          y: p.y_coord,
          biome: biomeAt(p.x_coord, p.y_coord),
          state: p.state,
          hpPct: Math.round(Math.max(0, Math.min(1, hp / ref)) * 100),
        };
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        JSON.stringify({
          towns: TOWNS.map((t) => ({ name: t.name, cx: t.cx, cy: t.cy, safeRadius: t.safeRadius, palette: t.palette })),
          terrainColors: TERRAIN_COLOR,
          explored,
          players: payload,
        }),
      );
      return true;
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: (err as Error)?.message ?? "error" }));
      return true;
    }
  }

  return false;
}

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SatScape — Global Map</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #020617; color: #f8fafc;
         font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; }
  h1 { font-size: 18px; letter-spacing: 2px; margin: 0; font-weight: 800; }
  .meta { color: #64748b; font-size: 12px; }
  .wrap { display: flex; justify-content: center; padding: 0 16px 24px; }
  canvas { background: #020617; border: 1px solid #1e293b; border-radius: 12px;
           box-shadow: 0 20px 60px rgba(0,0,0,.5); max-width: 100%; touch-action: none; }
  .hint { text-align: center; color: #475569; font-size: 11px; padding-bottom: 24px; }
</style>
</head>
<body>
  <header>
    <h1>SATSCAPE · GLOBAL MAP</h1>
    <span class="meta" id="meta">connecting…</span>
  </header>
  <div class="wrap"><canvas id="map" width="900" height="640"></canvas></div>
  <p class="hint">Towns &amp; their territories · drag to pan · scroll to zoom · live every 2s</p>
<script>
(function () {
  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var meta = document.getElementById("meta");
  var state = { towns: [], terrainColors: {}, explored: [], exploredKeys: {}, players: [] };
  var scale = 3, ox = 0, oy = 0, dragging = false, lastX = 0, lastY = 0;

  function worldToScreen(wx, wy) {
    return [canvas.width / 2 + (wx * scale) + ox, canvas.height / 2 + (wy * scale) + oy];
  }
  // Region noise — MUST mirror server src/satscape/engine.ts biomeAt.
  var REGION_SIZE = 22;
  function hash01(a, b, s) { return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + s) * 43758.5453) % 1; }
  function biomeAt(x, y) {
    var best = null, bd = Infinity;
    for (var i = 0; i < state.towns.length; i++) {
      var t = state.towns[i]; var d = Math.hypot(x - t.cx, y - t.cy); // match server nearestTown
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return "town";
    if (bd <= best.safeRadius) return "town";
    var wx = x + Math.sin(y * 0.12) * 4, wy = y + Math.cos(x * 0.12) * 4;
    var cx = Math.floor(wx / REGION_SIZE), cy = Math.floor(wy / REGION_SIZE);
    var h = hash01(cx * 1.7, cy * 2.3, 99);
    var idx = h < 0.34 ? 0 : h < 0.67 ? 1 : 2;
    return best.palette[idx];
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
    for (var ty = minTY; ty <= maxTY; ty++) {
      for (var tx = minTX; tx <= maxTX; tx++) {
        if (!isExplored(tx, ty)) {
          ctx.fillStyle = "#060a14";
          ctx.fillRect(cxp + (tx - 0.5) * scale, cyp + (ty - 0.5) * scale, scale + 1, scale + 1);
          continue;
        }
        ctx.fillStyle = color(biomeAt(tx, ty));
        ctx.fillRect(cxp + (tx - 0.5) * scale, cyp + (ty - 0.5) * scale, scale + 1, scale + 1);
      }
    }

    // town markers
    ctx.textAlign = "center";
    state.towns.forEach(function (t) {
      if (!isExplored(t.cx, t.cy)) return;
      var c = worldToScreen(t.cx, t.cy);
      ctx.strokeStyle = "#bfdbfe"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c[0], c[1], t.safeRadius * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#e2e8f0"; ctx.font = "bold 12px monospace";
      ctx.fillText(t.name, c[0], c[1] - t.safeRadius * scale - 6);
    });

    // players
    ctx.textAlign = "left";
    state.players.forEach(function (p) {
      if (!isExplored(p.x, p.y)) return;
      var s = worldToScreen(p.x, p.y);
      ctx.fillStyle = p.state === "combat" ? "#f97316" : "#f43f5e";
      ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 1.5; ctx.stroke();
      if (p.state === "combat") { ctx.strokeStyle = "#fb923c"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, Math.PI * 2); ctx.stroke(); }
      var label = p.name + "  " + p.hpPct + "%";
      ctx.font = "11px monospace";
      var tw = ctx.measureText(label).width + 6;
      ctx.fillStyle = "rgba(2,6,23,0.7)"; ctx.fillRect(s[0] + 8, s[1] - 9, tw, 14);
      ctx.fillStyle = "#f8fafc"; ctx.fillText(label, s[0] + 11, s[1] + 2);
    });
  }

  function fetchPlayers() {
    fetch("/api/satscape/players").then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.players) {
        state = d;
        state.exploredKeys = {};
        (state.explored || []).forEach(function (tile) { state.exploredKeys[key(tile.x, tile.y)] = true; });
        meta.textContent = state.players.length + " adventurer" + (state.players.length === 1 ? "" : "s") + " - " + (state.explored || []).length + " tiles charted";
      }
      draw();
    }).catch(function () { meta.textContent = "offline"; });
  }

  canvas.addEventListener("mousedown", function (e) { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener("mouseup", function () { dragging = false; });
  window.addEventListener("mousemove", function (e) {
    if (!dragging) return; ox += e.clientX - lastX; oy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY; draw();
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault(); scale = Math.max(2, Math.min(40, scale * (e.deltaY < 0 ? 1.1 : 0.9))); draw();
  }, { passive: false });

  fetchPlayers();
  setInterval(fetchPlayers, 2000);
})();
</script>
</body>
</html>`;

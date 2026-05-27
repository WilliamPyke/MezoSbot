import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { supabase } from "../db.js";
import { SAT, biomeAt } from "../satscape/engine.js";

/**
 * Public, view-only companion map for SatScape. Served as a self-contained
 * HTML+canvas page (no auth, no wallet) plus a JSON feed of live positions.
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
          hunger: p.hunger,
        };
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ townRadius: SAT.TOWN_RADIUS, players: payload }));
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
  <p class="hint">🟦 Town · 🟩 Jungle · 🟨 Desert · ⬜ Winter · 🟪 India &nbsp;—&nbsp; drag to pan · scroll to zoom · live every 2s</p>
<script>
(function () {
  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var meta = document.getElementById("meta");
  var state = { townRadius: 15, players: [] };
  var scale = 14, ox = 0, oy = 0, dragging = false, lastX = 0, lastY = 0;

  function worldToScreen(wx, wy) {
    return [canvas.width / 2 + (wx * scale) + ox, canvas.height / 2 + (wy * scale) + oy];
  }
  // ── world generation (MUST mirror server src/satscape/engine.ts biomeAt) ──
  var TOWN_RADIUS = 15, REGION_SIZE = 22;
  function hash01(a, b, salt) {
    return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + salt) * 43758.5453) % 1;
  }
  function biomeAt(x, y) {
    if (Math.sqrt(x * x + y * y) <= TOWN_RADIUS) return "town";
    var wx = x + Math.sin(y * 0.12) * 4;
    var wy = y + Math.cos(x * 0.12) * 4;
    var cx = Math.floor(wx / REGION_SIZE), cy = Math.floor(wy / REGION_SIZE);
    var h = hash01(cx * 1.7, cy * 2.3, 99);
    if (h < 0.3) return "jungle";
    if (h < 0.55) return "desert";
    if (h < 0.78) return "winter";
    return "india";
  }
  function biomeColor(b) {
    return b === "town" ? "#1e3a8a" : b === "jungle" ? "#166534"
         : b === "desert" ? "#ca8a04" : b === "winter" ? "#cbd5e1"
         : b === "india" ? "#be185d" : "#1f2937";
  }
  function draw() {
    ctx.fillStyle = "#020617"; ctx.fillRect(0, 0, canvas.width, canvas.height);

    // terrain — fill every visible tile by biome (tiles centred on integer coords)
    var cxp = canvas.width / 2 + ox, cyp = canvas.height / 2 + oy;
    var minTX = Math.floor((0 - cxp) / scale - 0.5), maxTX = Math.ceil((canvas.width - cxp) / scale + 0.5);
    var minTY = Math.floor((0 - cyp) / scale - 0.5), maxTY = Math.ceil((canvas.height - cyp) / scale + 0.5);
    for (var ty = minTY; ty <= maxTY; ty++) {
      for (var tx = minTX; tx <= maxTX; tx++) {
        ctx.fillStyle = biomeColor(biomeAt(tx, ty));
        ctx.fillRect(cxp + (tx - 0.5) * scale, cyp + (ty - 0.5) * scale, scale + 1, scale + 1);
      }
    }

    // grid lines only when zoomed in enough to read them
    if (scale >= 12) {
      ctx.strokeStyle = "rgba(2,6,23,0.25)"; ctx.lineWidth = 1;
      for (var gtx = minTX; gtx <= maxTX; gtx++) { var gx = cxp + (gtx - 0.5) * scale; ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, canvas.height); ctx.stroke(); }
      for (var gty = minTY; gty <= maxTY; gty++) { var gy = cyp + (gty - 0.5) * scale; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(canvas.width, gy); ctx.stroke(); }
    }

    // town ring + label
    var c = worldToScreen(0, 0);
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c[0], c[1], TOWN_RADIUS * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#dbeafe"; ctx.font = "12px monospace"; ctx.textAlign = "center";
    ctx.fillText("TOWN (0,0)", c[0], c[1] + 4);

    // players
    ctx.textAlign = "left";
    state.players.forEach(function (p) {
      var s = worldToScreen(p.x, p.y);
      ctx.fillStyle = p.state === "combat" ? "#f97316" : "#f43f5e";
      ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 1.5; ctx.stroke();
      if (p.state === "combat") {
        ctx.strokeStyle = "#fb923c"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, Math.PI * 2); ctx.stroke();
      }
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
        meta.textContent = state.players.length + " adventurer" + (state.players.length === 1 ? "" : "s") + " in the wilds";
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
    e.preventDefault(); scale = Math.max(8, Math.min(48, scale * (e.deltaY < 0 ? 1.1 : 0.9))); draw();
  }, { passive: false });

  fetchPlayers();
  setInterval(fetchPlayers, 2000);
})();
</script>
</body>
</html>`;

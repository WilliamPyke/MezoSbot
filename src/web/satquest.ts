import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { supabase } from "../db.js";
import { SAT, biomeAt } from "../satquest/engine.js";

/**
 * Public, view-only companion map for SatQuest. Served as a self-contained
 * HTML+canvas page (no auth, no wallet) plus a JSON feed of live positions.
 *
 * Privacy: HP *is* a player's real withdrawable balance, so we never expose
 * absolute sats or discord_id — only display name, coordinates, state, and a
 * coarse HP percentage relative to the player's run high-water mark.
 */
export async function handleSatquestWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" && url.pathname === "/satquest") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(PAGE_HTML);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/satquest/players") {
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
<title>SatQuest — Global Map</title>
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
    <h1>SATQUEST · GLOBAL MAP</h1>
    <span class="meta" id="meta">connecting…</span>
  </header>
  <div class="wrap"><canvas id="map" width="900" height="640"></canvas></div>
  <p class="hint">Drag to pan · scroll to zoom · live every 2s</p>
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
  function biomeColor(b) {
    return b === "town" ? "#1e3a8a" : b === "jungle" ? "#15803d"
         : b === "desert" ? "#a16207" : b === "winter" ? "#64748b" : "#1f2937";
  }
  function draw() {
    ctx.fillStyle = "#020617"; ctx.fillRect(0, 0, canvas.width, canvas.height);

    // grid
    ctx.strokeStyle = "rgba(148,163,184,0.06)"; ctx.lineWidth = 1;
    for (var gx = (ox % scale) - scale; gx < canvas.width; gx += scale) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, canvas.height); ctx.stroke();
    }
    for (var gy = (oy % scale) - scale; gy < canvas.height; gy += scale) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(canvas.width, gy); ctx.stroke();
    }

    // safe-zone town
    var r = state.townRadius * scale;
    var c = worldToScreen(0, 0);
    ctx.fillStyle = "rgba(30,58,138,0.35)"; ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#93c5fd"; ctx.font = "12px monospace"; ctx.textAlign = "center";
    ctx.fillText("TOWN (0,0)", c[0], c[1] + 4);

    // players
    ctx.textAlign = "left";
    state.players.forEach(function (p) {
      var s = worldToScreen(p.x, p.y);
      ctx.fillStyle = p.state === "combat" ? "#f97316" : "#f43f5e";
      ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill();
      if (p.state === "combat") {
        ctx.strokeStyle = "#fb923c"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = biomeColor(p.biome); ctx.fillRect(s[0] + 9, s[1] - 11, 4, 4);
      ctx.fillStyle = "#f8fafc"; ctx.font = "11px monospace";
      ctx.fillText(p.name + "  " + p.hpPct + "%hp", s[0] + 9, s[1] + 4);
    });
  }

  function fetchPlayers() {
    fetch("/api/satquest/players").then(function (r) { return r.json(); }).then(function (d) {
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
    e.preventDefault(); scale = Math.max(4, Math.min(48, scale * (e.deltaY < 0 ? 1.1 : 0.9))); draw();
  }, { passive: false });

  fetchPlayers();
  setInterval(fetchPlayers, 2000);
})();
</script>
</body>
</html>`;

import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    arcade: { executor: "constant-vus", vus: 50, duration: "2m", exec: "arcade" },
    satscape: { executor: "constant-vus", vus: 25, duration: "2m", exec: "satscape" },
    emulator: { executor: "constant-vus", vus: 25, duration: "2m", exec: "emulator" },
  },
  thresholds: {
    "http_req_duration{service:arcade}": ["p(95)<250"],
    "http_req_duration{service:satscape}": ["p(95)<250"],
    http_req_failed: ["rate<0.01"],
  },
};

const gamesUrl = __ENV.GAMES_URL || "http://127.0.0.1:8787";
const emulatorUrl = __ENV.EMULATOR_URL || "http://127.0.0.1:8787";

export function arcade() {
  const response = http.get(`${gamesUrl}/healthz`, { tags: { service: "arcade" } });
  check(response, { "arcade healthy": (value) => value.status === 200 });
  sleep(0.2);
}

export function satscape() {
  const token = __ENV.SATSCAPE_TOKEN;
  const path = token ? `/api/v1/satscape/state?token=${encodeURIComponent(token)}` : "/healthz";
  const response = http.get(`${gamesUrl}${path}`, { tags: { service: "satscape" } });
  check(response, { "satscape response succeeds": (value) => value.status === 200 });
  sleep(0.35);
}

export function emulator() {
  const websocketUrl = emulatorUrl.replace(/^http/, "ws") + "/stream";
  const response = ws.connect(websocketUrl, {}, (socket) => {
    let frames = 0;
    socket.on("binaryMessage", () => { frames += 1; if (frames >= 120) socket.close(); });
    socket.setTimeout(() => socket.close(), 3_000);
  });
  check(response, { "emulator websocket upgrades": (value) => value?.status === 101 });
  sleep(0.2);
}

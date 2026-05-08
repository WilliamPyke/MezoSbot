/**
 * Bridge between the browser-side web handlers and the Discord client.
 *
 * The web playfield runs in the same process as the Discord client but in a
 * different module. When a match settles via the web `/arcade/api/submit`
 * route, we want the public Discord match card to reflect the result without
 * importing the Discord client into the web layer. The bot wires up
 * `setMatchSettledHandler` at startup; the web layer just fires the event.
 */

import { closeMatchSpectators } from "./spectate.js";

type MatchSettledHandler = (matchId: number) => void | Promise<void>;

let handler: MatchSettledHandler | null = null;

export function setMatchSettledHandler(h: MatchSettledHandler): void {
  handler = h;
}

export function onMatchSettled(matchId: number): void {
  // Push final snapshot to spectators and close their sockets.
  closeMatchSpectators(matchId).catch((err) =>
    console.warn("[Spectate] close failed:", (err as Error)?.message ?? err)
  );
  if (!handler) return;
  Promise.resolve(handler(matchId)).catch((err) =>
    console.error("[Arcade] match-settled handler error:", (err as Error)?.message ?? err)
  );
}

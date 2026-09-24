/** play.mallard.sh keeps redirecting to the split hosts until this instant, then returns 410. */
export const PLAY_REDIRECT_ENDS_AT = Date.UTC(2026, 9, 24);

export function playRedirect(url: URL, origins: { arcade: string; satscape: string }, now = Date.now()): Response {
  if (now >= PLAY_REDIRECT_ENDS_AT) {
    return new Response(JSON.stringify({
      ok: false,
      error: { code: "gone", message: "play.mallard.sh has moved to arcade.mallard.sh and satscape.mallard.sh", retryable: false },
    }), { status: 410, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  const target = url.pathname.startsWith("/satscape") ? origins.satscape : origins.arcade;
  return Response.redirect(`${target}${url.pathname}${url.search}`, 308);
}

type MatchLike = {
  seed?: string;
  status?: string;
  player_a_score?: number | null;
  player_b_score?: number | null;
};

/**
 * Client/bot-facing match shape. The seed never leaves the Worker (the client
 * receives its own board and piece previews computed server-side), and scores
 * stay hidden until the match is settled so neither player sees the other's
 * live progress.
 */
export function publicMatch<T extends MatchLike>(match: T): Omit<T, "seed"> {
  const { seed: _seed, ...rest } = match;
  if (rest.status !== "completed") {
    delete rest.player_a_score;
    delete rest.player_b_score;
  }
  return rest;
}

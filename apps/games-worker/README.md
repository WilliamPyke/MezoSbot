# Arcade and SatScape Worker

Cloudflare Worker boundary for request-driven Arcade/SatScape APIs, static assets,
and hibernatable Arcade spectator WebSockets. Supabase is authoritative; the
`ArcadeRoom` Durable Object only fans out transient spectator messages.

Local setup:

1. Copy `.dev.vars.example` to `.dev.vars` and fill it with staging values.
2. Run `npm run types --workspace @mezosbot/games-worker` after changing bindings.
3. Run `npm run dev --workspace @mezosbot/games-worker`.
4. Run `npm run test:worker` before deployment.

Production secrets are set with `wrangler secret put`; they are never committed.

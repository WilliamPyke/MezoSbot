# MezoSbot core

This is the Northflank deployment boundary for Discord, quests, wallet operations,
notifications, swaps, deposits, and imgnAI. The image is `deploy/Dockerfile.bot`
and runs the root build (`build:packages`, web, `tsc`, SatScape assets).

Set `MEZOSBOT_RUNTIME_ROLE=bot`. With all three `*_REMOTE_ENABLED` flags true the
bot serves only `/healthz` and `/metrics`; with any flag false it keeps serving
the legacy browser/game routes for that feature from the same image, so a
rollback is a flag change plus redeploy. Flags are read at boot only.

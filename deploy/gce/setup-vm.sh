#!/usr/bin/env bash
# One-time setup of the Compute Engine e2-micro VM (Debian 12) that runs the bot.
#   sudo bash setup-vm.sh
#
# - Installs Docker, automatic security updates and a 2 GB swap file.
# - Runs ghcr.io/williampyke/mezosbot-bot:testingrender (built by .github/workflows/bot-image.yml)
#   as the systemd service `mezosbot`, with secrets from /etc/mezosbot/bot.env (root-only).
#   No port is published: the bot only makes outbound connections.
# - Every 5 minutes pulls the image and restarts the bot when it changed (deploy on push).
# The service starts once /etc/mezosbot/bot.env is non-empty.
set -euo pipefail

IMAGE="ghcr.io/williampyke/mezosbot-bot:testingrender"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io unattended-upgrades
systemctl enable --now docker
dpkg-reconfigure -f noninteractive unattended-upgrades

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -m 700 -o root -g root /etc/mezosbot
[ -f /etc/mezosbot/bot.env ] || install -m 600 -o root -g root /dev/null /etc/mezosbot/bot.env

cat > /etc/systemd/system/mezosbot.service <<EOF
[Unit]
Description=MezoSbot
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
ConditionFileNotEmpty=/etc/mezosbot/bot.env

[Service]
ExecStartPre=-/usr/bin/docker rm -f mezosbot
ExecStart=/usr/bin/docker run --rm --name mezosbot --env-file /etc/mezosbot/bot.env \\
  --memory 800m --log-driver journald --read-only --tmpfs /tmp --tmpfs /app/saves \\
  --security-opt no-new-privileges --cap-drop ALL ${IMAGE}
ExecStop=/usr/bin/docker stop -t 30 mezosbot
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/mezosbot-update <<EOF
#!/usr/bin/env bash
set -euo pipefail
before=\$(docker image inspect --format '{{.Id}}' ${IMAGE} 2>/dev/null || true)
docker pull -q ${IMAGE} >/dev/null
after=\$(docker image inspect --format '{{.Id}}' ${IMAGE})
if [ "\$before" != "\$after" ]; then
  echo "New image \$after, restarting mezosbot"
  systemctl restart mezosbot
  docker image prune -f >/dev/null
fi
EOF
chmod 755 /usr/local/bin/mezosbot-update

cat > /etc/systemd/system/mezosbot-update.service <<'EOF'
[Unit]
Description=Pull the MezoSbot image and restart on change

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mezosbot-update
EOF

cat > /etc/systemd/system/mezosbot-update.timer <<'EOF'
[Unit]
Description=Check for a new MezoSbot image every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable mezosbot.service mezosbot-update.timer
systemctl start mezosbot-update.timer
docker pull "${IMAGE}"
echo "Done. Put the bot's variables in /etc/mezosbot/bot.env, then: sudo systemctl start mezosbot"

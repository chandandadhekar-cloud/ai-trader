#!/usr/bin/env bash
# Install growth ops on a Linux VPS with systemd. Run as root from the seo-growth directory.
# Creates an unprivileged user, copies the project to /opt/seo-growth and enables 3 timers.
# No ports are opened and no dashboard is exposed.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
id growthops >/dev/null 2>&1 || useradd --system --home /opt/seo-growth --shell /usr/sbin/nologin growthops
mkdir -p /opt/seo-growth
rsync -a --exclude var/ --exclude site/public/ "$SRC"/ /opt/seo-growth/
chown -R growthops:growthops /opt/seo-growth
sudo -u growthops GROWTH_HOME=/opt/seo-growth python3 /opt/seo-growth/growth.py init
cp "$SRC"/deploy/growth-ops@.service "$SRC"/deploy/growth-ops-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now growth-ops-daily.timer growth-ops-weekly.timer growth-ops-monthly.timer
systemctl list-timers 'growth-ops-*'

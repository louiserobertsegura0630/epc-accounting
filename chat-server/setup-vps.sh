#!/usr/bin/env bash
# ─── EPC chat assistant: one-time setup on the Hostinger VPS ────────────────
# Run as root on the VPS, from this folder:   bash setup-vps.sh
# Safe to run again (to update the code, change the key or the web address).
#
# It installs Node.js and Caddy (HTTPS web server) if missing, copies the
# chat server to /opt/epc-chat, stores your Anthropic key in
# /etc/epc-chat.env (root-only), runs the server as a locked-down system
# service, and gets an HTTPS certificate automatically.
set -euo pipefail

APP_DIR=/opt/epc-chat
ENV_FILE=/etc/epc-chat.env
SERVICE=epc-chat
APP_USER=epcchat
PORT=8787
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (log in as root, or use: sudo bash setup-vps.sh)."
[ -f "$HERE/server.js" ] && [ -f "$HERE/package.json" ] || die "Run this from the chat-server folder (server.js not found next to it)."
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian VPS images only."

# ── 1. Web address ───────────────────────────────────────────────────────────
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
DEFAULT_HOST=""
[ -n "$PUBLIC_IP" ] && DEFAULT_HOST="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"
EXISTING_HOST="$(sed -n 's/^# epc-chat host: //p' /etc/caddy/Caddyfile 2>/dev/null | tail -1 || true)"
echo
echo "Which web address should the chat use?"
echo " - If you own a domain, use a sub-domain like chat.yourdomain.com"
echo "   (first add a DNS 'A' record for it pointing to ${PUBLIC_IP:-the IP of this VPS})."
echo " - Or just press Enter to use the free automatic address: ${EXISTING_HOST:-$DEFAULT_HOST}"
read -rp "Web address: " CHAT_HOST
CHAT_HOST="${CHAT_HOST:-${EXISTING_HOST:-$DEFAULT_HOST}}"
CHAT_HOST="$(echo "$CHAT_HOST" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*$##')"
echo "$CHAT_HOST" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}$' || die "That doesn't look like a web address: '$CHAT_HOST'"

# ── 2. Make sure ports 80/443 are free for Caddy ─────────────────────────────
if command -v ss >/dev/null; then
  BUSY="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v caddy || true)"
  if [ -n "$BUSY" ]; then
    echo "$BUSY"
    die "Another program (above) already uses web ports 80/443 on this VPS. Nothing was changed. Send a screenshot of this to your developer so the chat can be added to that web server instead."
  fi
fi

# ── 3. Install Node.js 22 and Caddy if needed ────────────────────────────────
say "Installing packages (this can take a few minutes)…"
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y >/dev/null
  apt-get install -y caddy >/dev/null
fi
echo "Node $(node -v), $(caddy version | cut -d' ' -f1)"

# ── 4. App files and a locked-down system user ───────────────────────────────
say "Installing the chat server to $APP_DIR…"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
install -m 0644 "$HERE/server.js" "$HERE/package.json" "$APP_DIR/"
[ -f "$HERE/package-lock.json" ] && install -m 0644 "$HERE/package-lock.json" "$APP_DIR/"
( cd "$APP_DIR" && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund >/dev/null; else npm install --omit=dev --no-audit --no-fund >/dev/null; fi )
chown -R root:root "$APP_DIR"

# ── 5. The Anthropic key (stored root-only, never printed) ───────────────────
if [ -f "$ENV_FILE" ] && grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE"; then
  read -rp "An Anthropic key is already saved. Replace it? [y/N] " REPLACE
else
  REPLACE=y
fi
if [ "${REPLACE,,}" = "y" ]; then
  echo "Paste your Anthropic API key (starts with sk-ant-). It will NOT show while you paste. Then press Enter."
  read -rsp "Key: " KEY; echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  case "$KEY" in sk-ant-*) ;; *) die "That doesn't look like an Anthropic key (should start with sk-ant-). Nothing saved." ;; esac
  umask 077
  printf 'ANTHROPIC_API_KEY=%s\nPORT=%s\nFIREBASE_PROJECT_ID=inventory-system-1fb4d\n' "$KEY" "$PORT" > "$ENV_FILE"
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
  unset KEY
fi

# ── 6. System service (starts on boot, restarts if it crashes) ───────────────
say "Starting the chat service…"
cat > /etc/systemd/system/$SERVICE.service <<UNIT
[Unit]
Description=EPC Accounting Portal chat assistant API
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
User=$APP_USER
Group=$APP_USER
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now $SERVICE >/dev/null
systemctl restart $SERVICE
sleep 2
systemctl is-active --quiet $SERVICE || { journalctl -u $SERVICE -n 30 --no-pager; die "The chat service did not start (log above)."; }

# ── 7. HTTPS with Caddy ──────────────────────────────────────────────────────
say "Setting up HTTPS for https://$CHAT_HOST …"
CADDYFILE=/etc/caddy/Caddyfile
touch "$CADDYFILE"
cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
# The stock Caddyfile only serves a demo page on :80: start fresh in that case.
# Otherwise replace any earlier epc-chat block and keep everything else.
if grep -q '/usr/share/caddy' "$CADDYFILE" && ! grep -q '^# >>> epc-chat >>>' "$CADDYFILE" \
   && [ "$(grep -cvE '^\s*(#|$)' "$CADDYFILE")" -le 12 ]; then
  : > "$CADDYFILE.tmp"
else
  awk '/^# >>> epc-chat >>>/{skip=1} !skip{print} /^# <<< epc-chat <<</{skip=0}' "$CADDYFILE" > "$CADDYFILE.tmp"
fi
cat >> "$CADDYFILE.tmp" <<CADDY
# >>> epc-chat >>>
# epc-chat host: $CHAT_HOST
$CHAT_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
# <<< epc-chat <<<
CADDY
caddy validate --config "$CADDYFILE.tmp" --adapter caddyfile >/dev/null 2>&1 || { rm -f "$CADDYFILE.tmp"; die "Caddy config check failed. Nothing changed in Caddy."; }
mv "$CADDYFILE.tmp" "$CADDYFILE"
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

# ── 8. Check it ──────────────────────────────────────────────────────────────
say "Checking https://$CHAT_HOST/health (the certificate can take up to a minute)…"
OK=""
for i in $(seq 1 12); do
  if curl -fsS --max-time 10 "https://$CHAT_HOST/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done
echo
if [ -n "$OK" ]; then
  printf '\033[1;32mDONE. The chat API is running at:\n\n    https://%s/api/chat\n\nSend that address to your developer.\033[0m\n' "$CHAT_HOST"
else
  warn "The service is running, but https://$CHAT_HOST is not answering yet."
  warn "If you used your own domain, check its DNS 'A' record points to ${PUBLIC_IP:-this VPS}."
  warn "Also check the VPS firewall in hPanel allows ports 80 and 443. Then run this script again."
fi

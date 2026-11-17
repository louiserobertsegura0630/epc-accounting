#!/usr/bin/env bash
# ─── EPC chat assistant: one-time setup on the Hostinger VPS ────────────────
# Run as root on the VPS, from this folder:   bash setup-vps.sh
# Safe to run again (to update the code, change the key or the web address).
#
# Two modes, picked automatically:
#  • Coolify VPS (Coolify's Traefik owns ports 80/443): the chat server runs as
#    a Docker container "epc-chat" on Coolify's "coolify" network with no
#    public port, and one Traefik file in /data/coolify/proxy/dynamic/ routes
#    the chat address to it with Let's Encrypt HTTPS. Nothing Coolify manages
#    is edited.
#  • Plain VPS (ports 80/443 free): Node.js + Caddy on the host, as a systemd
#    service.
# Either way the Anthropic key is stored in /etc/epc-chat.env (root-only).
set -euo pipefail

APP_DIR=/opt/epc-chat
ENV_FILE=/etc/epc-chat.env
NAME=epc-chat
PORT=8787
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COOLIFY_DYNAMIC=/data/coolify/proxy/dynamic

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (log in as root, or use: sudo bash setup-vps.sh)."
[ -f "$HERE/server.js" ] && [ -f "$HERE/package.json" ] || die "Run this from the chat-server folder (server.js not found next to it)."

# ── Which mode? ──────────────────────────────────────────────────────────────
MODE=plain
if command -v docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx coolify-proxy && [ -d "$COOLIFY_DYNAMIC" ]; then
  MODE=coolify
fi
say "Setup mode: $MODE"

# ── 1. Web address ───────────────────────────────────────────────────────────
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
DEFAULT_HOST=""
[ -n "$PUBLIC_IP" ] && DEFAULT_HOST="epc-chat.$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"
EXISTING_HOST=""
[ -f "$ENV_FILE" ] && EXISTING_HOST="$(sed -n 's/^CHAT_HOST=//p' "$ENV_FILE" | tail -1)"
echo
echo "Which web address should the chat use?"
echo " - If you own a domain, use a sub-domain like chat.yourdomain.com"
echo "   (first add a DNS 'A' record for it pointing to ${PUBLIC_IP:-the IP of this VPS})."
echo " - Or just press Enter to use the free automatic address: ${EXISTING_HOST:-$DEFAULT_HOST}"
read -rp "Web address: " CHAT_HOST
CHAT_HOST="${CHAT_HOST:-${EXISTING_HOST:-$DEFAULT_HOST}}"
CHAT_HOST="$(echo "$CHAT_HOST" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*$##')"
echo "$CHAT_HOST" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}$' || die "That doesn't look like a web address: '$CHAT_HOST'"

# ── 2. The Anthropic key (stored root-only, never printed) ───────────────────
KEY=""
if [ -f "$ENV_FILE" ] && grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE"; then
  read -rp "An Anthropic key is already saved. Replace it? [y/N] " REPLACE
else
  REPLACE=y
fi
if [ "${REPLACE,,}" = "y" ]; then
  echo "Paste your Anthropic API key (starts with sk-ant-). It will NOT show while you paste. Then press Enter."
  read -rsp "Key: " KEY; echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  case "$KEY" in sk-ant-*) ;; *) die "That doesn't look like an Anthropic key (should start with sk-ant-). Nothing changed." ;; esac
else
  KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$ENV_FILE" | tail -1)"
fi
HOST_BIND=127.0.0.1
[ "$MODE" = coolify ] && HOST_BIND=0.0.0.0
umask 077
printf 'ANTHROPIC_API_KEY=%s\nPORT=%s\nHOST=%s\nFIREBASE_PROJECT_ID=inventory-system-1fb4d\nCHAT_HOST=%s\n' \
  "$KEY" "$PORT" "$HOST_BIND" "$CHAT_HOST" > "$ENV_FILE"
chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
unset KEY
umask 022

# ── 3. App files ─────────────────────────────────────────────────────────────
say "Copying the chat server to $APP_DIR…"
mkdir -p "$APP_DIR"
install -m 0644 "$HERE/server.js" "$HERE/package.json" "$APP_DIR/"
[ -f "$HERE/package-lock.json" ] && install -m 0644 "$HERE/package-lock.json" "$APP_DIR/"

if [ "$MODE" = coolify ]; then
  # ── 4a. Coolify: Docker container + one Traefik route file ────────────────
  NODE_IMAGE=node:22-alpine
  say "Installing packages inside Docker (first time can take a minute)…"
  docker pull -q "$NODE_IMAGE" >/dev/null
  rm -rf "$APP_DIR/node_modules"
  docker run --rm -v "$APP_DIR:/app" -w /app "$NODE_IMAGE" \
    sh -c 'if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi' >/dev/null
  chown -R root:root "$APP_DIR"; chmod -R a+rX "$APP_DIR"

  say "Starting the chat container…"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \
    --network coolify \
    --env-file "$ENV_FILE" \
    -v "$APP_DIR:/app:ro" -w /app \
    --user node --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 512m \
    "$NODE_IMAGE" node server.js >/dev/null
  sleep 3
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] \
    || { docker logs --tail 30 "$NAME" 2>&1 || true; die "The chat container did not start (log above)."; }

  say "Adding the HTTPS route for https://$CHAT_HOST to Coolify's proxy…"
  cat > "$COOLIFY_DYNAMIC/epc-chat.yaml" <<YAML
# EPC Accounting Portal chat API (written by chat-server/setup-vps.sh).
http:
  routers:
    epc-chat-http:
      entryPoints: [http]
      rule: "Host(\`$CHAT_HOST\`)"
      middlewares: [epc-chat-to-https]
      service: epc-chat
    epc-chat:
      entryPoints: [https]
      rule: "Host(\`$CHAT_HOST\`)"
      service: epc-chat
      tls:
        certResolver: letsencrypt
  middlewares:
    epc-chat-to-https:
      redirectScheme:
        scheme: https
  services:
    epc-chat:
      loadBalancer:
        servers:
          - url: "http://$NAME:$PORT"
YAML
  chmod 644 "$COOLIFY_DYNAMIC/epc-chat.yaml"
else
  # ── 4b. Plain VPS: Node + Caddy on the host ───────────────────────────────
  command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian VPS images only."
  if command -v ss >/dev/null; then
    BUSY="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v caddy || true)"
    if [ -n "$BUSY" ]; then
      echo "$BUSY"
      die "Another program (above) already uses web ports 80/443 on this VPS. Nothing else was changed. Send a screenshot of this to your developer."
    fi
  fi
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
  ( cd "$APP_DIR" && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund >/dev/null; else npm install --omit=dev --no-audit --no-fund >/dev/null; fi )
  chown -R root:root "$APP_DIR"
  id -u epcchat >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin epcchat

  say "Starting the chat service…"
  cat > /etc/systemd/system/$NAME.service <<UNIT
[Unit]
Description=EPC Accounting Portal chat assistant API
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
User=epcchat
Group=epcchat
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
  systemctl enable --now $NAME >/dev/null
  systemctl restart $NAME
  sleep 2
  systemctl is-active --quiet $NAME || { journalctl -u $NAME -n 30 --no-pager; die "The chat service did not start (log above)."; }

  say "Setting up HTTPS for https://$CHAT_HOST …"
  CADDYFILE=/etc/caddy/Caddyfile
  touch "$CADDYFILE"
  cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
  if grep -q '/usr/share/caddy' "$CADDYFILE" && ! grep -q '^# >>> epc-chat >>>' "$CADDYFILE" \
     && [ "$(grep -cvE '^\s*(#|$)' "$CADDYFILE")" -le 12 ]; then
    : > "$CADDYFILE.tmp"
  else
    awk '/^# >>> epc-chat >>>/{skip=1} !skip{print} /^# <<< epc-chat <<</{skip=0}' "$CADDYFILE" > "$CADDYFILE.tmp"
  fi
  cat >> "$CADDYFILE.tmp" <<CADDY
# >>> epc-chat >>>
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
fi

# ── 5. Check it ──────────────────────────────────────────────────────────────
say "Checking https://$CHAT_HOST/health (the certificate can take up to a minute)…"
OK=""
for i in $(seq 1 18); do
  if curl -fsS --max-time 10 "https://$CHAT_HOST/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done
echo
if [ -n "$OK" ]; then
  printf '\033[1;32mDONE. The chat API is running at:\n\n    https://%s/api/chat\n\nSend that address to your developer.\033[0m\n' "$CHAT_HOST"
else
  warn "The chat server is running, but https://$CHAT_HOST is not answering yet."
  [ "$MODE" = coolify ] && warn "Coolify's proxy may need a minute for the certificate. Wait 2 minutes, then open https://$CHAT_HOST/health in your browser; it should show {\"ok\":true}."
  warn "If you used your own domain, check its DNS 'A' record points to ${PUBLIC_IP:-this VPS}."
  warn "Send a screenshot of this to your developer if it still doesn't answer."
fi

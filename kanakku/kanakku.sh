#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Kanakku — Afra Ventures finance system · one-command install & management
#
#    ./kanakku.sh install     first-time setup (asks 4 questions, does the rest)
#    ./kanakku.sh update      pull new code / rebuild / restart (data is kept)
#    ./kanakku.sh status      what's running + health check
#    ./kanakku.sh logs        live app logs (Ctrl+C to stop)
#    ./kanakku.sh backup      take a database backup now  → backups/
#    ./kanakku.sh restore F   restore a backup file (asks to confirm)
#    ./kanakku.sh n8n-import  (re)import the WhatsApp automation workflows
#    ./kanakku.sh smoke       end-to-end test against the running app
#    ./kanakku.sh reset-pass  set a new password for a user
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1m'; N='\033[0m'
say()  { echo -e "${G}▸${N} $*"; }
warn() { echo -e "${Y}!${N} $*"; }
die()  { echo -e "${R}✗ $*${N}" >&2; exit 1; }
rand() { (openssl rand -hex "${1:-32}" 2>/dev/null) || head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
      say "Installing Docker (one time)…"
      curl -fsSL https://get.docker.com | sh
    else
      die "Docker is not installed. Install Docker Desktop (Windows/Mac) or run: curl -fsSL https://get.docker.com | sudo sh"
    fi
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (or you need sudo). Start Docker and try again."
}

set_env() { # set_env FILE KEY VALUE — add or replace KEY=VALUE
  local f="$1" k="$2" v="$3"
  v="${v//\$/\$\$}"   # Docker Compose reads $ as a variable — store it as $$ so passwords stay intact
  touch "$f"
  if grep -q "^${k}=" "$f"; then
    local esc; esc=$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')
    sed -i.bak "s|^${k}=.*|${k}=${esc}|" "$f" && rm -f "$f.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}
get_env() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2-; }

wait_healthy() {
  say "Waiting for the app to start…"
  local port; port=$(get_env .env APP_PORT); port=${port:-4000}
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  dc logs --tail 60 app
  die "The app did not come up. The log above shows why."
}

install() {
  need_docker
  echo -e "\n${B}Kanakku · Afra Ventures — install${N}\n"

  if [ -f server/.env ] && [ -f .env ]; then
    warn "Already configured (server/.env exists). Running update instead."
    update; return
  fi

  read -rp "Domain for the app (e.g. kanakku.afraventures.in) — leave blank to run on this computer only: " DOMAIN
  read -rp "Admin name  [Kamarudeen B]: " ADMIN_NAME;  ADMIN_NAME=${ADMIN_NAME:-Kamarudeen B}
  read -rp "Admin email [hello@afraventures.in]: " ADMIN_EMAIL; ADMIN_EMAIL=${ADMIN_EMAIL:-hello@afraventures.in}
  while :; do
    read -rsp "Admin password (min 8 chars): " ADMIN_PASSWORD; echo
    [ ${#ADMIN_PASSWORD} -ge 8 ] && break; warn "Too short."
  done
  read -rp "Grok (x.ai) API key — optional, Enter to skip: " XAI_KEY
  read -rp "Razorpay webhook secret — optional, Enter to skip: " RZP
  read -rp "WhatsApp Cloud API phone number ID — optional: " WA_ID
  read -rp "WhatsApp Cloud API permanent token — optional: " WA_TOKEN

  DB_PASSWORD=$(rand 24); JWT=$(rand 48); INTERNAL=$(rand 24)

  cp .env.example .env
  set_env .env DB_PASSWORD "$DB_PASSWORD"
  set_env .env INTERNAL_API_KEY "$INTERNAL"
  set_env .env WA_PHONE_NUMBER_ID "$WA_ID"
  set_env .env WA_TOKEN "$WA_TOKEN"
  if [ -n "$DOMAIN" ]; then
    set_env .env APP_BIND 127.0.0.1; APP_URL="https://$DOMAIN"
  else
    set_env .env APP_BIND 0.0.0.0;   APP_URL="http://localhost:4000"
    set_env .env N8N_SECURE_COOKIE false
  fi
  set_env .env APP_PORT 4000

  cp server/.env.example server/.env
  set_env server/.env NODE_ENV production
  set_env server/.env APP_URL "$APP_URL"
  set_env server/.env CORS_ORIGIN "$([ -n "$DOMAIN" ] && echo "$APP_URL" || echo "")"
  set_env server/.env DATABASE_URL "postgres://kanakku:${DB_PASSWORD}@db:5432/kanakku"
  set_env server/.env JWT_SECRET "$JWT"
  set_env server/.env ADMIN_NAME "$ADMIN_NAME"
  set_env server/.env ADMIN_EMAIL "$ADMIN_EMAIL"
  set_env server/.env ADMIN_PASSWORD "$ADMIN_PASSWORD"
  set_env server/.env INTERNAL_API_KEY "$INTERNAL"
  set_env server/.env XAI_API_KEY "$XAI_KEY"
  set_env server/.env RAZORPAY_WEBHOOK_SECRET "$RZP"
  chmod 600 .env server/.env

  say "Building and starting (first time takes 3–6 minutes)…"
  dc up -d --build
  wait_healthy
  n8n_import || warn "n8n import skipped — run ./kanakku.sh n8n-import later."

  # Admin password is only needed for the first start — remove it from the file
  set_env server/.env ADMIN_PASSWORD ""

  if [ -n "$DOMAIN" ]; then setup_https "$DOMAIN"; fi

  echo -e "\n${G}${B}✓ Kanakku is running.${N}"
  echo -e "  Open:   ${B}${APP_URL}${N}   (login: ${ADMIN_EMAIL})"
  [ -z "$DOMAIN" ] && echo "  Same Wi-Fi phone/laptop: http://$(hostname -I 2>/dev/null | awk '{print $1}'):4000" && echo "  n8n:    http://localhost:5678"
  [ -n "$DOMAIN" ] && echo "  n8n:    https://n8n.${DOMAIN#*.}  (create the owner login, then switch the 3 workflows ON)"
  echo "  Backups: daily into ./backups (keeps 30 days)"
  echo "  Next:   docs/BUILD_PLAN.md → acceptance checklist"
}

setup_https() {
  local domain="$1" n8n_domain="n8n.${1#*.}"
  if ! command -v nginx >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
      say "Installing nginx + certbot…"; apt-get update -qq && apt-get install -y -qq nginx certbot python3-certbot-nginx
    else
      warn "nginx not installed — set up HTTPS with deploy/nginx.conf (see DEV_GUIDE §5)."; return
    fi
  fi
  [ "$(id -u)" = "0" ] || { warn "Run as root (sudo) to set up HTTPS automatically. Skipped."; return; }
  say "Configuring nginx for $domain and $n8n_domain…"
  sed -e "s/kanakku.afraventures.in/${domain}/g" -e "s/n8n.afraventures.in/${n8n_domain}/g" deploy/nginx.conf > /etc/nginx/sites-available/kanakku
  ln -sf /etc/nginx/sites-available/kanakku /etc/nginx/sites-enabled/kanakku
  nginx -t && systemctl reload nginx
  # make n8n use the right public address
  sed -i.bak -e "s/n8n.afraventures.in/${n8n_domain}/g" docker-compose.yml && rm -f docker-compose.yml.bak && dc up -d n8n
  read -rp "DNS A records for $domain and $n8n_domain point to this server? Get free HTTPS now? [Y/n] " yn
  if [[ "${yn:-Y}" =~ ^[Yy] ]]; then
    certbot --nginx -d "$domain" -d "$n8n_domain" --non-interactive --agree-tos -m "$(get_env server/.env ADMIN_EMAIL || echo admin@$domain)" --redirect \
      || warn "certbot failed — check DNS, then run: sudo certbot --nginx -d $domain -d $n8n_domain"
  fi
}

update() {
  need_docker
  if [ -d .git ]; then say "Pulling latest code…"; git pull --ff-only || warn "git pull failed — continuing with local code"; fi
  say "Taking a safety backup first…"; backup || warn "Backup skipped (database not running yet)"
  say "Rebuilding and restarting…"
  dc up -d --build
  wait_healthy
  say "✓ Updated. Database changes (if any) were applied on start."
}

status() {
  dc ps
  local port; port=$(get_env .env APP_PORT); port=${port:-4000}
  if curl -fsS "http://127.0.0.1:${port}/api/health"; then echo; say "App healthy"; else warn "App not answering on :${port}"; fi
}

backup() {
  mkdir -p backups
  local f="backups/kanakku_$(date +%F_%H%M).sql.gz"
  dc exec -T db pg_dump -U kanakku kanakku | gzip > "$f"
  say "Backup saved: $f ($(du -h "$f" | cut -f1))"
}

restore() {
  local f="${1:-}"; [ -f "$f" ] || die "Usage: ./kanakku.sh restore backups/kanakku_YYYY-MM-DD.sql.gz"
  read -rp "This REPLACES all current data with $f. Type YES to continue: " ok
  [ "$ok" = "YES" ] || die "Cancelled."
  backup
  dc stop app
  dc exec -T db psql -U kanakku -d postgres -c "DROP DATABASE IF EXISTS kanakku WITH (FORCE);" -c "CREATE DATABASE kanakku OWNER kanakku;"
  gunzip -c "$f" | dc exec -T db psql -q -U kanakku kanakku
  dc start app; wait_healthy
  say "✓ Restored from $f"
}

n8n_import() {
  say "Importing WhatsApp automation workflows into n8n…"
  for _ in $(seq 1 30); do dc exec -T n8n n8n --version >/dev/null 2>&1 && break; sleep 2; done
  dc exec -T n8n n8n import:workflow --separate --input=/workflows
  say "Workflows imported (they start OFF — switch them on in n8n after the WhatsApp templates are approved)."
}

smoke() {
  local email pass port
  port=$(get_env .env APP_PORT); port=${port:-4000}
  read -rp "Admin email: " email; read -rsp "Password: " pass; echo
  warn "The smoke test creates sample records (customer, quote, invoice, investor). Use a test install, or delete them after."
  dc exec -T -e API="http://localhost:4000" -e ADMIN_EMAIL="$email" -e ADMIN_PASSWORD="$pass" app node src/scripts/smoke.js
}

reset_pass() {
  local email pass
  read -rp "User email: " email; read -rsp "New password (min 8): " pass; echo
  [ ${#pass} -ge 8 ] || die "Too short."
  dc exec -T -e E="$email" -e P="$pass" app node -e "
    const b=require('bcryptjs');const {pool}=require('./src/lib/db');
    b.hash(process.env.P,10).then(h=>pool.query('UPDATE users SET password_hash=\$1, active=TRUE WHERE lower(email)=lower(\$2)',[h,process.env.E]))
     .then(r=>{console.log(r.rowCount?'✓ Password changed':'✗ No user with that email');process.exit(0)})"
}

case "${1:-install}" in
  install) install ;;
  update) update ;;
  status) status ;;
  logs) dc logs -f --tail 100 app ;;
  backup) backup ;;
  restore) restore "${2:-}" ;;
  n8n-import) n8n_import ;;
  smoke) smoke ;;
  reset-pass) reset_pass ;;
  *) sed -n '3,14p' "$0" ;;
esac

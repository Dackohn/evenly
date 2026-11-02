#!/usr/bin/env bash
# Install or update Evenly on this server. Safe to re-run: it keeps the existing secret URL,
# database and certificate, and only replaces code and service files.
#
#   sudo deploy/install.sh [hostname]
#
# hostname defaults to the existing one in /etc/evenly/evenly.env, or evenly-<ip-with-dashes>.sslip.io.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=$(pwd)
APP=/opt/evenly
ENVF=/etc/evenly/evenly.env

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

# --- settings (generated once, then reused) ---
if [[ -f $ENVF ]]; then
  # shellcheck disable=SC1090
  source "$ENVF"
  SECRET=$(echo "$EVENLY_BASE_PATH" | tr -d /)
  HOST=${1:-${EVENLY_ORIGIN#https://}}
else
  SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  IP=$(hostname -I | awk "{print \$1}")
  HOST=${1:-evenly-${IP//./-}.sslip.io}
fi

# --- service account: no shell, no home, owns nothing but its data ---
id evenly &>/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin evenly

install -d -m 0750 -o root -g evenly /etc/evenly
cat > "$ENVF" <<EOF
EVENLY_BASE_PATH=/$SECRET/
EVENLY_ORIGIN=https://$HOST
EVENLY_TZ=${EVENLY_TZ:-Europe/Chisinau}
EVENLY_OPEN_SIGNUP=${EVENLY_OPEN_SIGNUP:-0}
EOF
chown root:evenly "$ENVF"; chmod 0640 "$ENVF"

install -d -m 0700 -o evenly -g evenly /var/lib/evenly /var/lib/evenly/receipts /var/backups/evenly
install -m 0644 deploy/evenly.tmpfiles /etc/tmpfiles.d/evenly.conf
systemd-tmpfiles --create /etc/tmpfiles.d/evenly.conf

# --- code: owned by root, read-only to the app ---
install -d -m 0755 "$APP"
rsync -a --delete --chown=root:root --chmod=D755,F644 "$SRC/app" "$SRC/static" "$APP/"
install -m 0644 -o root -g root "$SRC/manage.py" "$SRC/requirements.txt" "$APP/"
[[ -x $APP/.venv/bin/python ]] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --disable-pip-version-check -r "$APP/requirements.txt"
find "$APP" -name __pycache__ -prune -exec rm -rf {} +

# --- systemd ---
install -m 0644 deploy/evenly.service deploy/evenly-backup.service deploy/evenly-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now evenly-backup.timer
systemctl enable evenly
systemctl restart evenly

# --- nginx + TLS ---
install -m 0644 deploy/evenly-proxy.conf /etc/nginx/snippets/evenly-proxy.conf
install -d -m 0755 /var/www/acme-evenly
CONF=/etc/nginx/sites-available/evenly
if [[ ! -f /etc/letsencrypt/live/$HOST/fullchain.pem ]]; then
  # HTTP-only server first, so Let's Encrypt can reach the challenge directory
  printf 'server { listen 80; listen [::]:80; server_name %s;\n  location /.well-known/acme-challenge/ { root /var/www/acme-evenly; }\n  location / { return 404; } }\n' "$HOST" > "$CONF"
  ln -sf "$CONF" /etc/nginx/sites-enabled/evenly
  nginx -t
  systemctl reload nginx
  certbot certonly --webroot -w /var/www/acme-evenly -d "$HOST" --non-interactive --agree-tos \
    --register-unsafely-without-email --deploy-hook "systemctl reload nginx"
fi
sed -e "s|__HOST__|$HOST|g" -e "s|__SECRET__|$SECRET|g" deploy/nginx.conf.template > "$CONF"
chmod 0600 "$CONF"
ln -sf "$CONF" /etc/nginx/sites-enabled/evenly
if ! nginx -t; then rm -f /etc/nginx/sites-enabled/evenly; echo "nginx config invalid; Evenly site disabled"; exit 1; fi
systemctl reload nginx

echo
echo "Evenly is running at:  https://$HOST/$SECRET/"

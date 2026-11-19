#!/usr/bin/env bash
#
# Active HTTPS pour lectures.mijary.tech sur winford-vps.
#
# Prérequis : l'enregistrement DNS doit exister et pointer vers le serveur en
# mode « DNS only » (nuage gris) — le temps de l'émission du certificat. Une fois
# le certificat en place, le record peut repasser en proxy Cloudflare.
#
# Usage : sudo bash deploy/enable-tls.sh

set -euo pipefail

DOMAIN="lectures.mijary.tech"
SERVER_IP="161.97.107.65"
WEBROOT="/var/www/letsencrypt"
SITE="/etc/nginx/sites-available/${DOMAIN}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "À lancer en root."

say "1/4 · Vérification DNS"
resolved="$(dig +short "$DOMAIN" A @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
[[ -z "$resolved" ]] && die "Aucun enregistrement A pour $DOMAIN.
   Créez dans la zone mijary.tech :  A  lectures  →  $SERVER_IP"
if [[ "$resolved" != "$SERVER_IP" ]]; then
  die "$DOMAIN pointe vers $resolved, donc pas directement vers ce serveur.
   Si c'est le proxy Cloudflare : passez le record en « DNS only » (nuage gris),
   relancez ce script, puis remettez-le en proxy."
fi
echo "   $DOMAIN → $resolved ✓"

say "2/4 · Émission du certificat (défi HTTP en webroot)"
certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
  --non-interactive --agree-tos --keep-until-expiring

say "3/4 · Configuration nginx (443 + ACME sur 80)"
# Le heredoc est entre apostrophes : les variables $host / $remote_addr doivent
# rester littérales pour que nginx les interprète à l'exécution.
cat > "$SITE" <<'CONF'
# Port 80 : uniquement le défi ACME. Tout le reste renvoie 404 — le trafic
# applicatif ne passe qu'en HTTPS (ou via le proxy Cloudflare sur 443).
server {
    listen 80;
    listen [::]:80;
    server_name lectures.mijary.tech;

    location ^~ /.well-known/acme-challenge/ {
        auth_basic off;
        root /var/www/letsencrypt;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        return 404;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name lectures.mijary.tech;

    ssl_certificate     /etc/letsencrypt/live/lectures.mijary.tech/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lectures.mijary.tech/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    client_max_body_size 50m;
    access_log /var/log/nginx/lectures.access.log;
    error_log  /var/log/nginx/lectures.error.log warn;

    auth_basic "Lectures";
    auth_basic_user_file /etc/nginx/.htpasswd-lectures;

    # Le défi ACME doit rester joignable en HTTPS aussi : derrière le proxy
    # Cloudflare, les renouvellements arrivent par là (301 « Always Use HTTPS »).
    # Le jeton est public et à usage unique, l'exemption ne fuit aucune donnée.
    location ^~ /.well-known/acme-challenge/ {
        auth_basic off;
        root /var/www/letsencrypt;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 240s;
        proxy_buffering off;
    }
}
CONF

ln -sf "$SITE" "/etc/nginx/sites-enabled/${DOMAIN}"
nginx -t

say "4/4 · Rechargement de nginx et configuration du renouvellement"
systemctl reload nginx
install -m 0755 "$SCRIPT_DIR/reload-nginx-after-renewal.sh" \
  /etc/letsencrypt/renewal-hooks/deploy/reading-tracker.sh

printf '\n\033[32m✓ HTTPS actif : https://%s\033[0m\n' "$DOMAIN"
printf '  Identifiant : rijacloud (mot de passe inchangé)\n'
printf '  Vous pouvez maintenant remettre le record DNS en proxy Cloudflare.\n'

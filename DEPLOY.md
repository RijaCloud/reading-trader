# Déploiement sur winford-vps

L'application est accessible sur [lectures.mijary.tech](https://lectures.mijary.tech/).
Elle tourne sur le VPS `winford-vps` (161.97.107.65), derrière nginx, avec une
authentification HTTP Basic. L'identifiant est `rijacloud`.

## Architecture

```
Internet ──▶ nginx :80/:443  (auth_basic, TLS)
                 │  proxy_pass
                 ▼
           127.0.0.1:8787   node (service systemd, user « lectures »)
                 │
                 ▼
        /var/lib/reading-tracker/library.json
```

Aucun port applicatif n'est exposé : Node n'écoute que sur la boucle locale, nginx est le
seul point d'entrée.

## Emplacements

| Quoi | Où |
| --- | --- |
| Code | `/var/www/reading-tracker` (root:root, lecture seule pour le service) |
| Données | `/var/lib/reading-tracker/library.json` (user `lectures`) |
| Fichiers de lecture | `/var/lib/reading-tracker/reading-files/` (PDF et EPUB, 50 Mo maximum) |
| Sauvegardes | `/var/lib/reading-tracker/backups/` (quotidien 03:15, rotation 14 jours) |
| Runtime Node | `/opt/node22` (copie autonome de Node 22.16, indépendante de nvm) |
| Service | `/etc/systemd/system/reading-tracker.service` |
| nginx | `/etc/nginx/sites-available/lectures.mijary.tech` |
| Auth | `/etc/nginx/.htpasswd-lectures` (root:www-data, 640) |
| Logs nginx | `/var/log/nginx/lectures.access.log` et `.error.log` |
| Rechargement après renouvellement TLS | `/etc/letsencrypt/renewal-hooks/deploy/reading-tracker.sh` |

## Exploitation

```bash
systemctl status reading-tracker        # état
systemctl restart reading-tracker       # redémarrage
journalctl -u reading-tracker -f        # logs applicatifs
journalctl -u reading-tracker --since "1 hour ago"
nginx -t                                # valider nginx avant rechargement
```

## Mettre à jour l'application

Depuis le poste local, à la racine du projet :

```bash
rsync -az --delete \
  --exclude 'data/' --exclude '.git/' --exclude 'node_modules/' \
  ./ winford-vps:/var/www/reading-tracker/
ssh winford-vps 'chown -R root:root /var/www/reading-tracker && chmod -R a+rX,go-w /var/www/reading-tracker && systemctl restart reading-tracker'
```

Les données ne sont pas touchées : elles vivent dans `/var/lib/reading-tracker`, hors du
dossier de code. `--delete` est sans danger car `data/` est exclu — le dossier `data/` du
projet n'existe d'ailleurs pas sur le serveur.

## Sauvegarde et restauration

```bash
# sauvegarde manuelle
ssh winford-vps 'install -m 640 -o lectures -g lectures \
  /var/lib/reading-tracker/library.json /var/lib/reading-tracker/backups/library-manuel.json'

# récupérer une sauvegarde en local
scp winford-vps:/var/lib/reading-tracker/library.json ./lectures-vps.json

# restaurer
ssh winford-vps 'systemctl stop reading-tracker && \
  install -m 640 -o lectures -g lectures /var/lib/reading-tracker/backups/library-2026-11-19.json \
    /var/lib/reading-tracker/library.json && systemctl start reading-tracker'
```

L'export JSON depuis l'écran Réglages et la sauvegarde quotidienne couvrent le suivi.
Pour sauvegarder ou migrer les PDF et EPUB, copiez aussi le répertoire
`reading-files/` avec le JSON correspondant, en conservant le propriétaire `lectures`.

## HTTPS

Le DNS de `lectures.mijary.tech` pointe vers `161.97.107.65`. Nginx sert
l'application en HTTPS. Sur le port 80, seul le défi ACME est servi et les
autres requêtes reçoivent une réponse 404.

Le timer `certbot.timer` renouvelle le certificat Let's Encrypt via le webroot
`/var/www/letsencrypt`. Après un renouvellement réussi, le script dédié
valide la configuration nginx et recharge le service. Pour vérifier le
renouvellement depuis le Mac :

```bash
ssh winford-vps 'certbot renew --cert-name lectures.mijary.tech --dry-run --no-random-sleep-on-renew --non-interactive'
```

Pour rétablir HTTPS sur le VPS, utiliser `deploy/enable-tls.sh` avec le DNS en
place et le défi ACME déjà accessible sur le port 80.

## Fichiers récupérés par le MCP

Le service peut lancer `zlibrary-mcp` en tant qu'utilisateur `lectures` via
stdio. Renseigner `BOOK_MCP_ENTRY` avec le chemin absolu du `dist/index.js`
compilé, depuis un répertoire où ses dépendances Node et son environnement
Python `.venv` sont accessibles. Sur le VPS, le code MCP est installé sous
`/opt/reading-tracker-mcp/source`.
Le contrôle de la pagination des PDF utilise `pdfinfo`, fourni par le paquet
`poppler-utils` sur Ubuntu.

Les fichiers récupérés et leurs reçus restent dans
`/var/lib/reading-tracker/mcp-downloads/`. La copie jointe à la fiche vit dans
`reading-files/`. Le processus utilise le répertoire privé `mcp-runtime/`
pour ses fichiers de travail. Les sources dépendant d'un compte utilisent la configuration
privée du service. Les appels au MCP ne sont pas exposés directement sur Internet.

## Changer le mot de passe

```bash
PASS=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 20)
printf 'rijacloud:%s\n' "$(openssl passwd -apr1 "$PASS")" > /etc/nginx/.htpasswd-lectures
chown root:www-data /etc/nginx/.htpasswd-lectures && chmod 640 /etc/nginx/.htpasswd-lectures
echo "$PASS"
systemctl reload nginx
```

## Points d'attention

- **Les données du VPS et celles de votre Mac sont deux bases distinctes.** Ce ne sont pas
  des copies synchronisées : utilisez l'export/import JSON pour passer de l'une à l'autre.
- L'application n'a pas de compte multi-utilisateurs ; l'authentification est unique et
  déléguée à nginx.
- Les recommandations nécessitent un accès sortant à `openlibrary.org` (vérifié depuis le
  serveur).
- `ufw` est inactif sur ce serveur ; le filtrage repose sur le fournisseur et sur les
  services qui écoutent réellement. Node n'écoute pas sur l'extérieur.

# Evenly

A small, private shared-expenses app (split bills, see who owes whom, settle up) for a circle of friends.
Each person signs in with their own account. Everything they add, edit or delete is labelled with their name and `@username`.

## How it fits together

```
browser ──HTTPS──> nginx ──unix socket──> uvicorn / FastAPI (app/) ──> SQLite + receipt files (/var/lib/evenly)
                   (only /<secret>/ is routed;            serves the static UI (static/) too
                    every other URL is 404)
```

| Path | What it is |
|---|---|
| `app/main.py` | HTTP routes, CSRF check, security headers |
| `app/auth.py` | accounts (Argon2id), sessions (random token in an HttpOnly cookie, SHA-256 stored), role checks |
| `app/ledger.py` | validation, JSON shapes, repeating expenses, example data |
| `app/db.py` | SQLite connection, schema migrations (`MIGRATIONS` list, append-only) |
| `static/js/` | UI as plain ES modules, no build step: `util` (helpers), `api` (fetch), `state` (state and balance math), `views`, `dialogs`, `auth`, `main` (events and startup) |
| `manage.py` | admin CLI: list users, reset a password, back up |
| `deploy/` | systemd units, nginx template, `install.sh` |

Data model: a **ledger** is a private space (people, groups, expenses, recurring bills) shared by the accounts that are **members** of it.
Roles are `owner` (manages access and invite link), `editor` and `viewer`. A **person** in a ledger can be linked to one account ("this is me").
Only that account can rename it, and a person linked to someone else cannot be claimed. Money is stored as integer cents. The server re-checks every split.

## Security model

- **Hidden URL.** The app is served only under a random path prefix (`EVENLY_BASE_PATH`). Every other URL on the host returns 404. The page sends `Referrer-Policy: no-referrer` and loads nothing from third parties (fonts are vendored), so the secret URL never leaks through the browser.
- **Invite-only accounts.** After the first account, new accounts need a ledger invite link. Owners can rotate or turn off the link.
- **Isolation between users.** Every API call checks ledger membership on the server, and a non-member gets 404. Sessions are per user and expire after 30 days. A password change signs out other sessions. There is no admin impersonation.
- **Web protections.** CSRF is blocked by a required custom header plus an Origin check. The CSP allows `'self'` only. Logins are rate-limited (nginx, plus 10 failures per username per 15 min). Uploads are size-capped, and images are re-encoded to strip EXIF/GPS data. PDFs are served as downloads only.
- **Containment on the server.** The app runs as the `evenly` system user with no network (`PrivateNetwork`, unix socket only). Its filesystem is read-only except `/var/lib/evenly`. Other services' data, TLS keys, `/root` and `/var/www` are made inaccessible. It has no capabilities and runs with a syscall filter and memory/CPU/task caps (`systemd-analyze security evenly` → 0.4 SAFE). The code in `/opt/evenly` is owned by root. The data and backups are `0700`/`0600`.

## Operating it

```bash
# install or update (keeps the secret URL, data and certificate)
cd /root/evenly && git pull && sudo deploy/install.sh

# the private URL
sudo grep BASE_PATH /etc/evenly/evenly.env

# admin
sudo -u evenly EVENLY_DATA_DIR=/var/lib/evenly /opt/evenly/.venv/bin/python /opt/evenly/manage.py users
sudo -u evenly EVENLY_DATA_DIR=/var/lib/evenly /opt/evenly/.venv/bin/python /opt/evenly/manage.py reset-password <username>

# logs
journalctl -u evenly -f
sudo tail -f /var/log/nginx/evenly.access.log
```

**Backups** run nightly (`evenly-backup.timer`, about 03:30) into `/var/backups/evenly`, keeping 14 archives.
To restore one: `systemctl stop evenly`, extract the archive into `/var/lib/evenly` (`evenly.db` + `receipts/`), `chown -R evenly:evenly /var/lib/evenly`, `systemctl start evenly`.
These backups are on the same disk, so copy them off the server if the data matters.

**Changing the secret URL** (for example if it leaked): set a new `EVENLY_BASE_PATH` in `/etc/evenly/evenly.env`, then rerun `deploy/install.sh`. Everyone signs in again at the new URL.

**Settings** (`/etc/evenly/evenly.env`): `EVENLY_OPEN_SIGNUP=1` allows signing up without an invite. `EVENLY_TZ` sets the time zone used to decide when repeating expenses are due.

## Local development

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p /tmp/evenly-dev && EVENLY_DATA_DIR=/tmp/evenly-dev EVENLY_INSECURE_COOKIES=1 \
  .venv/bin/uvicorn app.main:app --reload --port 8765
# open http://127.0.0.1:8765/
```

Schema changes: append a new SQL string to `MIGRATIONS` in `app/db.py`. It runs once on the next start.

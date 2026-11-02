"""Server-side admin commands. Run as the service user, e.g.:

    sudo -u evenly /opt/evenly/.venv/bin/python /opt/evenly/manage.py users
    sudo -u evenly /opt/evenly/.venv/bin/python /opt/evenly/manage.py reset-password <username>
    sudo -u evenly /opt/evenly/.venv/bin/python /opt/evenly/manage.py backup <dir> [keep]
"""
import datetime
import glob
import os
import secrets
import sqlite3
import sys
import tarfile

from app import auth, config, db


def users():
    con = db.connect()
    for r in con.execute("SELECT u.username, u.name, datetime(u.created_at/1000,'unixepoch') AS created, "
                         "(SELECT COUNT(*) FROM memberships m WHERE m.user_id=u.id) AS ledgers FROM users u ORDER BY u.created_at"):
        print(f"{r['username']:<24} {r['name']:<30} ledgers={r['ledgers']:<3} created {r['created']}")


def reset_password(username):
    con = db.connect()
    u = con.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not u:
        sys.exit(f"No user named {username!r}.")
    pw = secrets.token_urlsafe(12)
    with db.tx(con):
        con.execute("UPDATE users SET pw_hash=? WHERE id=?", (auth.hash_password(pw), u["id"]))
        con.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
    print(f"Temporary password for {username}: {pw}\nAll their sessions were signed out. Ask them to change it under Settings.")


def backup(dest, keep="14"):
    """Consistent online snapshot of the database plus the receipts folder, pruned to the newest <keep>."""
    os.umask(0o077)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    snap = os.path.join(dest, f"evenly-{stamp}.db")
    src = sqlite3.connect(config.DB_PATH)
    out = sqlite3.connect(snap)
    src.backup(out)
    out.close()
    src.close()
    with tarfile.open(os.path.join(dest, f"evenly-{stamp}.tar.gz"), "w:gz") as tar:
        tar.add(snap, arcname="evenly.db")
        tar.add(config.RECEIPT_DIR, arcname="receipts")
    os.remove(snap)
    for old in sorted(glob.glob(os.path.join(dest, "evenly-*.tar.gz")))[:-int(keep)]:
        os.remove(old)
    print("backup written:", stamp)


if __name__ == "__main__":
    cmds = {"users": users, "reset-password": reset_password, "backup": backup}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    db.migrate()
    cmds[sys.argv[1]](*sys.argv[2:])

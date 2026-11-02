"""Accounts and sessions.

Sessions are opaque random tokens in an HttpOnly cookie; only their SHA-256 is stored,
so a leaked database cannot be replayed as a login. Passwords use Argon2id.
"""
import hashlib
import secrets
import time

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, HTTPException, Request, Response

from . import config, db

COOKIE = "evenly_session"
_ph = PasswordHasher()
# Verifying against this when the username does not exist keeps response times equal,
# so login timing does not reveal which usernames are registered.
_DUMMY_HASH = _ph.hash(secrets.token_hex(16))


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return secrets.token_hex(8)


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def check_password(user_row, pw: str) -> bool:
    try:
        _ph.verify(user_row["pw_hash"] if user_row else _DUMMY_HASH, pw)
        return user_row is not None
    except (VerificationError, InvalidHashError):
        return False


def _token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def start_session(con, response: Response, user_id: str) -> None:
    tok = secrets.token_urlsafe(32)
    now = now_ms()
    with db.tx(con):
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        con.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
                    (_token_hash(tok), user_id, now, now + config.SESSION_DAYS * 86400_000))
    set_cookie(response, tok)


def set_cookie(response: Response, tok: str) -> None:
    response.set_cookie(COOKIE, tok, max_age=config.SESSION_DAYS * 86400, path=config.BASE_PATH,
                        httponly=True, secure=config.SECURE_COOKIES, samesite="lax")


def end_session(con, request: Request, response: Response) -> None:
    tok = request.cookies.get(COOKIE)
    if tok:
        with db.tx(con):
            con.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(tok),))
    response.delete_cookie(COOKIE, path=config.BASE_PATH)


def end_other_sessions(con, request: Request, user_id: str) -> None:
    keep = _token_hash(request.cookies.get(COOKIE, ""))
    con.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, keep))


def get_db():
    con = db.connect()
    try:
        yield con
    finally:
        con.close()


def current_user(request: Request, con=Depends(get_db)):
    tok = request.cookies.get(COOKIE)
    if not tok:
        raise HTTPException(401, "Please sign in.")
    row = con.execute("SELECT u.id, u.username, u.name, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id "
                      "WHERE s.token_hash=?", (_token_hash(tok),)).fetchone()
    if not row or row["expires_at"] < now_ms():
        raise HTTPException(401, "Your session has ended. Please sign in again.")
    return row


ROLE_RANK = {"viewer": 0, "editor": 1, "owner": 2}


def require_member(con, ledger_id: str, user_id: str, need: str = "viewer") -> str:
    """Return the user's role in the ledger, or 404 if they are not a member.
    404 rather than 403 so ledger ids cannot be probed."""
    row = con.execute("SELECT role FROM memberships WHERE ledger_id=? AND user_id=?", (ledger_id, user_id)).fetchone()
    if not row:
        raise HTTPException(404, "Ledger not found.")
    if ROLE_RANK[row["role"]] < ROLE_RANK[need]:
        raise HTTPException(403, "You can view this ledger but not change it." if need == "editor"
                            else "Only an owner of this ledger can do that.")
    return row["role"]

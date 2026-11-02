"""Evenly HTTP API and static file server.

Layout: /api/... is JSON; everything else is the static single-page app in ../static.
nginx strips the secret public prefix, so routes here are written as if mounted at "/".
"""
import io
import os
import re
import secrets
import time
from collections import defaultdict
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, db, ledger as L
from .auth import (check_password, current_user, end_other_sessions, end_session, get_db, hash_password,
                   new_id, now_ms, require_member, start_session)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
       "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    # no-referrer: the secret URL prefix must never leak to other sites
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow",
}


@app.on_event("startup")
def _startup():
    os.makedirs(config.RECEIPT_DIR, mode=0o700, exist_ok=True)
    db.migrate()


@app.middleware("http")
async def guard(request: Request, call_next):
    # CSRF: state-changing calls must come from our own page. A custom header cannot be sent
    # cross-site without a CORS preflight (which we never approve); Origin is checked as well.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if request.headers.get("x-evenly") != "1" or (config.ORIGIN and origin and origin != config.ORIGIN):
            return JSONResponse({"detail": "Request blocked."}, status_code=403)
    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    else:
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------- request bodies ----------

class Register(BaseModel):
    username: str = Field(max_length=32)
    name: str = Field(max_length=40)
    password: str = Field(max_length=200)
    invite: Optional[str] = Field(None, max_length=64)


class Login(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=200)


class PasswordChange(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


class Profile(BaseModel):
    name: str = Field(max_length=40)


class LedgerIn(BaseModel):
    name: str = Field(max_length=60)


class MemberPatch(BaseModel):
    role: Literal["owner", "editor", "viewer"]


class Prefs(BaseModel):
    currency: Optional[str] = None
    budget: Optional[int] = Field(None, ge=0, le=L.MAX_CENTS)
    budgetCur: Optional[str] = None


class PersonIn(BaseModel):
    name: str = Field(max_length=40)
    groupIds: list[str] = Field(default_factory=list, max_length=300)
    claim: bool = False


class PersonPatch(BaseModel):
    name: Optional[str] = Field(None, max_length=40)
    deleted: Optional[bool] = None
    unlink: bool = False


class GroupIn(BaseModel):
    name: str = Field(max_length=50)
    kind: str = "Other"
    currency: str = "MDL"
    simplify: bool = True
    memberIds: list[str] = Field(default_factory=list, max_length=200)
    newNames: list[str] = Field(default_factory=list, max_length=50)


class GroupPatch(GroupIn):
    deleted: Optional[bool] = None


class ExpenseIn(BaseModel):
    type: Literal["expense", "payment"] = "expense"
    groupId: str = Field("", max_length=32)
    desc: str = Field("", max_length=200)
    category: str = Field("other", max_length=20)
    currency: str = Field(max_length=3)
    amount: int
    date: str = Field(max_length=10)
    paid: dict[str, int]
    owed: dict[str, int]
    split: dict = Field(default_factory=dict)
    notes: str = Field("", max_length=1000)
    receiptId: Optional[str] = Field(None, max_length=32)
    repeat: Literal["none", "weekly", "monthly", "yearly"] = "none"


class DeletedFlag(BaseModel):
    deleted: bool


class CommentIn(BaseModel):
    text: str = Field(max_length=300)


class RecurringPatch(BaseModel):
    active: Literal[False]


# ---------- auth ----------

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
_fails: dict[str, list[float]] = defaultdict(list)  # username -> recent failed login times (single worker)


def _throttled(key: str) -> bool:
    cutoff = time.time() - 900
    _fails[key] = [t for t in _fails[key] if t > cutoff]
    return len(_fails[key]) >= 10


def check_new_password(pw: str) -> None:
    if len(pw) < 8:
        L.bad("Use a password of at least 8 characters.")


def ledgers_for(con, user_id: str) -> list:
    rows = con.execute("SELECT l.id, l.name, m.role FROM memberships m JOIN ledgers l ON l.id=m.ledger_id "
                       "WHERE m.user_id=? ORDER BY m.joined_at", (user_id,)).fetchall()
    return [dict(r) for r in rows]


def me_json(con, user) -> dict:
    return {"user": {"id": user["id"], "username": user["username"], "name": user["name"]}, "ledgers": ledgers_for(con, user["id"])}


def invite_row(con, token: Optional[str]):
    if not token:
        return None
    return con.execute("SELECT id, name FROM ledgers WHERE invite_token=?", (token,)).fetchone()


def join_ledger(con, ledger_id: str, user_id: str) -> None:
    if len(ledgers_for(con, user_id)) >= config.LIMITS["ledgers_per_user"]:
        L.bad("You are in too many ledgers already.")
    con.execute("INSERT OR IGNORE INTO memberships(ledger_id,user_id,role,joined_at) VALUES(?,?,'editor',?)",
                (ledger_id, user_id, now_ms()))
    L.bump(con, ledger_id)


@app.get("/api/config")
def public_config(con=Depends(get_db)):
    first = con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    return {"openSignup": config.OPEN_SIGNUP or first, "firstUser": first}


@app.post("/api/auth/register")
def register(b: Register, response: Response, con=Depends(get_db)):
    if not USERNAME_RE.match(b.username):
        L.bad("Usernames are 3–32 characters: letters, digits, dot, dash or underscore.")
    name = L.text(b.name, "Your name", 40)
    check_new_password(b.password)
    inv = invite_row(con, b.invite)
    pw_hash = hash_password(b.password)
    with db.tx(con):
        first = con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        if not (first or config.OPEN_SIGNUP or inv):
            raise HTTPException(403, "You need an invite link from someone already using Evenly to create an account.")
        if con.execute("SELECT 1 FROM users WHERE username=?", (b.username,)).fetchone():
            L.bad("That username is taken. Try another one.")
        uid = new_id()
        con.execute("INSERT INTO users(id,username,name,pw_hash,created_at) VALUES(?,?,?,?,?)",
                    (uid, b.username, name, pw_hash, now_ms()))
        if inv:
            join_ledger(con, inv["id"], uid)
    start_session(con, response, uid)
    return {"ok": True, "joined": inv["id"] if inv else None}


@app.post("/api/auth/login")
def login(b: Login, response: Response, con=Depends(get_db)):
    key = b.username.lower()
    if _throttled(key):
        raise HTTPException(429, "Too many failed attempts. Wait 15 minutes and try again.")
    u = con.execute("SELECT * FROM users WHERE username=?", (b.username,)).fetchone()
    if not check_password(u, b.password):
        _fails[key].append(time.time())
        raise HTTPException(401, "That username and password do not match.")
    _fails.pop(key, None)
    start_session(con, response, u["id"])
    return {"ok": True}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, con=Depends(get_db)):
    end_session(con, request, response)
    return {"ok": True}


@app.post("/api/auth/password")
def change_password(b: PasswordChange, request: Request, user=Depends(current_user), con=Depends(get_db)):
    u = con.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    if not check_password(u, b.current):
        raise HTTPException(403, "Your current password is not right.")
    check_new_password(b.new)
    with db.tx(con):
        con.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(b.new), user["id"]))
        end_other_sessions(con, request, user["id"])
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(current_user), con=Depends(get_db)):
    return me_json(con, user)


@app.patch("/api/me")
def update_me(b: Profile, user=Depends(current_user), con=Depends(get_db)):
    name = L.text(b.name, "Your name", 40)
    with db.tx(con):
        con.execute("UPDATE users SET name=? WHERE id=?", (name, user["id"]))
        for r in con.execute("SELECT ledger_id FROM memberships WHERE user_id=?", (user["id"],)).fetchall():
            L.bump(con, r["ledger_id"])
    return {"ok": True}


# ---------- ledgers, members, invites ----------

@app.post("/api/ledgers")
def create_ledger(b: LedgerIn, user=Depends(current_user), con=Depends(get_db)):
    name = L.text(b.name, "Ledger name", 60)
    lid, now = new_id(), now_ms()
    with db.tx(con):
        if len(ledgers_for(con, user["id"])) >= config.LIMITS["ledgers_per_user"]:
            L.bad("You are in too many ledgers already.")
        con.execute("INSERT INTO ledgers(id,name,invite_token,created_by,created_at) VALUES(?,?,?,?,?)",
                    (lid, name, secrets.token_urlsafe(18), user["id"], now))
        con.execute("INSERT INTO memberships(ledger_id,user_id,role,joined_at) VALUES(?,?,'owner',?)", (lid, user["id"], now))
        con.execute("INSERT INTO people(id,ledger_id,name,user_id,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)",
                    (new_id(), lid, user["name"], user["id"], now, user["id"], now, user["id"]))
    return {"id": lid}


@app.get("/api/ledgers/{lid}/state")
def ledger_state(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"])
    L.run_recurring(con, lid)
    return L.ledger_state(con, lid, user["id"])


@app.get("/api/ledgers/{lid}/version")
def ledger_version(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"])
    return {"version": con.execute("SELECT version FROM ledgers WHERE id=?", (lid,)).fetchone()[0]}


@app.patch("/api/ledgers/{lid}")
def rename_ledger(lid: str, b: LedgerIn, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "owner")
    with db.tx(con):
        con.execute("UPDATE ledgers SET name=? WHERE id=?", (L.text(b.name, "Ledger name", 60), lid))
        L.bump(con, lid)
    return {"ok": True}


@app.delete("/api/ledgers/{lid}")
def delete_ledger(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "owner")
    files = [r["id"] for r in con.execute("SELECT id FROM receipts WHERE ledger_id=?", (lid,))]
    with db.tx(con):
        con.execute("DELETE FROM ledgers WHERE id=?", (lid,))
    for rid in files:
        try:
            os.remove(os.path.join(config.RECEIPT_DIR, rid))
        except FileNotFoundError:
            pass
    return {"ok": True}


@app.post("/api/ledgers/{lid}/invite")
def new_invite(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "owner")
    tok = secrets.token_urlsafe(18)
    with db.tx(con):
        con.execute("UPDATE ledgers SET invite_token=? WHERE id=?", (tok, lid))
        L.bump(con, lid)
    return {"inviteToken": tok}


@app.delete("/api/ledgers/{lid}/invite")
def stop_invite(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "owner")
    with db.tx(con):
        con.execute("UPDATE ledgers SET invite_token=NULL WHERE id=?", (lid,))
        L.bump(con, lid)
    return {"ok": True}


@app.get("/api/invites/{token}")
def invite_info(token: str, con=Depends(get_db)):
    inv = invite_row(con, token)
    if not inv:
        raise HTTPException(404, "This invite link is no longer valid. Ask for a new one.")
    return {"ledgerId": inv["id"], "ledgerName": inv["name"]}


@app.post("/api/invites/{token}/accept")
def accept_invite(token: str, user=Depends(current_user), con=Depends(get_db)):
    inv = invite_row(con, token)
    if not inv:
        raise HTTPException(404, "This invite link is no longer valid. Ask for a new one.")
    with db.tx(con):
        join_ledger(con, inv["id"], user["id"])
    return {"ledgerId": inv["id"]}


def _owner_count(con, lid):
    return con.execute("SELECT COUNT(*) FROM memberships WHERE ledger_id=? AND role='owner'", (lid,)).fetchone()[0]


@app.patch("/api/ledgers/{lid}/members/{uid}")
def set_role(lid: str, uid: str, b: MemberPatch, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "owner")
    with db.tx(con):
        cur = con.execute("SELECT role FROM memberships WHERE ledger_id=? AND user_id=?", (lid, uid)).fetchone()
        if not cur:
            raise HTTPException(404, "Not a member.")
        if cur["role"] == "owner" and b.role != "owner" and _owner_count(con, lid) == 1:
            L.bad("A ledger needs at least one owner.")
        con.execute("UPDATE memberships SET role=? WHERE ledger_id=? AND user_id=?", (b.role, lid, uid))
        L.bump(con, lid)
    return {"ok": True}


@app.delete("/api/ledgers/{lid}/members/{uid}")
def remove_member(lid: str, uid: str, user=Depends(current_user), con=Depends(get_db)):
    """Owners can remove anyone; anyone can remove themselves (leave)."""
    require_member(con, lid, user["id"], "viewer" if uid == user["id"] else "owner")
    with db.tx(con):
        cur = con.execute("SELECT role FROM memberships WHERE ledger_id=? AND user_id=?", (lid, uid)).fetchone()
        if not cur:
            raise HTTPException(404, "Not a member.")
        if cur["role"] == "owner" and _owner_count(con, lid) == 1:
            L.bad("Make someone else an owner first, or delete the ledger.")
        con.execute("DELETE FROM memberships WHERE ledger_id=? AND user_id=?", (lid, uid))
        # the person record (and its history) stays, it just is no longer tied to that account
        con.execute("UPDATE people SET user_id=NULL WHERE ledger_id=? AND user_id=?", (lid, uid))
        L.bump(con, lid)
    return {"ok": True}


@app.put("/api/ledgers/{lid}/prefs")
def set_prefs(lid: str, b: Prefs, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"])
    for c in (b.currency, b.budgetCur):
        if c is not None and c not in L.CURRENCIES:
            L.bad("Unknown currency.")
    with db.tx(con):
        row = con.execute("SELECT prefs FROM memberships WHERE ledger_id=? AND user_id=?", (lid, user["id"])).fetchone()
        prefs = {**db.loads(row["prefs"], {}), **b.model_dump(exclude_unset=True)}
        con.execute("UPDATE memberships SET prefs=? WHERE ledger_id=? AND user_id=?", (db.dumps(prefs), lid, user["id"]))
    return {"ok": True}


# ---------- people ----------

def _person(con, lid, pid):
    p = con.execute("SELECT * FROM people WHERE id=? AND ledger_id=?", (pid, lid)).fetchone()
    if not p:
        raise HTTPException(404, "Person not found.")
    return p


def _my_person(con, lid, uid):
    return con.execute("SELECT id FROM people WHERE ledger_id=? AND user_id=?", (lid, uid)).fetchone()


@app.post("/api/ledgers/{lid}/people")
def add_person(lid: str, b: PersonIn, user=Depends(current_user), con=Depends(get_db)):
    # Adding yourself ("I'm not in the list") is allowed for viewers too; adding others needs edit rights.
    require_member(con, lid, user["id"], "viewer" if b.claim else "editor")
    name = L.text(b.name, "Name", 40)
    pid, now = new_id(), now_ms()
    with db.tx(con):
        L.check_limit(con, "people", "people", lid)
        if b.claim and _my_person(con, lid, user["id"]):
            L.bad("You are already linked to someone in this ledger.")
        con.execute("INSERT INTO people(id,ledger_id,name,user_id,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)",
                    (pid, lid, name, user["id"] if b.claim else None, now, user["id"], now, user["id"]))
        for gid in b.groupIds:
            g = con.execute("SELECT member_ids FROM ledger_groups WHERE id=? AND ledger_id=? AND deleted=0", (gid, lid)).fetchone()
            if g:
                con.execute("UPDATE ledger_groups SET member_ids=?, updated_at=?, updated_by=? WHERE id=?",
                            (db.dumps(db.loads(g["member_ids"]) + [pid]), now, user["id"], gid))
        L.bump(con, lid)
    return {"id": pid}


@app.patch("/api/ledgers/{lid}/people/{pid}")
def edit_person(lid: str, pid: str, b: PersonPatch, user=Depends(current_user), con=Depends(get_db)):
    role = require_member(con, lid, user["id"])
    with db.tx(con):
        p = _person(con, lid, pid)
        mine = p["user_id"] == user["id"]
        if b.unlink:
            # releasing your own link is always fine; unlinking someone else is an owner action
            if not p["user_id"] or not (mine or role == "owner"):
                raise HTTPException(403, "Only an owner can unlink someone else's account.")
            con.execute("UPDATE people SET user_id=NULL, updated_at=?, updated_by=? WHERE id=?", (now_ms(), user["id"], pid))
        if b.name is not None:
            if p["user_id"] and not mine:
                raise HTTPException(403, "Only that person can rename themselves.")
            if not mine and role == "viewer":
                raise HTTPException(403, "You can view this ledger but not change it.")
            con.execute("UPDATE people SET name=?, updated_at=?, updated_by=? WHERE id=?",
                        (L.text(b.name, "Name", 40), now_ms(), user["id"], pid))
        if b.deleted is not None:
            require_member(con, lid, user["id"], "editor")
            if b.deleted and p["user_id"]:
                L.bad("This person is linked to an account. They need to leave the ledger, or an owner must remove them, first.")
            con.execute("UPDATE people SET deleted=?, updated_at=?, updated_by=? WHERE id=?", (int(b.deleted), now_ms(), user["id"], pid))
        L.bump(con, lid)
    return {"ok": True}


@app.post("/api/ledgers/{lid}/people/{pid}/claim")
def claim_person(lid: str, pid: str, user=Depends(current_user), con=Depends(get_db)):
    """Link your account to an existing person ("this is me"). Each person can belong to one account,
    and each account to one person per ledger. Everyone sees which account a person is linked to."""
    require_member(con, lid, user["id"])
    with db.tx(con):
        p = _person(con, lid, pid)
        if p["deleted"]:
            L.bad("That person was removed.")
        if p["user_id"] and p["user_id"] != user["id"]:
            raise HTTPException(409, "That person is already linked to another account.")
        con.execute("UPDATE people SET user_id=NULL WHERE ledger_id=? AND user_id=?", (lid, user["id"]))
        con.execute("UPDATE people SET user_id=?, updated_at=?, updated_by=? WHERE id=?", (user["id"], now_ms(), user["id"], pid))
        L.bump(con, lid)
    return {"ok": True}


# ---------- groups ----------

def _group_cols(con, lid, b: GroupIn, user):
    name = L.text(b.name, "Group name", 50)
    if b.currency not in L.CURRENCIES:
        L.bad("Unknown currency.")
    people = L.ledger_people(con, lid)
    members = [m for m in dict.fromkeys(b.memberIds) if m in people]
    now = now_ms()
    for n in b.newNames:
        n = L.text(n, "Name", 40, required=False)
        if not n:
            continue
        existing = con.execute("SELECT id FROM people WHERE ledger_id=? AND deleted=0 AND lower(name)=lower(?)", (lid, n)).fetchone()
        if existing:
            members.append(existing["id"])
            continue
        L.check_limit(con, "people", "people", lid)
        pid = new_id()
        con.execute("INSERT INTO people(id,ledger_id,name,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)",
                    (pid, lid, n, now, user["id"], now, user["id"]))
        members.append(pid)
    members = list(dict.fromkeys(members))
    if not members:
        L.bad("Add at least one member.")
    return {"name": name, "kind": b.kind if b.kind in L.KINDS else "Other", "currency": b.currency,
            "simplify": int(b.simplify), "member_ids": db.dumps(members)}


@app.post("/api/ledgers/{lid}/groups")
def add_group(lid: str, b: GroupIn, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    gid, now = new_id(), now_ms()
    with db.tx(con):
        L.check_limit(con, "ledger_groups", "groups", lid)
        cols = _group_cols(con, lid, b, user)
        row = {"id": gid, "ledger_id": lid, **cols, "created_at": now, "created_by": user["id"], "updated_at": now, "updated_by": user["id"]}
        con.execute(f"INSERT INTO ledger_groups({','.join(row)}) VALUES({','.join('?' * len(row))})", tuple(row.values()))
        L.bump(con, lid)
    return {"id": gid}


@app.put("/api/ledgers/{lid}/groups/{gid}")
def edit_group(lid: str, gid: str, b: GroupPatch, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    with db.tx(con):
        if not con.execute("SELECT 1 FROM ledger_groups WHERE id=? AND ledger_id=?", (gid, lid)).fetchone():
            raise HTTPException(404, "Group not found.")
        cols = _group_cols(con, lid, b, user)
        if b.deleted is not None:
            cols["deleted"] = int(b.deleted)
        cols.update(updated_at=now_ms(), updated_by=user["id"])
        con.execute(f"UPDATE ledger_groups SET {', '.join(k + '=?' for k in cols)} WHERE id=?", (*cols.values(), gid))
        L.bump(con, lid)
    return {"ok": True}


@app.patch("/api/ledgers/{lid}/groups/{gid}")
def delete_group(lid: str, gid: str, b: DeletedFlag, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    with db.tx(con):
        n = con.execute("UPDATE ledger_groups SET deleted=?, updated_at=?, updated_by=? WHERE id=? AND ledger_id=?",
                        (int(b.deleted), now_ms(), user["id"], gid, lid)).rowcount
        if not n:
            raise HTTPException(404, "Group not found.")
        L.bump(con, lid)
    return {"ok": True}


# ---------- expenses ----------

def _expense(con, lid, eid):
    e = con.execute("SELECT * FROM expenses WHERE id=? AND ledger_id=?", (eid, lid)).fetchone()
    if not e:
        raise HTTPException(404, "Expense not found.")
    return e


@app.post("/api/ledgers/{lid}/expenses")
def add_expense(lid: str, b: ExpenseIn, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    with db.tx(con):
        L.check_limit(con, "expenses", "expenses", lid)
        cols = L.clean_expense(con, lid, b)
        rid = None
        if b.repeat != "none" and b.type == "expense":
            L.check_limit(con, "recurring", "recurring", lid)
            rid, now = new_id(), now_ms()
            start = L.parse_date(b.date)
            tmpl = {k: cols[k] for k in ("group_id", "type", "descr", "category", "currency", "amount", "paid", "owed", "split", "notes")}
            # the browser reads template.desc / template.amount / template.currency for the settings list
            tmpl.update(desc=cols["descr"])
            con.execute("INSERT INTO recurring(id,ledger_id,group_id,template,freq,anchor_day,next_date,created_at,created_by,updated_at,updated_by) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (rid, lid, cols["group_id"], db.dumps(tmpl), b.repeat, start.day,
                         L.advance(start, b.repeat, start.day).isoformat(), now, user["id"], now, user["id"]))
        eid = L.insert_expense(con, lid, cols, user["id"], recurring_id=rid)
        L.bump(con, lid)
    return {"id": eid}


@app.put("/api/ledgers/{lid}/expenses/{eid}")
def edit_expense(lid: str, eid: str, b: ExpenseIn, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    with db.tx(con):
        old = _expense(con, lid, eid)
        if old["type"] != b.type:
            L.bad("An expense cannot be turned into a payment, or the other way round.")
        cols = L.clean_expense(con, lid, b, old)
        cols.update(updated_at=now_ms(), updated_by=user["id"])
        con.execute(f"UPDATE expenses SET {', '.join(k + '=?' for k in cols)} WHERE id=?", (*cols.values(), eid))
        L.bump(con, lid)
    return {"ok": True}


@app.patch("/api/ledgers/{lid}/expenses/{eid}")
def delete_expense(lid: str, eid: str, b: DeletedFlag, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    now = now_ms()
    with db.tx(con):
        _expense(con, lid, eid)
        if b.deleted:
            con.execute("UPDATE expenses SET deleted=1, deleted_at=?, deleted_by=? WHERE id=?", (now, user["id"], eid))
        else:
            con.execute("UPDATE expenses SET deleted=0, updated_at=?, updated_by=? WHERE id=?", (now, user["id"], eid))
        L.bump(con, lid)
    return {"ok": True}


@app.post("/api/ledgers/{lid}/expenses/{eid}/comments")
def add_comment(lid: str, eid: str, b: CommentIn, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    t = L.text(b.text, "Comment", 300)
    with db.tx(con):
        _expense(con, lid, eid)
        if con.execute("SELECT COUNT(*) FROM comments WHERE expense_id=?", (eid,)).fetchone()[0] >= config.LIMITS["comments"]:
            L.bad("This expense has too many comments.")
        con.execute("INSERT INTO comments(expense_id,user_id,text,at) VALUES(?,?,?,?)", (eid, user["id"], t, now_ms()))
        L.bump(con, lid)
    return {"ok": True}


@app.patch("/api/ledgers/{lid}/recurring/{rid}")
def stop_recurring(lid: str, rid: str, b: RecurringPatch, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    with db.tx(con):
        n = con.execute("UPDATE recurring SET active=0, updated_at=?, updated_by=? WHERE id=? AND ledger_id=?",
                        (now_ms(), user["id"], rid, lid)).rowcount
        if not n:
            raise HTTPException(404, "Not found.")
        L.bump(con, lid)
    return {"ok": True}


@app.post("/api/ledgers/{lid}/example")
def example(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    return {"groupId": L.load_example(con, lid, user)}


@app.delete("/api/ledgers/{lid}/example")
def remove_example(lid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    L.clear_example(con, lid)
    return {"ok": True}


# ---------- receipts ----------

def _process_upload(data: bytes, ctype: str):
    """Re-encode images (drops EXIF/GPS metadata and anything smuggled inside the file)
    and accept PDFs only by signature. Returns (bytes, mime)."""
    if data.startswith(b"%PDF-"):
        return data, "application/pdf"
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 50_000_000
    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in ("JPEG", "PNG", "WEBP", "GIF"):
            raise ValueError
        img = ImageOps.exif_transpose(img)
        img.thumbnail((2400, 2400))
        if img.mode not in ("RGB", "L"):
            bg = Image.new("RGB", img.size, "white")
            rgba = img.convert("RGBA")
            bg.paste(rgba, mask=rgba.split()[3])
            img = bg
        out = io.BytesIO()
        img.save(out, "JPEG", quality=85, optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception:
        L.bad("Receipts can be a photo (JPEG, PNG, WebP) or a PDF.")


@app.post("/api/ledgers/{lid}/receipts")
async def upload_receipt(lid: str, request: Request, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"], "editor")
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > config.MAX_UPLOAD_BYTES:
            L.bad("That file is too large. The limit is 8 MB.")
    if not data:
        L.bad("The file is empty.")
    body, mime = await run_in_threadpool(_process_upload, data, request.headers.get("content-type", ""))
    used = con.execute("SELECT COALESCE(SUM(size),0) FROM receipts WHERE ledger_id=?", (lid,)).fetchone()[0]
    if used + len(body) > config.MAX_RECEIPT_BYTES_PER_LEDGER:
        L.bad("This ledger has no room for more receipts.")
    rid = secrets.token_hex(16)
    path = os.path.join(config.RECEIPT_DIR, rid)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as f:
        f.write(body)
    with db.tx(con):
        con.execute("INSERT INTO receipts(id,ledger_id,mime,size,created_by,created_at) VALUES(?,?,?,?,?,?)",
                    (rid, lid, mime, len(body), user["id"], now_ms()))
    return {"id": rid}


@app.get("/api/ledgers/{lid}/receipts/{rid}")
def get_receipt(lid: str, rid: str, user=Depends(current_user), con=Depends(get_db)):
    require_member(con, lid, user["id"])
    r = con.execute("SELECT mime FROM receipts WHERE id=? AND ledger_id=?", (rid, lid)).fetchone()
    if not r or not re.fullmatch(r"[0-9a-f]{32}", rid):
        raise HTTPException(404, "Not found.")
    pdf = r["mime"] == "application/pdf"
    return FileResponse(os.path.join(config.RECEIPT_DIR, rid), media_type=r["mime"],
                        filename=f"receipt-{rid[:8]}.pdf" if pdf else None,
                        content_disposition_type="attachment" if pdf else "inline",
                        headers={"Cache-Control": "private, max-age=86400", "Content-Security-Policy": "default-src 'none'; sandbox"})


# ---------- static single-page app (registered last so /api routes win) ----------

@app.get("/api/{rest:path}")
def api_404(rest: str):
    raise HTTPException(404, "Not found.")


app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")

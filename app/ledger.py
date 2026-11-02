"""Ledger domain logic: validation rules, row <-> JSON shapes, repeating expenses, example data.

Money is always an integer number of cents. The browser computes splits for display, but every
write is re-checked here: the server never trusts that paid/owed add up or that ids belong to the ledger.
"""
import calendar
import datetime as dt
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from . import config, db
from .auth import new_id, now_ms

CATEGORIES = {"food", "groceries", "rent", "utilities", "transport", "travel", "fun", "shopping",
              "health", "gifts", "household", "other"}
CURRENCIES = {"MDL", "EUR", "USD", "RON", "GBP", "UAH", "PLN", "CHF", "TRY", "CZK", "HUF", "BGN"}
KINDS = {"Trip", "Home", "Couple", "Friends", "Work", "Other"}
METHODS = {"equal", "exact", "percent", "shares", "adjust"}
FREQS = {"weekly", "monthly", "yearly"}
MAX_CENTS = 10**11


def bad(msg: str):
    raise HTTPException(422, msg)


def today() -> dt.date:
    return dt.datetime.now(ZoneInfo(config.TZ)).date()


def parse_date(s: str) -> dt.date:
    try:
        d = dt.date.fromisoformat(s)
    except (TypeError, ValueError):
        bad("Pick a valid date.")
    if not 2000 <= d.year <= 2100:
        bad("Pick a date between 2000 and 2100.")
    return d


def advance(d: dt.date, freq: str, anchor: int) -> dt.date:
    """Next occurrence. Monthly/yearly keep the original day of month, clamped to short months."""
    if freq == "weekly":
        return d + dt.timedelta(days=7)
    y, m = divmod(d.year * 12 + (d.month - 1) + (1 if freq == "monthly" else 12), 12)
    last = calendar.monthrange(y, m + 1)[1]
    return dt.date(y, m + 1, min(anchor or d.day, last))


def bump(con, ledger_id: str) -> None:
    con.execute("UPDATE ledgers SET version=version+1 WHERE id=?", (ledger_id,))


def count(con, table: str, ledger_id: str) -> int:
    return con.execute(f"SELECT COUNT(*) FROM {table} WHERE ledger_id=?", (ledger_id,)).fetchone()[0]


def check_limit(con, table: str, key: str, ledger_id: str) -> None:
    if count(con, table, ledger_id) >= config.LIMITS[key]:
        bad(f"This ledger has reached its limit of {config.LIMITS[key]} {key}. Delete some old ones first.")


# ---------- serialisation (DB row -> the JSON shape the browser works with) ----------

def _audit(r) -> dict:
    return {"createdAt": r["created_at"], "createdBy": r["created_by"], "updatedAt": r["updated_at"], "updatedBy": r["updated_by"]}


def person_json(r) -> dict:
    return {"name": r["name"], "userId": r["user_id"], "deleted": bool(r["deleted"]), "example": bool(r["example"]), **_audit(r)}


def group_json(r) -> dict:
    return {"name": r["name"], "kind": r["kind"], "currency": r["currency"], "simplify": bool(r["simplify"]),
            "memberIds": db.loads(r["member_ids"], []), "deleted": bool(r["deleted"]), "example": bool(r["example"]), **_audit(r)}


def expense_json(r, comments) -> dict:
    return {"type": r["type"], "groupId": r["group_id"], "desc": r["descr"], "category": r["category"],
            "currency": r["currency"], "amount": r["amount"], "date": r["date"],
            "paid": db.loads(r["paid"], {}), "owed": db.loads(r["owed"], {}), "split": db.loads(r["split"], {}),
            "notes": r["notes"], "receiptId": r["receipt_id"], "recurringId": r["recurring_id"], "auto": bool(r["auto"]),
            "deleted": bool(r["deleted"]), "deletedAt": r["deleted_at"], "deletedBy": r["deleted_by"],
            "example": bool(r["example"]), "comments": comments, **_audit(r)}


def recurring_json(r) -> dict:
    return {"groupId": r["group_id"], "template": db.loads(r["template"], {}), "freq": r["freq"],
            "anchorDay": r["anchor_day"], "nextDate": r["next_date"], "active": bool(r["active"]), **_audit(r)}


def ledger_state(con, ledger_id: str, user_id: str) -> dict:
    L = con.execute("SELECT * FROM ledgers WHERE id=?", (ledger_id,)).fetchone()
    q = lambda sql: con.execute(sql, (ledger_id,)).fetchall()
    comments: dict[str, list] = {}
    for c in q("SELECT c.* FROM comments c JOIN expenses e ON e.id=c.expense_id WHERE e.ledger_id=? ORDER BY c.at"):
        comments.setdefault(c["expense_id"], []).append({"by": c["user_id"], "text": c["text"], "at": c["at"]})
    members = q("SELECT u.id, u.username, u.name, m.role, m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id "
                "WHERE m.ledger_id=? ORDER BY m.joined_at")
    # Everyone who ever touched this ledger, so the activity feed can name people who have since left.
    profiles = {r["id"]: {"name": r["name"], "username": r["username"]} for r in q(
        """SELECT id, name, username FROM users WHERE id IN (
             SELECT user_id FROM memberships WHERE ledger_id=?1
             UNION SELECT created_by FROM expenses WHERE ledger_id=?1 UNION SELECT updated_by FROM expenses WHERE ledger_id=?1
             UNION SELECT deleted_by FROM expenses WHERE ledger_id=?1 UNION SELECT created_by FROM ledger_groups WHERE ledger_id=?1
             UNION SELECT updated_by FROM ledger_groups WHERE ledger_id=?1 UNION SELECT user_id FROM people WHERE ledger_id=?1
             UNION SELECT c.user_id FROM comments c JOIN expenses e ON e.id=c.expense_id WHERE e.ledger_id=?1)""")}
    me = con.execute("SELECT role, prefs FROM memberships WHERE ledger_id=? AND user_id=?", (ledger_id, user_id)).fetchone()
    return {
        "ledger": {"id": L["id"], "name": L["name"], "version": L["version"],
                   "inviteToken": L["invite_token"] if me["role"] == "owner" else None},
        "role": me["role"],
        "prefs": db.loads(me["prefs"], {}),
        "members": [{"userId": r["id"], "username": r["username"], "name": r["name"], "role": r["role"], "joinedAt": r["joined_at"]} for r in members],
        "profiles": profiles,
        "people": {r["id"]: person_json(r) for r in q("SELECT * FROM people WHERE ledger_id=?")},
        "groups": {r["id"]: group_json(r) for r in q("SELECT * FROM ledger_groups WHERE ledger_id=?")},
        "expenses": {r["id"]: expense_json(r, comments.get(r["id"], [])) for r in q("SELECT * FROM expenses WHERE ledger_id=?")},
        "recurring": {r["id"]: recurring_json(r) for r in q("SELECT * FROM recurring WHERE ledger_id=?")},
        "receipts": {r["id"]: r["mime"] for r in q("SELECT id, mime FROM receipts WHERE ledger_id=?")},
    }


# ---------- validation ----------

def text(v, field: str, max_len: int, required=True) -> str:
    v = (v or "").strip()
    if required and not v:
        bad(f"{field} is required.")
    if len(v) > max_len:
        bad(f"{field} is too long (at most {max_len} characters).")
    return v


def ledger_people(con, ledger_id: str) -> dict:
    return {r["id"]: r for r in con.execute("SELECT id, deleted FROM people WHERE ledger_id=?", (ledger_id,))}


def check_group(con, ledger_id: str, group_id: str) -> None:
    if group_id == "":
        return
    g = con.execute("SELECT deleted FROM ledger_groups WHERE id=? AND ledger_id=?", (group_id, ledger_id)).fetchone()
    if not g or g["deleted"]:
        bad("That group does not exist.")


def money_map(m: dict, people: dict, label: str) -> dict:
    if not isinstance(m, dict) or len(m) > 200:
        bad(f"Invalid {label}.")
    out = {}
    for pid, v in m.items():
        if pid not in people:
            bad(f"Someone in {label} is not part of this ledger.")
        if not isinstance(v, int) or isinstance(v, bool) or v < 0 or v > MAX_CENTS:
            bad(f"Invalid amount in {label}.")
        if v:
            out[pid] = v
    return out


def clean_expense(con, ledger_id: str, b, old=None) -> dict:
    """Validate an expense or payment body. Returns column values."""
    people = ledger_people(con, ledger_id)
    if b.type not in ("expense", "payment"):
        bad("Unknown type.")
    if not isinstance(b.amount, int) or not 0 < b.amount <= MAX_CENTS:
        bad("Enter an amount above zero.")
    if b.currency not in CURRENCIES:
        bad("Unknown currency.")
    parse_date(b.date)
    if old is None or old["group_id"] != b.groupId:
        check_group(con, ledger_id, b.groupId)
    paid = money_map(b.paid, people, "who paid")
    owed = money_map(b.owed, people, "the split")
    # New references to removed people are refused; existing ones on an edited expense are kept.
    previous = set(db.loads(old["paid"], {})) | set(db.loads(old["owed"], {})) if old else set()
    if any(people[p]["deleted"] and p not in previous for p in {*paid, *owed}):
        bad("A removed person cannot be added to an expense.")
    if not paid or sum(paid.values()) != b.amount:
        bad("What people paid must add up to the total.")
    if not owed or sum(owed.values()) != b.amount:
        bad("The split must add up to the total.")
    category = b.category if b.category in CATEGORIES else "other"
    split = b.split if isinstance(b.split, dict) else {}
    method = split.get("method") if split.get("method") in METHODS else "exact"
    vals = split.get("vals") if isinstance(split.get("vals"), dict) else {}
    vals = {k: str(v)[:24] for k, v in list(vals.items())[:200] if k in people}
    if b.type == "payment":
        if len(paid) != 1 or len(owed) != 1 or set(paid) == set(owed):
            bad("A payment goes from one person to a different person.")
        category, method, vals = "other", "exact", {}
    receipt_id = b.receiptId or None
    if receipt_id and not con.execute("SELECT 1 FROM receipts WHERE id=? AND ledger_id=?", (receipt_id, ledger_id)).fetchone():
        bad("That receipt does not exist.")
    return {"group_id": b.groupId, "type": b.type, "descr": text(b.desc, "Description", 80) if b.type == "expense" else "Payment",
            "category": category, "currency": b.currency, "amount": b.amount, "date": b.date,
            "paid": db.dumps(paid), "owed": db.dumps(owed), "split": db.dumps({"method": method, "vals": vals}),
            "notes": text(b.notes, "Notes", 500, required=False), "receipt_id": receipt_id}


def insert_expense(con, ledger_id: str, cols: dict, user_id, **extra) -> str:
    eid = new_id()
    now = now_ms()
    row = {"id": eid, "ledger_id": ledger_id, **cols, "created_at": now, "created_by": user_id,
           "updated_at": now, "updated_by": user_id, **extra}
    con.execute(f"INSERT INTO expenses({','.join(row)}) VALUES({','.join('?' * len(row))})", tuple(row.values()))
    return eid


# ---------- repeating expenses ----------

def run_recurring(con, ledger_id: str) -> None:
    """Create any repeating expenses that have come due. Safe to call on every load:
    it runs inside one write transaction and moves next_date forward as it goes."""
    t = today().isoformat()
    if not con.execute("SELECT 1 FROM recurring WHERE ledger_id=? AND active=1 AND next_date<=?", (ledger_id, t)).fetchone():
        return
    with db.tx(con):
        due = con.execute("SELECT * FROM recurring WHERE ledger_id=? AND active=1 AND next_date<=?", (ledger_id, t)).fetchall()
        for r in due:
            if r["group_id"]:
                g = con.execute("SELECT deleted FROM ledger_groups WHERE id=?", (r["group_id"],)).fetchone()
                if not g or g["deleted"]:
                    continue
            tmpl = db.loads(r["template"], {})
            nxt, n = parse_date(r["next_date"]), 0
            while nxt.isoformat() <= t and n < 24:
                cols = {k: tmpl[k] for k in ("group_id", "type", "descr", "category", "currency", "amount", "paid", "owed", "split", "notes")}
                insert_expense(con, ledger_id, {**cols, "date": nxt.isoformat()}, r["created_by"], recurring_id=r["id"], auto=1)
                nxt = advance(nxt, r["freq"], r["anchor_day"])
                n += 1
            con.execute("UPDATE recurring SET next_date=? WHERE id=?", (nxt.isoformat(), r["id"]))
        bump(con, ledger_id)


# ---------- example data ----------

def _equal(total: int, ids: list) -> dict:
    base, rem = divmod(total, len(ids))
    return {pid: base + (1 if i < rem else 0) for i, pid in enumerate(ids)}


def load_example(con, ledger_id: str, user) -> str:
    now = now_ms()
    audit = {"created_at": now, "created_by": user["id"], "updated_at": now, "updated_by": user["id"]}

    def person(name, user_id=None):
        pid = new_id()
        con.execute("INSERT INTO people(id,ledger_id,name,user_id,example,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,1,?,?,?,?)",
                    (pid, ledger_id, name, user_id, *audit.values()))
        return pid

    with db.tx(con):
        mine = con.execute("SELECT id FROM people WHERE ledger_id=? AND user_id=?", (ledger_id, user["id"])).fetchone()
        me = mine["id"] if mine else person(user["name"], user["id"])
        alex, sam, jordan = person("Alex"), person("Sam"), person("Jordan")
        mem = [me, alex, sam, jordan]
        gid = new_id()
        con.execute("INSERT INTO ledger_groups(id,ledger_id,name,kind,currency,simplify,member_ids,example,created_at,created_by,updated_at,updated_by) "
                    "VALUES(?,?,?,?,?,1,?,1,?,?,?,?)", (gid, ledger_id, "Example: weekend in Brașov", "Trip", "EUR", db.dumps(mem), *audit.values()))
        d = lambda k: (today() - dt.timedelta(days=k)).isoformat()
        eq = {"method": "equal", "vals": {}}
        rows = [
            ("Cabin, 2 nights", "travel", 36000, d(9), {me: 36000}, _equal(36000, mem), eq),
            ("Fuel and tolls", "transport", 8450, d(9), {alex: 8450}, _equal(8450, mem), eq),
            ("Groceries at Kaufland", "groceries", 6230, d(8), {sam: 4000, jordan: 2230}, _equal(6230, mem), eq),
            ("Dinner at the old town", "food", 14800, d(8), {jordan: 14800}, {me: 4200, alex: 3600, sam: 3600, jordan: 3400},
             {"method": "exact", "vals": {me: "42.00", alex: "36.00", sam: "36.00", jordan: "34.00"}}),
            ("Bran Castle tickets", "fun", 6000, d(7), {alex: 6000}, _equal(6000, [me, alex, sam]), eq),
            ("Coffee and pastries", "food", 2350, d(7), {me: 2350}, _equal(2350, mem), eq),
        ]
        for i, (desc, cat, amt, date, paid, owed, split) in enumerate(rows):
            insert_expense(con, ledger_id, {"group_id": gid, "type": "expense", "descr": desc, "category": cat, "currency": "EUR",
                                            "amount": amt, "date": date, "paid": db.dumps(paid), "owed": db.dumps(owed),
                                            "split": db.dumps(split), "notes": ""}, user["id"], example=1, created_at=now + i)
        insert_expense(con, ledger_id, {"group_id": gid, "type": "payment", "descr": "Payment", "category": "other", "currency": "EUR",
                                        "amount": 3000, "date": d(5), "paid": db.dumps({sam: 3000}), "owed": db.dumps({me: 3000}),
                                        "split": db.dumps({"method": "exact", "vals": {}}), "notes": "Bank transfer"},
                       user["id"], example=1, created_at=now + 10)
        bump(con, ledger_id)
    return gid


def clear_example(con, ledger_id: str) -> None:
    with db.tx(con):
        con.execute("DELETE FROM expenses WHERE ledger_id=? AND example=1", (ledger_id,))
        con.execute("DELETE FROM ledger_groups WHERE ledger_id=? AND example=1", (ledger_id,))
        con.execute("DELETE FROM people WHERE ledger_id=? AND example=1", (ledger_id,))
        bump(con, ledger_id)

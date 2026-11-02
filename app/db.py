"""SQLite access: connection setup, schema migrations, transaction helper."""
import contextlib
import json
import sqlite3

from . import config

# Each entry upgrades the schema by one version (PRAGMA user_version).
# Never edit an entry that has shipped; append a new one instead.
MIGRATIONS = [
    """
    CREATE TABLE users(
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions(
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);

    CREATE TABLE ledgers(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_token TEXT UNIQUE,
      version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memberships(
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      prefs TEXT NOT NULL DEFAULT '{}',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY(ledger_id, user_id)
    );
    CREATE INDEX memberships_user ON memberships(user_id);

    CREATE TABLE people(
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      example INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER, created_by TEXT, updated_at INTEGER, updated_by TEXT
    );
    CREATE INDEX people_ledger ON people(ledger_id);
    CREATE UNIQUE INDEX people_user ON people(ledger_id, user_id) WHERE user_id IS NOT NULL;

    CREATE TABLE ledger_groups(
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      currency TEXT NOT NULL,
      simplify INTEGER NOT NULL DEFAULT 1,
      member_ids TEXT NOT NULL DEFAULT '[]',
      deleted INTEGER NOT NULL DEFAULT 0,
      example INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER, created_by TEXT, updated_at INTEGER, updated_by TEXT
    );
    CREATE INDEX groups_ledger ON ledger_groups(ledger_id);

    CREATE TABLE receipts(
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE expenses(
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK(type IN ('expense','payment')),
      descr TEXT NOT NULL,
      category TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount INTEGER NOT NULL,
      date TEXT NOT NULL,
      paid TEXT NOT NULL,
      owed TEXT NOT NULL,
      split TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      receipt_id TEXT,
      recurring_id TEXT,
      auto INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER, deleted_by TEXT,
      example INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER, created_by TEXT, updated_at INTEGER, updated_by TEXT
    );
    CREATE INDEX expenses_ledger ON expenses(ledger_id);

    CREATE TABLE comments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id TEXT,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX comments_expense ON comments(expense_id);

    CREATE TABLE recurring(
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL DEFAULT '',
      template TEXT NOT NULL,
      freq TEXT NOT NULL CHECK(freq IN ('weekly','monthly','yearly')),
      anchor_day INTEGER NOT NULL,
      next_date TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER, created_by TEXT, updated_at INTEGER, updated_by TEXT
    );
    CREATE INDEX recurring_ledger ON recurring(ledger_id);
    """,
]


def connect() -> sqlite3.Connection:
    # isolation_level=None: autocommit; writes use the explicit tx() helper below
    con = sqlite3.connect(config.DB_PATH, timeout=15, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=15000")
    return con


def migrate() -> None:
    con = connect()
    try:
        con.execute("PRAGMA journal_mode=WAL")
        current = con.execute("PRAGMA user_version").fetchone()[0]
        for i, sql in enumerate(MIGRATIONS[current:], start=current + 1):
            con.executescript("BEGIN IMMEDIATE;" + sql + f"; PRAGMA user_version={i}; COMMIT;")
    finally:
        con.close()


@contextlib.contextmanager
def tx(con: sqlite3.Connection):
    """Write transaction. BEGIN IMMEDIATE takes the write lock up front, so
    read-then-write sequences (recurring expenses, version bumps) cannot race."""
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    else:
        con.execute("COMMIT")


def dumps(v) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def loads(s, default=None):
    if s is None:
        return default
    return json.loads(s)

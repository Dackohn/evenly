"""Runtime settings, read from the environment (see deploy/evenly.env.example)."""
import os

DATA_DIR = os.environ.get("EVENLY_DATA_DIR", "/var/lib/evenly")
DB_PATH = os.environ.get("EVENLY_DB", os.path.join(DATA_DIR, "evenly.db"))
RECEIPT_DIR = os.path.join(DATA_DIR, "receipts")
STATIC_DIR = os.environ.get("EVENLY_STATIC_DIR", os.path.join(os.path.dirname(os.path.dirname(__file__)), "static"))

# Public prefix nginx serves the app under, e.g. "/k3J9.../". The session cookie is scoped to it.
BASE_PATH = "/" + os.environ.get("EVENLY_BASE_PATH", "/").strip("/") + "/"
BASE_PATH = BASE_PATH.replace("//", "/")
# Exact origin browsers send for this app, e.g. "https://evenly-1-2-3-4.sslip.io". Empty disables the check (dev only).
ORIGIN = os.environ.get("EVENLY_ORIGIN", "").rstrip("/")
# Cookies get the Secure flag unless explicitly turned off for local http testing.
SECURE_COOKIES = os.environ.get("EVENLY_INSECURE_COOKIES", "") != "1"
# 0 = only people holding a ledger invite link can create an account (the first account is always allowed).
OPEN_SIGNUP = os.environ.get("EVENLY_OPEN_SIGNUP", "0") == "1"
# Time zone used to decide when repeating expenses are due.
TZ = os.environ.get("EVENLY_TZ", "Europe/Chisinau")

SESSION_DAYS = 30
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_RECEIPT_BYTES_PER_LEDGER = 500 * 1024 * 1024
LIMITS = {"people": 500, "groups": 300, "expenses": 50000, "recurring": 300, "ledgers_per_user": 20, "comments": 200}

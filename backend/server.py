"""Freepik Credit Tracker — local FastAPI backend.

Receives credit-balance snapshots from the Chrome extension, stores them in
SQLite, and serves analytics + a single-page dashboard. Bind only to
127.0.0.1 — this server is not meant to be exposed to the network.
"""
from __future__ import annotations

import hashlib
import io
import json as _json
import os
import re
import secrets
import socket
import sqlite3
import urllib.error
import urllib.request
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

VERSION = "1.1.0"

SESSION_COOKIE = "fct_session"
MEMBER_COOKIE = "fct_member_session"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60   # 7 วัน
# Session store แบบ in-memory — reset ตอน restart server (ยอมรับได้สำหรับ local tool)
_SESSIONS: dict[str, dict[str, Any]] = {}
_MEMBER_SESSIONS: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# Firebase web config (public — embedded ในหน้าเว็บ ปลอดภัยที่จะ expose)
# ---------------------------------------------------------------------------
FIREBASE_CONFIG = {
    "apiKey": os.environ.get("FIREBASE_WEB_API_KEY", ""),
    "authDomain": os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
    "projectId": os.environ.get("FIREBASE_PROJECT_ID", ""),
    "appId": os.environ.get("FIREBASE_APP_ID", ""),
    "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
    "storageBucket": os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
}
FIREBASE_ENABLED = bool(FIREBASE_CONFIG["apiKey"] and FIREBASE_CONFIG["projectId"])


# ---------------------------------------------------------------------------
# Host fingerprint — ดึงครั้งเดียวตอนโหลด module
# ---------------------------------------------------------------------------
def _detect_host() -> tuple[str, str]:
    """หา hostname + LAN IP ของเครื่องที่ backend รันอยู่ (ไม่เรียก external service)."""
    try:
        host_name = socket.gethostname()
    except Exception:
        host_name = "unknown"

    # LAN IP — connect ไป IP สมมติ (ไม่ส่งจริง) เพื่อให้ OS เลือก outbound interface
    host_ip = "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("10.255.255.255", 1))  # ไม่ resolve, ไม่ส่ง — แค่ให้ OS pick interface
            host_ip = s.getsockname()[0]
    except Exception:
        # offline หรือไม่มี interface — fallback ลองอีกแบบ
        try:
            host_ip = socket.gethostbyname(host_name)
        except Exception:
            host_ip = "127.0.0.1"
    return host_name, host_ip


HOST_NAME, HOST_IP = _detect_host()

# ---------------------------------------------------------------------------
# Paths & configuration
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("FCT_DB_PATH", BASE_DIR / "freepik_tracker.db"))
LANDING_PATH = BASE_DIR / "landing.html"
DASHBOARD_PATH = BASE_DIR / "dashboard.html"
ADMIN_PATH = BASE_DIR / "admin.html"
EXTENSION_DIR = BASE_DIR.parent / "extension"   # อยู่นอก backend/

DEFAULT_CONFIG: dict[str, str] = {
    "monthly_quota": "10000",
    "billing_cycle_day": "1",
}

# Public deployment? เมื่อ True → CORS เปิดกว้างขึ้น + cookie secure
IS_PUBLIC_DEPLOY = os.environ.get("FCT_PUBLIC_DEPLOY", "").lower() in ("1", "true", "yes")

# Reset admin บน startup (สำหรับ recovery — ลบ env หลังใช้เสร็จ!)
ADMIN_RESET_ON_BOOT = os.environ.get("ADMIN_RESET_ON_BOOT", "").lower() in ("1", "true", "yes")


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
@contextmanager
def db_conn() -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection with row-factory enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """Create tables, run lightweight migrations, seed default config rows."""
    with db_conn() as conn:
        # ---- 1. base tables (no indexes ที่ reference column ใหม่)
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     TEXT    NOT NULL,
                balance       REAL    NOT NULL,
                source_url    TEXT,
                user_agent    TEXT,
                profile_name  TEXT,
                host_name     TEXT,
                host_ip       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(timestamp);

            CREATE TABLE IF NOT EXISTS config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS admin_users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                username    TEXT NOT NULL UNIQUE,
                pw_hash     TEXT NOT NULL,
                pw_salt     TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sites (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                url_pattern  TEXT NOT NULL,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS credentials (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                label        TEXT,
                username     TEXT NOT NULL,
                password     TEXT NOT NULL,
                last_used_at TEXT,
                created_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_credentials_site ON credentials(site_id);

            CREATE TABLE IF NOT EXISTS members (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                phone         TEXT NOT NULL UNIQUE,
                firebase_uid  TEXT NOT NULL UNIQUE,
                display_name  TEXT,
                created_at    TEXT NOT NULL,
                last_login_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);

            CREATE TABLE IF NOT EXISTS usage_logs (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp           TEXT NOT NULL,
                action              TEXT NOT NULL,
                site_id             INTEGER REFERENCES sites(id) ON DELETE SET NULL,
                site_name           TEXT,
                credential_id       INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
                credential_label    TEXT,
                credential_username TEXT,
                member_id           INTEGER REFERENCES members(id) ON DELETE SET NULL,
                member_label        TEXT,
                source_url          TEXT,
                user_agent          TEXT,
                client_ip           TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_usage_logs_ts ON usage_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_site ON usage_logs(site_id);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_member ON usage_logs(member_id);

            -- Teams + access control
            CREATE TABLE IF NOT EXISTS teams (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS team_members (
                team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                added_at   TEXT NOT NULL,
                PRIMARY KEY (team_id, member_id)
            );
            CREATE TABLE IF NOT EXISTS team_sites (
                team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                access_type TEXT NOT NULL DEFAULT 'all',   -- 'all' หรือ 'select'
                added_at    TEXT NOT NULL,
                PRIMARY KEY (team_id, site_id)
            );
            CREATE TABLE IF NOT EXISTS team_credentials (
                team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                credential_id  INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
                added_at       TEXT NOT NULL,
                PRIMARY KEY (team_id, credential_id)
            );
            CREATE INDEX IF NOT EXISTS idx_team_members_member ON team_members(member_id);
            CREATE INDEX IF NOT EXISTS idx_team_sites_site ON team_sites(site_id);
            """
        )

        # ---- 2. migrations: เพิ่มคอลัมน์ใหม่ให้ DB เก่าโดย ALTER TABLE
        existing_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(snapshots)").fetchall()
        }
        for col_name, col_def in [
            ("profile_name", "TEXT"),
            ("host_name",    "TEXT"),
            ("host_ip",      "TEXT"),
        ]:
            if col_name not in existing_cols:
                conn.execute(f"ALTER TABLE snapshots ADD COLUMN {col_name} {col_def}")

        # usage_logs migration — เพิ่ม device_label สำหรับ Option C
        log_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(usage_logs)").fetchall()
        }
        if "device_label" not in log_cols:
            conn.execute("ALTER TABLE usage_logs ADD COLUMN device_label TEXT")

        # members table — เพิ่มคอลัมน์ email + password + enabled
        member_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(members)").fetchall()
        }
        for col_name, col_def in [
            ("email",   "TEXT"),
            ("pw_hash", "TEXT"),
            ("pw_salt", "TEXT"),
            ("enabled", "INTEGER NOT NULL DEFAULT 1"),
        ]:
            if col_name not in member_cols:
                conn.execute(f"ALTER TABLE members ADD COLUMN {col_name} {col_def}")
        # Email ต้องไม่ซ้ำ (ใช้ partial unique index — เฉพาะ row ที่ email ไม่ NULL)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email "
            "ON members(email) WHERE email IS NOT NULL"
        )

        # ---- 3. indexes ที่ขึ้นกับคอลัมน์ใหม่ (สร้างหลัง migration)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_profile ON snapshots(profile_name)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_host ON snapshots(host_name)"
        )

        # ---- 4. seed config defaults
        for key, value in DEFAULT_CONFIG.items():
            conn.execute(
                "INSERT OR IGNORE INTO config(key, value) VALUES (?, ?)",
                (key, value),
            )

        # ---- emergency reset (ถ้า user ตั้ง env เอง)
        if ADMIN_RESET_ON_BOOT:
            n = conn.execute("DELETE FROM admin_users").rowcount
            print(f"⚠️  ADMIN_RESET_ON_BOOT=1 — wiped {n} admin user(s). "
                  f"Visit /login to set up again. "
                  f"REMOVE the env var after setup!")

        # ---- 5. seed Freepik site (ครั้งแรกเท่านั้น)
        existing = conn.execute(
            "SELECT 1 FROM sites WHERE url_pattern = ?", ("*.freepik.com/*",)
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO sites(name, url_pattern, created_at) VALUES (?, ?, ?)",
                ("Freepik", "*.freepik.com/*", utc_now().isoformat()),
            )


def get_config() -> dict[str, str]:
    with db_conn() as conn:
        rows = conn.execute("SELECT key, value FROM config").fetchall()
    cfg = {**DEFAULT_CONFIG, **{r["key"]: r["value"] for r in rows}}
    return cfg


# ---------------------------------------------------------------------------
# Password hashing (scrypt — Python stdlib, ไม่มี dep เพิ่ม)
# ---------------------------------------------------------------------------
def hash_password(password: str, salt: Optional[bytes] = None) -> tuple[str, str]:
    """Return (pw_hash_hex, pw_salt_hex)."""
    if salt is None:
        salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32
    )
    return digest.hex(), salt.hex()


def verify_password(password: str, pw_hash_hex: str, pw_salt_hex: str) -> bool:
    salt = bytes.fromhex(pw_salt_hex)
    candidate, _ = hash_password(password, salt=salt)
    return secrets.compare_digest(candidate, pw_hash_hex)


# ---------------------------------------------------------------------------
# Session management (in-memory; clear on restart)
# ---------------------------------------------------------------------------
def create_session(user_id: int, username: str) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL_SECONDS)
    _SESSIONS[token] = {"user_id": user_id, "username": username, "expires": expires}
    return token


def destroy_session(token: str) -> None:
    _SESSIONS.pop(token, None)


def get_session(token: Optional[str]) -> Optional[dict[str, Any]]:
    if not token:
        return None
    sess = _SESSIONS.get(token)
    if not sess:
        return None
    if datetime.now(timezone.utc) > sess["expires"]:
        _SESSIONS.pop(token, None)
        return None
    return sess


def require_admin(fct_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
    sess = get_session(fct_session)
    if not sess:
        raise HTTPException(status_code=401, detail="not authenticated")
    return sess


def get_extension_api_key() -> Optional[str]:
    """ดึง API key จาก config ถ้ายังไม่มี → generate + เซฟ"""
    cfg = get_config()
    key = cfg.get("extension_api_key")
    if key:
        return key
    # First-time generation
    new_key = secrets.token_urlsafe(32)
    set_config({"extension_api_key": new_key})
    return new_key


def update_extension_heartbeat() -> None:
    """อัพเดท timestamp ทุกครั้งที่ extension เรียก API ด้วย API key ที่ถูกต้อง"""
    try:
        with db_conn() as conn:
            now = utc_now().isoformat()
            conn.execute(
                "INSERT INTO config(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                ("extension_last_seen", now),
            )
            conn.execute(
                "INSERT INTO config(key, value) VALUES ('extension_call_count', '1') "
                "ON CONFLICT(key) DO UPDATE SET value = "
                "CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
            )
    except Exception:
        pass  # heartbeat fail ห้ามกระทบ business logic


def require_admin_or_api_key(
    fct_session: Optional[str] = Cookie(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> str:
    """ผ่านถ้า login admin อยู่ หรือส่ง X-API-Key ที่ตรงกับ config"""
    if get_session(fct_session):
        return "session"
    expected = get_extension_api_key()
    if expected and x_api_key and secrets.compare_digest(x_api_key, expected):
        update_extension_heartbeat()
        return "api_key"
    raise HTTPException(status_code=401, detail="authentication required")


def require_admin_or_member(
    fct_session: Optional[str] = Cookie(default=None),
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """ผ่านถ้า login admin หรือ member ก็ได้ — คืน {role, ...}"""
    sess = get_session(fct_session)
    if sess:
        return {"role": "admin", **sess}
    msess = get_member_session(fct_member_session)
    if msess:
        return {"role": "member", **msess}
    raise HTTPException(status_code=401, detail="ไม่ได้เข้าสู่ระบบ")


def require_any_auth(
    fct_session: Optional[str] = Cookie(default=None),
    fct_member_session: Optional[str] = Cookie(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> str:
    """admin / member / API key — สำหรับ dashboard read endpoints"""
    if get_session(fct_session):
        return "admin"
    if get_member_session(fct_member_session):
        return "member"
    expected = get_extension_api_key()
    if expected and x_api_key and secrets.compare_digest(x_api_key, expected):
        update_extension_heartbeat()
        return "api_key"
    raise HTTPException(status_code=401, detail="ไม่ได้เข้าสู่ระบบ")


# ---------------------------------------------------------------------------
# Member sessions (Firebase Phone Auth)
# ---------------------------------------------------------------------------
def create_member_session(member_id: int, phone: str) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL_SECONDS)
    _MEMBER_SESSIONS[token] = {"member_id": member_id, "phone": phone, "expires": expires}
    return token


def get_member_session(token: Optional[str]) -> Optional[dict[str, Any]]:
    if not token:
        return None
    sess = _MEMBER_SESSIONS.get(token)
    if not sess:
        return None
    if datetime.now(timezone.utc) > sess["expires"]:
        _MEMBER_SESSIONS.pop(token, None)
        return None
    return sess


def destroy_member_session(token: str) -> None:
    _MEMBER_SESSIONS.pop(token, None)


def verify_firebase_id_token(id_token: str) -> dict[str, Any]:
    """
    Verify a Firebase ID token by calling Identity Toolkit's accounts:lookup
    REST endpoint. Returns the user record (with localId, phoneNumber, ...).
    Raises ValueError on invalid token / RuntimeError on unconfigured Firebase.
    """
    if not FIREBASE_ENABLED:
        raise RuntimeError("Firebase ไม่ได้ตั้งค่า (FIREBASE_WEB_API_KEY ว่าง)")
    api_key = FIREBASE_CONFIG["apiKey"]
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}"
    body = _json.dumps({"idToken": id_token}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = _json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            err = _json.loads(e.read())
            msg = err.get("error", {}).get("message", str(e))
        except Exception:
            msg = str(e)
        raise ValueError(f"invalid id token: {msg}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"Firebase unreachable: {e}") from e

    users = data.get("users") or []
    if not users:
        raise ValueError("invalid id token (empty users)")
    user = users[0]
    # ต้องเป็น phone-auth (มี phoneNumber) — กัน edge case ที่ token เป็น sign-in อื่น
    if not user.get("phoneNumber"):
        raise ValueError("token มาจาก sign-in method อื่น (ไม่ใช่ phone)")
    return user


# ---------------------------------------------------------------------------
# URL matching: wildcard pattern → regex
# ---------------------------------------------------------------------------
def match_url(pattern: str, url: str) -> bool:
    """Match a wildcard pattern (e.g. `*.freepik.com/*`) against a full URL."""
    if not pattern or not url:
        return False
    # normalize URL: drop scheme + query
    bare = re.sub(r"^https?://", "", url, count=1).split("#", 1)[0]
    # บาง pattern user อาจใส่ scheme — ตัดออกด้วย
    pat = re.sub(r"^https?://", "", pattern, count=1)
    # escape regex chars except *, then convert * → .*
    regex = re.escape(pat).replace(r"\*", ".*")
    return re.fullmatch(regex, bare) is not None or re.match(regex, bare) is not None


def set_config(updates: dict[str, str]) -> None:
    with db_conn() as conn:
        for key, value in updates.items():
            conn.execute(
                "INSERT INTO config(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )


# ---------------------------------------------------------------------------
# Time / cycle helpers
# ---------------------------------------------------------------------------
def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: str) -> datetime:
    # SQLite TEXT timestamps may or may not carry timezone info; assume UTC.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _safe_day(year: int, month: int, day: int) -> datetime:
    """Build a UTC midnight datetime, clamping the day to the month length."""
    # Find last valid day of (year, month)
    if month == 12:
        next_month = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        next_month = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    last_day = (next_month - timedelta(days=1)).day
    actual_day = min(day, last_day)
    return datetime(year, month, actual_day, tzinfo=timezone.utc)


def billing_cycle_window(today: datetime, cycle_day: int) -> tuple[datetime, datetime]:
    """Return (cycle_start, cycle_end_exclusive) bracketing `today` (UTC midnight)."""
    cycle_day = max(1, min(31, cycle_day))
    today_midnight = today.replace(hour=0, minute=0, second=0, microsecond=0)

    candidate = _safe_day(today.year, today.month, cycle_day)
    if candidate <= today_midnight:
        start = candidate
    else:
        prev_year = today.year - (1 if today.month == 1 else 0)
        prev_month = 12 if today.month == 1 else today.month - 1
        start = _safe_day(prev_year, prev_month, cycle_day)

    nxt_year = start.year + (1 if start.month == 12 else 0)
    nxt_month = 1 if start.month == 12 else start.month + 1
    end = _safe_day(nxt_year, nxt_month, cycle_day)
    return start, end


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class SnapshotIn(BaseModel):
    balance: float = Field(..., ge=0)
    source_url: Optional[str] = None
    timestamp: Optional[str] = None
    user_agent: Optional[str] = None
    profile_name: Optional[str] = None

    @field_validator("balance")
    @classmethod
    def _finite(cls, v: float) -> float:
        if v != v or v in (float("inf"), float("-inf")):
            raise ValueError("balance must be finite")
        return v


class ConfigPatch(BaseModel):
    monthly_quota: Optional[float] = Field(None, ge=0)
    billing_cycle_day: Optional[int] = Field(None, ge=1, le=31)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Freepik Credit Tracker", version=VERSION)

app.add_middleware(
    CORSMiddleware,
    # chrome-extension + localhost (always); + https://* on public deploy
    allow_origin_regex=(
        r"^(chrome-extension://.*|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?"
        + (r"|https://.*" if IS_PUBLIC_DEPLOY else "")
        + r")$"
    ),
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
    allow_credentials=True,
)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    # Debug log — ช่วย diagnose ปัญหา DB persistence
    try:
        with db_conn() as conn:
            ac = conn.execute("SELECT COUNT(*) FROM admin_users").fetchone()[0]
            mc = conn.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    except Exception as e:
        ac = mc = f"err: {e}"
    print(f"[FCT] startup — DB={DB_PATH} exists={DB_PATH.exists()} "
          f"size={DB_PATH.stat().st_size if DB_PATH.exists() else 0}", flush=True)
    print(f"[FCT] env FCT_DB_PATH={os.environ.get('FCT_DB_PATH', '(unset)')!r}", flush=True)
    print(f"[FCT] env ADMIN_RESET_ON_BOOT={os.environ.get('ADMIN_RESET_ON_BOOT', '(unset)')!r}", flush=True)
    print(f"[FCT] admin_users={ac}, members={mc}", flush=True)


@app.get("/api/debug/info")
def debug_info() -> dict[str, Any]:
    """ดู state ของ DB + env เพื่อ diagnose persistence issue (ลบหลังใช้เสร็จได้)"""
    with db_conn() as conn:
        ac = conn.execute("SELECT COUNT(*) FROM admin_users").fetchone()[0]
        mc = conn.execute("SELECT COUNT(*) FROM members").fetchone()[0]
        sites = conn.execute("SELECT COUNT(*) FROM sites").fetchone()[0]
        snaps = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
    return {
        "db_path": str(DB_PATH),
        "db_exists": DB_PATH.exists(),
        "db_size_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else None,
        "env_FCT_DB_PATH": os.environ.get("FCT_DB_PATH", "(unset)"),
        "env_ADMIN_RESET_ON_BOOT": os.environ.get("ADMIN_RESET_ON_BOOT", "(unset)"),
        "is_public_deploy": IS_PUBLIC_DEPLOY,
        "firebase_enabled": FIREBASE_ENABLED,
        "counts": {"admin_users": ac, "members": mc, "sites": sites, "snapshots": snaps},
    }


# ---------------------------------------------------------------------------
# Public pages: landing (root) + standalone dashboard
# ---------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
def serve_landing() -> FileResponse:
    if not LANDING_PATH.exists():
        raise HTTPException(status_code=404, detail="landing.html missing")
    return FileResponse(
        LANDING_PATH,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/dashboard", include_in_schema=False)
@app.get("/dashboard/", include_in_schema=False)
def serve_dashboard() -> FileResponse:
    if not DASHBOARD_PATH.exists():
        raise HTTPException(status_code=404, detail="dashboard.html missing")
    return FileResponse(
        DASHBOARD_PATH,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "version": VERSION,
        "host_name": HOST_NAME,
        "host_ip": HOST_IP,
    }


# ---------------------------------------------------------------------------
# Snapshot ingestion
# ---------------------------------------------------------------------------
@app.post("/api/snapshot")
def post_snapshot(
    snapshot: SnapshotIn,
    request: Request,
    _auth: str = Depends(require_admin_or_api_key),
) -> dict[str, Any]:
    ts = snapshot.timestamp
    if ts:
        try:
            ts_dt = parse_iso(ts)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid timestamp")
    else:
        ts_dt = utc_now()
    ts_iso = ts_dt.astimezone(timezone.utc).isoformat()

    user_agent = snapshot.user_agent or request.headers.get("user-agent", "")

    profile_name = (snapshot.profile_name or "").strip() or None

    # host info — backend รันในเครื่อง user เอง ดังนั้น autofill ได้เลย
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO snapshots"
            "(timestamp, balance, source_url, user_agent, profile_name, host_name, host_ip) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                ts_iso,
                float(snapshot.balance),
                snapshot.source_url,
                user_agent,
                profile_name,
                HOST_NAME,
                HOST_IP,
            ),
        )
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id}


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------
@app.get("/api/history")
def get_history(days: int = 30, _auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    days = max(1, min(365, days))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()

    sql = """
        WITH ranked AS (
            SELECT
                DATE(timestamp) AS day,
                balance,
                timestamp,
                ROW_NUMBER() OVER (PARTITION BY DATE(timestamp) ORDER BY timestamp DESC) AS rn,
                COUNT(*) OVER (PARTITION BY DATE(timestamp)) AS cnt
            FROM snapshots
            WHERE timestamp >= ?
        )
        SELECT day, balance, cnt
        FROM ranked
        WHERE rn = 1
        ORDER BY day DESC
    """
    with db_conn() as conn:
        rows = conn.execute(sql, (cutoff,)).fetchall()

    return {
        "days": [
            {"date": r["day"], "balance": r["balance"], "snapshot_count": r["cnt"]}
            for r in rows
        ]
    }


# ---------------------------------------------------------------------------
# Recent snapshots (for the dashboard table)
# ---------------------------------------------------------------------------
@app.get("/api/snapshots")
def list_snapshots(
    limit: int = 20,
    _auth: str = Depends(require_any_auth),
) -> dict[str, Any]:
    limit = max(1, min(500, limit))
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, timestamp, balance, source_url, profile_name, host_name, host_ip "
            "FROM snapshots ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {
        "snapshots": [
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "balance": r["balance"],
                "source_url": r["source_url"],
                "profile_name": r["profile_name"],
                "host_name": r["host_name"],
                "host_ip": r["host_ip"],
            }
            for r in rows
        ]
    }


# ---------------------------------------------------------------------------
# Summary / analytics
# ---------------------------------------------------------------------------
def _daily_usage_series(days_back: int) -> list[tuple[str, float]]:
    """Return [(date, credits_used_that_day), ...] across the last N days."""
    cutoff = (utc_now() - timedelta(days=days_back + 1)).isoformat()
    sql = """
        WITH ranked AS (
            SELECT
                DATE(timestamp) AS day,
                balance,
                ROW_NUMBER() OVER (PARTITION BY DATE(timestamp) ORDER BY timestamp DESC) AS rn
            FROM snapshots
            WHERE timestamp >= ?
        )
        SELECT day, balance FROM ranked WHERE rn = 1 ORDER BY day ASC
    """
    with db_conn() as conn:
        rows = conn.execute(sql, (cutoff,)).fetchall()

    series: list[tuple[str, float]] = []
    prev_balance: Optional[float] = None
    for row in rows:
        if prev_balance is not None:
            used = max(0.0, prev_balance - row["balance"])
            series.append((row["day"], used))
        prev_balance = row["balance"]
    return series


@app.get("/api/summary")
def get_summary(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    cfg = get_config()
    quota = float(cfg.get("monthly_quota", DEFAULT_CONFIG["monthly_quota"]))
    cycle_day = int(cfg.get("billing_cycle_day", DEFAULT_CONFIG["billing_cycle_day"]))

    with db_conn() as conn:
        latest = conn.execute(
            "SELECT timestamp, balance, profile_name "
            "FROM snapshots ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()

    if not latest:
        return {
            "current_balance": None,
            "monthly_quota": quota,
            "billing_cycle_day": cycle_day,
            "credits_used_this_cycle": None,
            "usage_percent": None,
            "days_in_cycle_elapsed": None,
            "days_in_cycle_remaining": None,
            "avg_daily_usage": None,
            "burn_rate_7day": None,
            "projected_zero_date": None,
            "days_until_empty": None,
            "alert_level": "ok",
            "last_snapshot_at": None,
            "profile_name": None,
        }

    current_balance = float(latest["balance"])
    last_snapshot_at = latest["timestamp"]
    profile_name = latest["profile_name"]

    today = utc_now()
    cycle_start, cycle_end = billing_cycle_window(today, cycle_day)
    today_midnight = today.replace(hour=0, minute=0, second=0, microsecond=0)
    days_elapsed = max(1, (today_midnight - cycle_start).days + 1)
    days_remaining = max(0, (cycle_end - today_midnight).days)

    credits_used_cycle = max(0.0, quota - current_balance)
    usage_percent = round((credits_used_cycle / quota) * 100.0, 1) if quota > 0 else None
    avg_daily = round(credits_used_cycle / days_elapsed, 2)

    # Burn rate from last 7 daily-usage data points.
    series = _daily_usage_series(days_back=14)
    last_7 = [used for _, used in series[-7:]]
    burn_rate_7day = round(sum(last_7) / len(last_7), 2) if last_7 else None

    # Projection
    projected_zero_date: Optional[str] = None
    days_until_empty: Optional[int] = None
    if burn_rate_7day and burn_rate_7day > 0:
        days_until_empty = int(current_balance // burn_rate_7day)
        projected_zero_date = (today_midnight + timedelta(days=days_until_empty)).date().isoformat()

    # Alert level
    if days_until_empty is None:
        alert_level = "ok"
    elif days_until_empty < 7 or days_until_empty < days_remaining * 0.5:
        alert_level = "critical"
    elif days_until_empty < 14:
        alert_level = "warning"
    else:
        alert_level = "ok"

    return {
        "current_balance": current_balance,
        "monthly_quota": quota,
        "billing_cycle_day": cycle_day,
        "cycle_start": cycle_start.date().isoformat(),
        "cycle_end": cycle_end.date().isoformat(),
        "credits_used_this_cycle": round(credits_used_cycle, 2),
        "usage_percent": usage_percent,
        "days_in_cycle_elapsed": days_elapsed,
        "days_in_cycle_remaining": days_remaining,
        "avg_daily_usage": avg_daily,
        "burn_rate_7day": burn_rate_7day,
        "projected_zero_date": projected_zero_date,
        "days_until_empty": days_until_empty,
        "alert_level": alert_level,
        "last_snapshot_at": last_snapshot_at,
        "profile_name": profile_name,
    }


# ---------------------------------------------------------------------------
# Config GET / PATCH
# ---------------------------------------------------------------------------
@app.get("/api/config")
def get_config_endpoint(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    cfg = get_config()
    return {
        "monthly_quota": float(cfg["monthly_quota"]),
        "billing_cycle_day": int(cfg["billing_cycle_day"]),
    }


@app.patch("/api/config")
def patch_config(
    patch: ConfigPatch,
    _auth: str = Depends(require_admin_or_member),
) -> dict[str, Any]:
    updates: dict[str, str] = {}
    if patch.monthly_quota is not None:
        updates["monthly_quota"] = str(patch.monthly_quota)
    if patch.billing_cycle_day is not None:
        updates["billing_cycle_day"] = str(patch.billing_cycle_day)
    if not updates:
        raise HTTPException(status_code=400, detail="no fields to update")
    set_config(updates)
    return get_config_endpoint()


# ===========================================================================
# Admin auth: setup → login → logout → session check
# ===========================================================================
class AdminSetupIn(BaseModel):
    username: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=4, max_length=200)


class AdminLoginIn(BaseModel):
    username: str
    password: str


class AdminCredentialsPatch(BaseModel):
    username: Optional[str] = Field(None, min_length=3, max_length=200)
    password: Optional[str] = Field(None, min_length=4, max_length=200)


def _has_admin() -> bool:
    with db_conn() as conn:
        row = conn.execute("SELECT 1 FROM admin_users LIMIT 1").fetchone()
    return row is not None


@app.get("/api/admin/state")
def admin_state(fct_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
    """ใช้โดย admin SPA เพื่อรู้ว่าต้องไปหน้า setup, login หรือเข้าได้เลย."""
    sess = get_session(fct_session)
    return {
        "has_admin": _has_admin(),
        "logged_in": sess is not None,
        "username": sess["username"] if sess else None,
    }


@app.post("/api/admin/setup")
def admin_setup(payload: AdminSetupIn, response: Response) -> dict[str, Any]:
    if _has_admin():
        raise HTTPException(status_code=409, detail="admin already exists")
    pw_hash, pw_salt = hash_password(payload.password)
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO admin_users(username, pw_hash, pw_salt, created_at) "
            "VALUES (?, ?, ?, ?)",
            (payload.username, pw_hash, pw_salt, utc_now().isoformat()),
        )
        new_id = cur.lastrowid
    token = create_session(new_id, payload.username)
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS,
        httponly=True, samesite="lax", path="/",
        secure=IS_PUBLIC_DEPLOY,
    )
    return {"ok": True, "role": "admin", "username": payload.username,
            "token": token, "label": payload.username}


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginIn, response: Response) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, username, pw_hash, pw_salt FROM admin_users WHERE username = ?",
            (payload.username,),
        ).fetchone()
    if not row or not verify_password(payload.password, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(status_code=401, detail="invalid credentials")
    token = create_session(row["id"], row["username"])
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS,
        httponly=True, samesite="lax", path="/",
        secure=IS_PUBLIC_DEPLOY,
    )
    return {"ok": True, "role": "admin", "username": row["username"],
            "token": token, "label": row["username"]}


@app.patch("/api/admin/credentials")
def update_admin_credentials(
    payload: AdminCredentialsPatch,
    sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """เปลี่ยน username และ/หรือ password ของ admin ที่กำลัง login อยู่"""
    updates: dict[str, Any] = {}
    if payload.username is not None:
        updates["username"] = payload.username.strip()
    if payload.password is not None:
        pw_hash, pw_salt = hash_password(payload.password)
        updates["pw_hash"] = pw_hash
        updates["pw_salt"] = pw_salt
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [sess["user_id"]]
    try:
        with db_conn() as conn:
            conn.execute(f"UPDATE admin_users SET {set_clause} WHERE id = ?", values)
            row = conn.execute(
                "SELECT username FROM admin_users WHERE id = ?", (sess["user_id"],)
            ).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="username นี้ถูกใช้แล้ว")

    # update in-memory session ด้วย — ถ้า username เปลี่ยน
    if row:
        sess["username"] = row["username"]
    return {"ok": True, "username": row["username"] if row else None}


@app.get("/api/admin/api-key")
def get_api_key(_sess: dict = Depends(require_admin_or_member)) -> dict[str, str]:
    """API key — เปิดให้ทั้ง admin และ member ดูได้ (ใช้ตอนผูก extension ของตัวเอง)"""
    return {"api_key": get_extension_api_key()}


@app.get("/api/admin/extension/changelog")
def extension_changelog(_sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    """อ่าน CHANGELOG.json + manifest.json จาก extension folder"""
    manifest_path = EXTENSION_DIR / "manifest.json"
    changelog_path = EXTENSION_DIR / "CHANGELOG.json"

    current_version: Optional[str] = None
    if manifest_path.exists():
        try:
            mf = _json.loads(manifest_path.read_text(encoding="utf-8"))
            current_version = mf.get("version")
        except Exception:
            pass

    versions: list[dict[str, Any]] = []
    if changelog_path.exists():
        try:
            data = _json.loads(changelog_path.read_text(encoding="utf-8"))
            versions = data.get("versions", [])
        except Exception:
            pass

    # หา entry ที่ตรงกับ current version (ถ้ามี)
    current_entry = next(
        (v for v in versions if v.get("version") == current_version), None
    )
    return {
        "current_version": current_version,
        "current_entry": current_entry,
        "versions": versions,
    }


@app.get("/api/admin/extension/download")
def download_extension(_sess: dict = Depends(require_admin_or_member)) -> StreamingResponse:
    """สร้าง ZIP ของ extension folder เพื่อให้ admin ดาวน์โหลดไป install เอง"""
    if not EXTENSION_DIR.exists() or not EXTENSION_DIR.is_dir():
        raise HTTPException(
            status_code=503,
            detail=f"extension folder ไม่พบ ({EXTENSION_DIR}) — repo อาจไม่ได้รวม extension/",
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # อ่าน manifest version เพื่อใส่ใน filename
        for path in sorted(EXTENSION_DIR.rglob("*")):
            if not path.is_file():
                continue
            # skip hidden + cache files
            rel = path.relative_to(EXTENSION_DIR)
            if any(part.startswith(".") for part in rel.parts):
                continue
            if "__pycache__" in rel.parts:
                continue
            zf.write(path, arcname=str(Path("fefl-beat-extension") / rel))

        # README.txt อธิบายขั้นตอน
        zf.writestr(
            "fefl-beat-extension/README.txt",
            "FEFL Beat — Chrome Extension\n"
            "============================\n\n"
            "วิธีติดตั้ง:\n"
            "1. แตก zip นี้ออกมาเป็น folder\n"
            "2. เปิด Chrome → chrome://extensions\n"
            "3. เปิด 'Developer mode' (มุมขวาบน)\n"
            "4. กด 'Load unpacked' (มุมซ้ายบน)\n"
            "5. เลือก folder 'fefl-beat-extension' ที่แตกออกมา\n"
            "6. Pin extension ไว้บน toolbar\n\n"
            "หลัง install:\n"
            "- กลับไปที่ admin panel → เมนู Extension → กดปุ่ม\n"
            "  '🔗 เชื่อมบัญชีของฉัน' — extension จะรับ Backend URL,\n"
            "   API Key, และชื่อบัญชีคุณอัตโนมัติ\n",
        )

    buf.seek(0)
    ts = utc_now().strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="fefl-beat-extension-{ts}.zip"'
        },
    )


@app.get("/api/admin/extension/status")
def admin_extension_status(_sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    """ดู status การเชื่อมต่อ extension จาก heartbeat ที่ track ไว้"""
    cfg = get_config()
    last_seen = cfg.get("extension_last_seen")
    try:
        call_count = int(cfg.get("extension_call_count", "0"))
    except (TypeError, ValueError):
        call_count = 0

    # snapshot ล่าสุด — เอา user_agent + host info จาก extension มาแสดง
    with db_conn() as conn:
        last_snap = conn.execute(
            "SELECT user_agent, host_name, host_ip, source_url, timestamp "
            "FROM snapshots ORDER BY id DESC LIMIT 1"
        ).fetchone()

    connected = False
    age_seconds: Optional[int] = None
    if last_seen:
        try:
            then = parse_iso(last_seen)
            age_seconds = int((utc_now() - then).total_seconds())
            connected = age_seconds < 300  # 5 นาที
        except Exception:
            pass

    return {
        "connected": connected,
        "last_seen": last_seen,
        "age_seconds": age_seconds,
        "call_count": call_count,
        "last_snapshot": (
            {
                "timestamp": last_snap["timestamp"],
                "user_agent": last_snap["user_agent"],
                "host_name": last_snap["host_name"],
                "host_ip": last_snap["host_ip"],
                "source_url": last_snap["source_url"],
            }
            if last_snap
            else None
        ),
    }


@app.post("/api/admin/api-key/regenerate")
def regenerate_api_key(_sess: dict = Depends(require_admin)) -> dict[str, str]:
    new_key = secrets.token_urlsafe(32)
    set_config({"extension_api_key": new_key})
    return {"api_key": new_key}


# ===========================================================================
# Unified login (admin หรือ member ก็ได้ — ลองทั้งคู่)
# ===========================================================================
class AuthLoginIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=200)


class AuthSwitchIn(BaseModel):
    token: str = Field(..., min_length=10, max_length=200)


@app.post("/api/auth/switch")
def auth_switch(payload: AuthSwitchIn, response: Response) -> dict[str, Any]:
    """สลับ active session โดย set cookie จาก token ที่ frontend ส่งมา.
    ใช้กับ multi-profile switcher บน sidebar — frontend เก็บ token ไว้ใน
    localStorage แล้วเรียกมาเพื่อ activate session ที่ต้องการ.
    """
    token = payload.token

    # 1. ลอง admin sessions
    sess = get_session(token)
    if sess:
        response.set_cookie(
            SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS,
            httponly=True, samesite="lax", path="/",
            secure=IS_PUBLIC_DEPLOY,
        )
        # clear member cookie เพื่อไม่ให้ session คาบเกี่ยว
        response.delete_cookie(MEMBER_COOKIE, path="/")
        return {"ok": True, "role": "admin", "label": sess["username"]}

    # 2. ลอง member sessions
    msess = get_member_session(token)
    if msess:
        response.set_cookie(
            MEMBER_COOKIE, token, max_age=SESSION_TTL_SECONDS,
            httponly=True, samesite="lax", path="/",
            secure=IS_PUBLIC_DEPLOY,
        )
        response.delete_cookie(SESSION_COOKIE, path="/")
        with db_conn() as conn:
            row = conn.execute(
                "SELECT phone, email, display_name FROM members WHERE id = ?",
                (msess["member_id"],),
            ).fetchone()
        label = (row["display_name"] or row["email"] or row["phone"]) if row else "—"
        return {"ok": True, "role": "member", "label": label}

    raise HTTPException(status_code=401, detail="token หมดอายุหรือไม่ถูกต้อง")


@app.post("/api/auth/login")
def auth_login(payload: AuthLoginIn, response: Response) -> dict[str, Any]:
    """ลอง admin ก่อน ถ้าไม่ผ่าน ค่อยลอง member (treat username เป็น email)"""
    # 1) ลอง admin
    with db_conn() as conn:
        admin_row = conn.execute(
            "SELECT id, username, pw_hash, pw_salt FROM admin_users WHERE username = ?",
            (payload.username.strip(),),
        ).fetchone()
    if admin_row and verify_password(
        payload.password, admin_row["pw_hash"], admin_row["pw_salt"]
    ):
        token = create_session(admin_row["id"], admin_row["username"])
        response.set_cookie(
            SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS,
            httponly=True, samesite="lax", path="/",
            secure=IS_PUBLIC_DEPLOY,
        )
        return {
            "ok": True, "role": "admin",
            "username": admin_row["username"],
            "token": token,                        # สำหรับ multi-profile localStorage
            "label": admin_row["username"],
        }

    # 2) ลอง member (username = email)
    email = payload.username.strip().lower()
    with db_conn() as conn:
        m_row = conn.execute(
            "SELECT id, phone, email, pw_hash, pw_salt, enabled FROM members WHERE LOWER(email) = ?",
            (email,),
        ).fetchone()
    if m_row and _is_member_disabled(m_row):
        raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
    if m_row and m_row["pw_hash"] and verify_password(
        payload.password, m_row["pw_hash"], m_row["pw_salt"]
    ):
        now = utc_now().isoformat()
        with db_conn() as conn:
            conn.execute(
                "UPDATE members SET last_login_at = ? WHERE id = ?", (now, m_row["id"])
            )
            full = conn.execute(
                "SELECT phone, email, display_name FROM members WHERE id = ?", (m_row["id"],)
            ).fetchone()
        token = _set_member_cookie(response, m_row["id"], m_row["phone"])
        label = (full["display_name"] or full["email"] or full["phone"]) if full else m_row["phone"]
        return {
            "ok": True, "role": "member",
            "member_id": m_row["id"],
            "token": token,
            "label": label,
        }

    raise HTTPException(status_code=401, detail="username/อีเมล หรือ รหัสผ่าน ไม่ถูกต้อง")


@app.post("/api/admin/logout")
def admin_logout(response: Response, fct_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
    if fct_session:
        destroy_session(fct_session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ===========================================================================
# Teams + access control (admin-only)
# ===========================================================================
class TeamIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)


class TeamPatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)


class TeamMemberIn(BaseModel):
    member_id: int


class TeamSiteIn(BaseModel):
    site_id: int
    access_type: str = Field("all", pattern="^(all|select)$")
    credential_ids: Optional[list[int]] = None


class TeamSitePatchIn(BaseModel):
    access_type: Optional[str] = Field(None, pattern="^(all|select)$")
    credential_ids: Optional[list[int]] = None  # replace ทั้งชุด ถ้าส่ง


@app.get("/api/admin/teams")
def admin_list_teams(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT t.id, t.name, t.description, t.created_at, "
            "  (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count, "
            "  (SELECT COUNT(*) FROM team_sites   WHERE team_id = t.id) AS site_count "
            "FROM teams t ORDER BY t.created_at DESC"
        ).fetchall()
    return {"teams": [dict(r) for r in rows]}


@app.post("/api/admin/teams")
def admin_create_team(payload: TeamIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO teams(name, description, created_at) VALUES (?, ?, ?)",
                (payload.name.strip(), payload.description, utc_now().isoformat()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="ชื่อ team นี้ถูกใช้แล้ว")
    return {"ok": True, "id": cur.lastrowid}


@app.get("/api/admin/teams/{team_id}")
def admin_get_team(team_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        team = conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="team not found")
        members = conn.execute(
            "SELECT m.id, m.phone, m.email, m.display_name, m.enabled, tm.added_at "
            "FROM team_members tm JOIN members m ON m.id = tm.member_id "
            "WHERE tm.team_id = ? ORDER BY tm.added_at DESC",
            (team_id,),
        ).fetchall()
        sites = conn.execute(
            "SELECT s.id, s.name, s.url_pattern, ts.access_type, ts.added_at, "
            "  (SELECT COUNT(*) FROM credentials WHERE site_id = s.id) AS total_creds "
            "FROM team_sites ts JOIN sites s ON s.id = ts.site_id "
            "WHERE ts.team_id = ? ORDER BY ts.added_at DESC",
            (team_id,),
        ).fetchall()
        # สำหรับ site ที่ access_type='select' → เก็บรายชื่อ credential ที่ team เลือก
        site_creds: dict[int, list[dict[str, Any]]] = {}
        for s in sites:
            if s["access_type"] == "select":
                rows = conn.execute(
                    "SELECT c.id, c.label, c.username "
                    "FROM team_credentials tc JOIN credentials c ON c.id = tc.credential_id "
                    "WHERE tc.team_id = ? AND c.site_id = ?",
                    (team_id, s["id"]),
                ).fetchall()
                site_creds[s["id"]] = [dict(r) for r in rows]

    return {
        "team": dict(team),
        "members": [dict(m) for m in members],
        "sites": [
            {**dict(s), "credentials": site_creds.get(s["id"], [])}
            for s in sites
        ],
    }


@app.patch("/api/admin/teams/{team_id}")
def admin_update_team(
    team_id: int,
    payload: TeamPatchIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()
    if payload.description is not None:
        updates["description"] = payload.description
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [team_id]
    with db_conn() as conn:
        try:
            cur = conn.execute(f"UPDATE teams SET {set_clause} WHERE id = ?", values)
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="ชื่อ team ซ้ำกับที่มีอยู่")
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="team not found")
    return {"ok": True}


@app.delete("/api/admin/teams/{team_id}")
def admin_delete_team(team_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM teams WHERE id = ?", (team_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="team not found")
    return {"ok": True}


@app.post("/api/admin/teams/{team_id}/members")
def admin_add_team_member(
    team_id: int,
    payload: TeamMemberIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM teams WHERE id = ?", (team_id,)).fetchone():
            raise HTTPException(status_code=404, detail="team not found")
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (payload.member_id,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        try:
            conn.execute(
                "INSERT INTO team_members(team_id, member_id, added_at) VALUES (?, ?, ?)",
                (team_id, payload.member_id, utc_now().isoformat()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="member อยู่ในทีมนี้แล้ว")
    return {"ok": True}


@app.delete("/api/admin/teams/{team_id}/members/{member_id}")
def admin_remove_team_member(
    team_id: int,
    member_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute(
            "DELETE FROM team_members WHERE team_id = ? AND member_id = ?",
            (team_id, member_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/admin/teams/{team_id}/sites")
def admin_add_team_site(
    team_id: int,
    payload: TeamSiteIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM teams WHERE id = ?", (team_id,)).fetchone():
            raise HTTPException(status_code=404, detail="team not found")
        if not conn.execute("SELECT 1 FROM sites WHERE id = ?", (payload.site_id,)).fetchone():
            raise HTTPException(status_code=404, detail="site not found")
        try:
            conn.execute(
                "INSERT INTO team_sites(team_id, site_id, access_type, added_at) "
                "VALUES (?, ?, ?, ?)",
                (team_id, payload.site_id, payload.access_type, utc_now().isoformat()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="site นี้ถูกผูกกับทีมแล้ว")

        if payload.access_type == "select" and payload.credential_ids:
            for cid in payload.credential_ids:
                # ตรวจว่า credential นี้เป็นของ site นี้จริงๆ
                ok = conn.execute(
                    "SELECT 1 FROM credentials WHERE id = ? AND site_id = ?",
                    (cid, payload.site_id),
                ).fetchone()
                if ok:
                    conn.execute(
                        "INSERT OR IGNORE INTO team_credentials(team_id, credential_id, added_at) "
                        "VALUES (?, ?, ?)",
                        (team_id, cid, utc_now().isoformat()),
                    )
    return {"ok": True}


@app.patch("/api/admin/teams/{team_id}/sites/{site_id}")
def admin_update_team_site(
    team_id: int,
    site_id: int,
    payload: TeamSitePatchIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        ts = conn.execute(
            "SELECT 1 FROM team_sites WHERE team_id = ? AND site_id = ?",
            (team_id, site_id),
        ).fetchone()
        if not ts:
            raise HTTPException(status_code=404, detail="team-site not found")
        if payload.access_type:
            conn.execute(
                "UPDATE team_sites SET access_type = ? WHERE team_id = ? AND site_id = ?",
                (payload.access_type, team_id, site_id),
            )
        if payload.credential_ids is not None:
            # replace ทั้งชุด — ลบของเดิม (เฉพาะ credentials ของ site นี้)
            conn.execute(
                "DELETE FROM team_credentials WHERE team_id = ? AND credential_id IN "
                "(SELECT id FROM credentials WHERE site_id = ?)",
                (team_id, site_id),
            )
            for cid in payload.credential_ids:
                ok = conn.execute(
                    "SELECT 1 FROM credentials WHERE id = ? AND site_id = ?",
                    (cid, site_id),
                ).fetchone()
                if ok:
                    conn.execute(
                        "INSERT OR IGNORE INTO team_credentials(team_id, credential_id, added_at) "
                        "VALUES (?, ?, ?)",
                        (team_id, cid, utc_now().isoformat()),
                    )
    return {"ok": True}


@app.delete("/api/admin/teams/{team_id}/sites/{site_id}")
def admin_remove_team_site(
    team_id: int,
    site_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        # ลบ team_credentials ที่เกี่ยวกับ site นี้ก่อน
        conn.execute(
            "DELETE FROM team_credentials WHERE team_id = ? AND credential_id IN "
            "(SELECT id FROM credentials WHERE site_id = ?)",
            (team_id, site_id),
        )
        cur = conn.execute(
            "DELETE FROM team_sites WHERE team_id = ? AND site_id = ?",
            (team_id, site_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


# ===========================================================================
# Members management (admin-only)
# ===========================================================================
class MemberAdminPatch(BaseModel):
    enabled: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=4, max_length=200)


@app.get("/api/admin/members")
def admin_list_members(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, phone, email, display_name, enabled, "
            "       (pw_hash IS NOT NULL) AS has_password, "
            "       created_at, last_login_at "
            "FROM members ORDER BY created_at DESC"
        ).fetchall()
    return {
        "members": [
            {
                "id": r["id"],
                "phone": r["phone"],
                "email": r["email"],
                "display_name": r["display_name"],
                "enabled": bool(r["enabled"]) if r["enabled"] is not None else True,
                "has_password": bool(r["has_password"]),
                "created_at": r["created_at"],
                "last_login_at": r["last_login_at"],
            }
            for r in rows
        ]
    }


@app.get("/api/admin/members/{member_id}")
def admin_get_member(member_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, phone, email, display_name, enabled, "
            "       (pw_hash IS NOT NULL) AS has_password, "
            "       created_at, last_login_at "
            "FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="ไม่พบ member")
    return {
        "id": row["id"],
        "phone": row["phone"],
        "email": row["email"],
        "display_name": row["display_name"],
        "enabled": bool(row["enabled"]) if row["enabled"] is not None else True,
        "has_password": bool(row["has_password"]),
        "created_at": row["created_at"],
        "last_login_at": row["last_login_at"],
    }


@app.patch("/api/admin/members/{member_id}")
def admin_update_member(
    member_id: int,
    payload: MemberAdminPatch,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """admin: enable/disable + reset password ของ member"""
    updates: dict[str, Any] = {}
    disabled_now = False
    if payload.enabled is not None:
        updates["enabled"] = 1 if payload.enabled else 0
        disabled_now = not payload.enabled
    if payload.password is not None:
        pw_hash, pw_salt = hash_password(payload.password)
        updates["pw_hash"] = pw_hash
        updates["pw_salt"] = pw_salt
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [member_id]
    with db_conn() as conn:
        cur = conn.execute(f"UPDATE members SET {set_clause} WHERE id = ?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="ไม่พบ member")

    if disabled_now:
        n = _invalidate_member_sessions(member_id)
        return {"ok": True, "sessions_killed": n}
    return {"ok": True}


@app.delete("/api/admin/members/{member_id}")
def admin_delete_member(
    member_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ลบ member ทั้งคน (sessions + record)"""
    _invalidate_member_sessions(member_id)
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="ไม่พบ member")
    return {"ok": True}


# ===========================================================================
# Sites & Credentials (admin-protected)
# ===========================================================================
class SiteIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    url_pattern: str = Field(..., min_length=1, max_length=500)


class SitePatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    url_pattern: Optional[str] = Field(None, min_length=1, max_length=500)


class CredentialIn(BaseModel):
    label: Optional[str] = Field(None, max_length=120)
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=500)


class CredentialPatchIn(BaseModel):
    label: Optional[str] = Field(None, max_length=120)
    username: Optional[str] = Field(None, min_length=1, max_length=200)
    password: Optional[str] = Field(None, min_length=1, max_length=500)


@app.get("/api/admin/sites")
def list_sites(_sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        sites = conn.execute(
            "SELECT s.id, s.name, s.url_pattern, s.created_at, "
            "       (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count "
            "FROM sites s ORDER BY s.created_at DESC"
        ).fetchall()
    return {"sites": [dict(r) for r in sites]}


@app.post("/api/admin/sites")
def create_site(payload: SiteIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO sites(name, url_pattern, created_at) VALUES (?, ?, ?)",
            (payload.name, payload.url_pattern, utc_now().isoformat()),
        )
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id}


@app.get("/api/admin/sites/{site_id}")
def get_site(site_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        site = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        if not site:
            raise HTTPException(status_code=404, detail="site not found")
        creds = conn.execute(
            "SELECT id, label, username, password, last_used_at, created_at "
            "FROM credentials WHERE site_id = ? ORDER BY created_at DESC",
            (site_id,),
        ).fetchall()
    return {
        "site": dict(site),
        "credentials": [dict(c) for c in creds],
    }


@app.delete("/api/admin/sites/{site_id}")
def delete_site(site_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        # foreign key cascade จะลบ credentials ให้
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM credentials WHERE site_id = ?", (site_id,))
        cur = conn.execute("DELETE FROM sites WHERE id = ?", (site_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="site not found")
    return {"ok": True}


@app.patch("/api/admin/sites/{site_id}")
def update_site(
    site_id: int,
    payload: SitePatchIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """แก้ไขชื่อ + URL pattern ของ site"""
    updates: dict[str, Any] = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()
    if payload.url_pattern is not None:
        updates["url_pattern"] = payload.url_pattern.strip()
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [site_id]
    with db_conn() as conn:
        cur = conn.execute(f"UPDATE sites SET {set_clause} WHERE id = ?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="site not found")
    return {"ok": True}


@app.patch("/api/admin/credentials/{cred_id}")
def update_credential(
    cred_id: int,
    payload: CredentialPatchIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """แก้ไข label / username / password ของ credential"""
    updates: dict[str, Any] = {}
    if payload.label is not None:
        v = payload.label.strip()
        updates["label"] = v or None
    if payload.username is not None:
        updates["username"] = payload.username.strip()
    if payload.password is not None:
        updates["password"] = payload.password
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [cred_id]
    with db_conn() as conn:
        cur = conn.execute(f"UPDATE credentials SET {set_clause} WHERE id = ?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="credential not found")
    return {"ok": True}


@app.post("/api/admin/sites/{site_id}/credentials")
def add_credential(
    site_id: int,
    payload: CredentialIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        site = conn.execute("SELECT 1 FROM sites WHERE id = ?", (site_id,)).fetchone()
        if not site:
            raise HTTPException(status_code=404, detail="site not found")
        cur = conn.execute(
            "INSERT INTO credentials(site_id, label, username, password, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (site_id, payload.label, payload.username, payload.password, utc_now().isoformat()),
        )
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id}


@app.delete("/api/admin/credentials/{cred_id}")
def delete_credential(cred_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM credentials WHERE id = ?", (cred_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="credential not found")
    return {"ok": True}


# ===========================================================================
# Extension-facing endpoints (no admin auth — local only)
# ===========================================================================
@app.get("/api/extension/match")
def extension_match(
    url: str,
    member_id: Optional[int] = None,
    _auth: str = Depends(require_admin_or_api_key),
) -> dict[str, Any]:
    """ตรวจว่า URL ตรงกับ site ใดที่ลงทะเบียนไว้ ถ้าใช่ คืน credentials.

    Filter ด้วย team:
    - ถ้า site ไม่ถูกผูกกับทีมใดเลย → ทุก member + admin เห็น credentials ทั้งหมด
    - ถ้า site ถูกผูกกับทีม → เฉพาะ member ในทีมที่มีสิทธิ์ + admin (member_id=None)
    - access_type='all'   → เห็น credentials ทั้งหมดของ site
    - access_type='select' → เห็นเฉพาะ credentials ที่ team_credentials ระบุ
    - Member ในหลายทีม → union (ถ้าทีมใดทีมหนึ่งมี 'all' → เห็นทั้งหมด)
    """
    with db_conn() as conn:
        sites = conn.execute("SELECT id, name, url_pattern FROM sites").fetchall()
        matched_id = None
        matched_site = None
        for s in sites:
            if match_url(s["url_pattern"], url):
                matched_id = s["id"]
                matched_site = dict(s)
                break
        if matched_id is None:
            return {"matched": False}

        team_restricted = conn.execute(
            "SELECT 1 FROM team_sites WHERE site_id = ? LIMIT 1", (matched_id,)
        ).fetchone() is not None

        if not team_restricted or member_id is None:
            # Public site OR caller ไม่ใช่ member (admin-paired) → คืนทุก credential
            creds = conn.execute(
                "SELECT id, label, username, password "
                "FROM credentials WHERE site_id = ? "
                "ORDER BY last_used_at DESC NULLS LAST, created_at DESC",
                (matched_id,),
            ).fetchall()
        else:
            # Site ถูก restrict + caller เป็น member → เช็คว่าเข้าได้มั้ย
            access_rows = conn.execute(
                "SELECT ts.access_type FROM team_members tm "
                "JOIN team_sites ts ON ts.team_id = tm.team_id "
                "WHERE ts.site_id = ? AND tm.member_id = ?",
                (matched_id, member_id),
            ).fetchall()
            if not access_rows:
                # Member ไม่อยู่ในทีมที่มีสิทธิ์ → คืน credentials ว่าง
                creds = []
            elif any(r["access_type"] == "all" for r in access_rows):
                # อย่างน้อย 1 ทีมให้ access 'all' → คืนทุก credential
                creds = conn.execute(
                    "SELECT id, label, username, password "
                    "FROM credentials WHERE site_id = ? "
                    "ORDER BY last_used_at DESC NULLS LAST, created_at DESC",
                    (matched_id,),
                ).fetchall()
            else:
                # ทุกทีมเป็น 'select' → เอา credentials ที่ team_credentials ระบุไว้ (union)
                creds = conn.execute(
                    "SELECT DISTINCT c.id, c.label, c.username, c.password "
                    "FROM credentials c "
                    "WHERE c.site_id = ? AND c.id IN ("
                    "  SELECT tc.credential_id FROM team_credentials tc "
                    "  JOIN team_members tm ON tm.team_id = tc.team_id "
                    "  WHERE tm.member_id = ?"
                    ") "
                    "ORDER BY c.last_used_at DESC NULLS LAST, c.created_at DESC",
                    (matched_id, member_id),
                ).fetchall()

    return {
        "matched": True,
        "site": matched_site,
        "credentials": [dict(c) for c in creds],
    }


@app.post("/api/extension/heartbeat")
def extension_heartbeat(_auth: str = Depends(require_admin_or_api_key)) -> dict[str, Any]:
    """Endpoint เบาๆ — เรียกเพื่อ bump heartbeat อย่างเดียว (ไม่มี side effect)"""
    return {"ok": True, "ts": utc_now().isoformat()}


class CredentialUsedIn(BaseModel):
    source_url: Optional[str] = Field(None, max_length=2000)
    member_id: Optional[int] = None      # ถ้า extension paired กับ member
    user_label: Optional[str] = Field(None, max_length=200)  # ชื่อ user ที่ pair (admin หรือ member)
    device_label: Optional[str] = Field(None, max_length=200)  # ชื่อเครื่อง (auto-detect หรือ manual)


@app.post("/api/extension/credentials/{cred_id}/used")
def mark_used(
    cred_id: int,
    request: Request,
    payload: Optional[CredentialUsedIn] = None,
    _auth: str = Depends(require_admin_or_api_key),
) -> dict[str, Any]:
    """แจ้ง backend ว่า credential ถูกใช้ — update last_used_at + insert usage log"""
    now = utc_now().isoformat()
    source_url = payload.source_url if payload else None
    member_id = payload.member_id if payload else None
    user_label_in = payload.user_label if payload else None
    device_label = payload.device_label if payload else None
    user_agent = request.headers.get("user-agent", "")[:500] if request else ""
    client_ip = (request.client.host if request and request.client else "")[:64]

    with db_conn() as conn:
        cred = conn.execute(
            "SELECT c.id, c.label, c.username, c.site_id, "
            "       s.name AS site_name "
            "FROM credentials c LEFT JOIN sites s ON s.id = c.site_id "
            "WHERE c.id = ?",
            (cred_id,),
        ).fetchone()
        if not cred:
            raise HTTPException(status_code=404, detail="credential not found")

        # ลำดับ: lookup จาก member_id → fallback user_label จาก extension config
        member_label = None
        if member_id:
            mrow = conn.execute(
                "SELECT phone, email, display_name FROM members WHERE id = ?",
                (member_id,),
            ).fetchone()
            if mrow:
                member_label = mrow["display_name"] or mrow["email"] or mrow["phone"]
        if not member_label and user_label_in:
            member_label = user_label_in[:200]

        conn.execute(
            "UPDATE credentials SET last_used_at = ? WHERE id = ?",
            (now, cred_id),
        )
        conn.execute(
            "INSERT INTO usage_logs(timestamp, action, "
            "  site_id, site_name, credential_id, credential_label, credential_username, "
            "  member_id, member_label, source_url, user_agent, client_ip, device_label) "
            "VALUES (?, 'prefill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                now,
                cred["site_id"], cred["site_name"],
                cred_id, cred["label"], cred["username"],
                member_id, member_label,
                source_url, user_agent, client_ip, device_label,
            ),
        )
    return {"ok": True}


# ===========================================================================
# Usage logs (admin-only)
# ===========================================================================
@app.get("/api/admin/logs")
def admin_list_logs(
    limit: int = 100,
    site_id: Optional[int] = None,
    credential_id: Optional[int] = None,
    member_id: Optional[int] = None,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ดู log การใช้งาน — สามารถ filter ตาม site/credential/member"""
    limit = max(1, min(1000, limit))
    where: list[str] = []
    params: list[Any] = []
    if site_id is not None:
        where.append("site_id = ?")
        params.append(site_id)
    if credential_id is not None:
        where.append("credential_id = ?")
        params.append(credential_id)
    if member_id is not None:
        where.append("member_id = ?")
        params.append(member_id)
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""
    sql = (
        "SELECT id, timestamp, action, "
        "       site_id, site_name, credential_id, credential_label, credential_username, "
        "       member_id, member_label, source_url, user_agent, client_ip, device_label "
        f"FROM usage_logs {where_clause} ORDER BY timestamp DESC LIMIT ?"
    )
    params.append(limit)
    with db_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        total = conn.execute("SELECT COUNT(*) FROM usage_logs").fetchone()[0]
    return {
        "logs": [dict(r) for r in rows],
        "total": total,
    }


# ===========================================================================
# Member: Firebase Phone Auth
# ===========================================================================
class MemberVerifyIn(BaseModel):
    id_token: str = Field(..., min_length=20)


class MemberLoginIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=1, max_length=200)


class MemberProfileIn(BaseModel):
    display_name: Optional[str] = Field(None, max_length=120)
    email: Optional[str] = Field(None, max_length=200)
    password: Optional[str] = Field(None, min_length=4, max_length=200)


def _require_member_session(token: Optional[str]) -> dict[str, Any]:
    sess = get_member_session(token)
    if not sess:
        raise HTTPException(status_code=401, detail="ไม่ได้เข้าสู่ระบบ")
    return sess


def _member_row_to_profile(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "phone": row["phone"],
        "email": row["email"],
        "display_name": row["display_name"],
        "has_password": bool(row["pw_hash"]),
        "created_at": row["created_at"],
        "last_login_at": row["last_login_at"],
    }


def _is_member_disabled(row: sqlite3.Row) -> bool:
    """row ต้องมี column 'enabled' (อาจ NULL ใน DB เก่ามากๆ — treat as enabled)"""
    if row is None:
        return False
    try:
        v = row["enabled"]
    except (KeyError, IndexError):
        return False
    return v == 0


def _invalidate_member_sessions(member_id: int) -> int:
    """ล้าง session ของ member นี้ออกจาก in-memory store"""
    to_remove = [tok for tok, s in _MEMBER_SESSIONS.items() if s["member_id"] == member_id]
    for tok in to_remove:
        _MEMBER_SESSIONS.pop(tok, None)
    return len(to_remove)


def _set_member_cookie(response: Response, member_id: int, phone: str) -> str:
    token = create_member_session(member_id, phone)
    response.set_cookie(
        MEMBER_COOKIE, token, max_age=SESSION_TTL_SECONDS,
        httponly=True, samesite="lax", path="/",
        secure=IS_PUBLIC_DEPLOY,
    )
    return token


@app.get("/api/firebase/config")
def firebase_config_endpoint() -> dict[str, Any]:
    """Public web config — embedded in client JS"""
    return {"enabled": FIREBASE_ENABLED, **FIREBASE_CONFIG}


@app.post("/api/member/verify")
def member_verify(payload: MemberVerifyIn, response: Response) -> dict[str, Any]:
    """
    Frontend ทำ Firebase Phone Auth สำเร็จแล้วส่ง ID token มา
    Backend verify ผ่าน REST → upsert member → set session cookie
    """
    try:
        user = verify_firebase_id_token(payload.id_token)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))

    firebase_uid = user["localId"]
    phone = user["phoneNumber"]
    display_name = user.get("displayName") or None
    now = utc_now().isoformat()

    with db_conn() as conn:
        existing = conn.execute(
            "SELECT id, enabled FROM members WHERE firebase_uid = ?", (firebase_uid,)
        ).fetchone()
        if existing and _is_member_disabled(existing):
            raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
        if existing:
            conn.execute(
                "UPDATE members SET phone = ?, display_name = COALESCE(?, display_name), "
                "last_login_at = ? WHERE id = ?",
                (phone, display_name, now, existing["id"]),
            )
            member_id = existing["id"]
            is_new = False
        else:
            cur = conn.execute(
                "INSERT INTO members(phone, firebase_uid, display_name, created_at, last_login_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (phone, firebase_uid, display_name, now, now),
            )
            member_id = cur.lastrowid
            is_new = True

    token = _set_member_cookie(response, member_id, phone)
    return {"ok": True, "role": "member", "member_id": member_id, "phone": phone,
            "is_new": is_new, "token": token, "label": display_name or phone}


@app.post("/api/member/login")
def member_login(payload: MemberLoginIn, response: Response) -> dict[str, Any]:
    """Login ด้วย email + password (เลือกใช้แทน OTP สำหรับคนที่ตั้งรหัสไว้แล้ว)"""
    email = payload.email.strip().lower()
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, phone, email, pw_hash, pw_salt, enabled FROM members WHERE LOWER(email) = ?",
            (email,),
        ).fetchone()
    if not row or not row["pw_hash"]:
        raise HTTPException(status_code=401, detail="email หรือ password ไม่ถูกต้อง")
    if _is_member_disabled(row):
        raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
    if not verify_password(payload.password, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(status_code=401, detail="email หรือ password ไม่ถูกต้อง")

    now = utc_now().isoformat()
    with db_conn() as conn:
        conn.execute(
            "UPDATE members SET last_login_at = ? WHERE id = ?", (now, row["id"])
        )
    token = _set_member_cookie(response, row["id"], row["phone"])
    return {"ok": True, "role": "member", "member_id": row["id"],
            "token": token, "label": row["email"]}


@app.patch("/api/member/profile")
def member_update_profile(
    payload: MemberProfileIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """Update display_name / email / password — ต้อง login member อยู่"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]

    updates: dict[str, Any] = {}
    if payload.display_name is not None:
        # อนุญาตให้ลบชื่อด้วย empty string
        v = payload.display_name.strip()
        updates["display_name"] = v or None
    if payload.email is not None:
        v = payload.email.strip().lower()
        if v and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", v):
            raise HTTPException(status_code=400, detail="รูปแบบอีเมลไม่ถูกต้อง")
        updates["email"] = v or None
    if payload.password is not None:
        pw_hash, pw_salt = hash_password(payload.password)
        updates["pw_hash"] = pw_hash
        updates["pw_salt"] = pw_salt

    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [member_id]
    try:
        with db_conn() as conn:
            conn.execute(f"UPDATE members SET {set_clause} WHERE id = ?", values)
            row = conn.execute(
                "SELECT id, phone, email, display_name, pw_hash, created_at, last_login_at "
                "FROM members WHERE id = ?",
                (member_id,),
            ).fetchone()
    except sqlite3.IntegrityError as e:
        # email ซ้ำ
        raise HTTPException(status_code=409, detail="อีเมลนี้ถูกใช้แล้ว") from e

    return {"ok": True, "member": _member_row_to_profile(row)}


@app.post("/api/member/logout")
def member_logout(
    response: Response,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    if fct_member_session:
        destroy_member_session(fct_member_session)
    response.delete_cookie(MEMBER_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/member/me")
def member_me(
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = get_member_session(fct_member_session)
    if not sess:
        return {"logged_in": False}
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, phone, email, display_name, pw_hash, created_at, last_login_at "
            "FROM members WHERE id = ?",
            (sess["member_id"],),
        ).fetchone()
    if not row:
        return {"logged_in": False}
    return {"logged_in": True, "member": _member_row_to_profile(row)}


# ===========================================================================
# Member pages (HTML)
# ===========================================================================
LOGIN_PATH = BASE_DIR / "login.html"


@app.get("/login", include_in_schema=False)
def serve_member_login() -> FileResponse:
    if not LOGIN_PATH.exists():
        raise HTTPException(status_code=404, detail="login.html missing")
    return FileResponse(LOGIN_PATH, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store"})


@app.get("/profile", include_in_schema=False)
def serve_profile_redirect() -> RedirectResponse:
    """หน้า /profile เก่าถูกย้ายไปอยู่ใน admin SPA แล้ว — redirect ไป /admin#/account"""
    return RedirectResponse(url="/admin#/account", status_code=302)


# ===========================================================================
# Admin SPA + login pages (HTML)
# ===========================================================================
@app.get("/admin", include_in_schema=False)
@app.get("/admin/", include_in_schema=False)
def serve_admin() -> FileResponse:
    if not ADMIN_PATH.exists():
        raise HTTPException(status_code=404, detail="admin.html missing")
    return FileResponse(ADMIN_PATH, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store"})


@app.get("/admin/login", include_in_schema=False)
def serve_admin_login_redirect() -> RedirectResponse:
    """รวมหน้า login เป็น /login เดียว — ระบบ auto-detect role จาก credential"""
    return RedirectResponse(url="/login", status_code=302)


# ---------------------------------------------------------------------------
# Generic error handling — keep responses JSON for the extension.
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)})


if __name__ == "__main__":
    import uvicorn

    # Production (Railway): bind 0.0.0.0 + ใช้ $PORT
    # Local: bind 127.0.0.1 + port 8765
    default_host = "0.0.0.0" if IS_PUBLIC_DEPLOY else "127.0.0.1"
    default_port = os.environ.get("PORT") or os.environ.get("FCT_PORT") or "8765"

    uvicorn.run(
        "server:app",
        host=os.environ.get("FCT_HOST", default_host),
        port=int(default_port),
        reload=False,
    )

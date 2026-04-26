"""Freepik Credit Tracker — local FastAPI backend.

Receives credit-balance snapshots from the Chrome extension, stores them in
SQLite, and serves analytics + a single-page dashboard. Bind only to
127.0.0.1 — this server is not meant to be exposed to the network.
"""
from __future__ import annotations

import hashlib
import json as _json
import os
import re
import secrets
import socket
import sqlite3
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
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
ADMIN_LOGIN_PATH = BASE_DIR / "admin_login.html"

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

        # members table — เพิ่มคอลัมน์ email + password เพื่อให้ login ได้สองวิธี
        member_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(members)").fetchall()
        }
        for col_name, col_def in [
            ("email",   "TEXT"),
            ("pw_hash", "TEXT"),
            ("pw_salt", "TEXT"),
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
                  f"Visit /admin/login to set up again. "
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


def require_admin_or_api_key(
    fct_session: Optional[str] = Cookie(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> str:
    """ผ่านถ้า login admin อยู่ หรือส่ง X-API-Key ที่ตรงกับ config"""
    if get_session(fct_session):
        return "session"
    expected = get_extension_api_key()
    if expected and x_api_key and secrets.compare_digest(x_api_key, expected):
        return "api_key"
    raise HTTPException(status_code=401, detail="authentication required")


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
def get_history(days: int = 30, _auth: str = Depends(require_admin_or_api_key)) -> dict[str, Any]:
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
    _auth: str = Depends(require_admin_or_api_key),
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
def get_summary(_auth: str = Depends(require_admin_or_api_key)) -> dict[str, Any]:
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
def get_config_endpoint(_auth: str = Depends(require_admin_or_api_key)) -> dict[str, Any]:
    cfg = get_config()
    return {
        "monthly_quota": float(cfg["monthly_quota"]),
        "billing_cycle_day": int(cfg["billing_cycle_day"]),
    }


@app.patch("/api/config")
def patch_config(
    patch: ConfigPatch,
    _auth: str = Depends(require_admin_or_api_key),
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
    return {"ok": True, "username": payload.username}


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
    return {"ok": True, "username": row["username"]}


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
def get_api_key(_sess: dict = Depends(require_admin)) -> dict[str, str]:
    return {"api_key": get_extension_api_key()}


@app.post("/api/admin/api-key/regenerate")
def regenerate_api_key(_sess: dict = Depends(require_admin)) -> dict[str, str]:
    new_key = secrets.token_urlsafe(32)
    set_config({"extension_api_key": new_key})
    return {"api_key": new_key}


@app.post("/api/admin/logout")
def admin_logout(response: Response, fct_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
    if fct_session:
        destroy_session(fct_session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ===========================================================================
# Sites & Credentials (admin-protected)
# ===========================================================================
class SiteIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    url_pattern: str = Field(..., min_length=1, max_length=500)


class CredentialIn(BaseModel):
    label: Optional[str] = Field(None, max_length=120)
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=500)


@app.get("/api/admin/sites")
def list_sites(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
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
    _auth: str = Depends(require_admin_or_api_key),
) -> dict[str, Any]:
    """ตรวจว่า URL ตรงกับ site ใดที่ลงทะเบียนไว้ ถ้าใช่ คืน credentials"""
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
        creds = conn.execute(
            "SELECT id, label, username, password "
            "FROM credentials WHERE site_id = ? ORDER BY last_used_at DESC NULLS LAST, created_at DESC",
            (matched_id,),
        ).fetchall()
    return {
        "matched": True,
        "site": matched_site,
        "credentials": [dict(c) for c in creds],
    }


@app.post("/api/extension/credentials/{cred_id}/used")
def mark_used(
    cred_id: int,
    _auth: str = Depends(require_admin_or_api_key),
) -> dict[str, Any]:
    """แจ้ง backend ว่า credential ถูกใช้ — update last_used_at"""
    with db_conn() as conn:
        conn.execute(
            "UPDATE credentials SET last_used_at = ? WHERE id = ?",
            (utc_now().isoformat(), cred_id),
        )
    return {"ok": True}


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
    password: Optional[str] = Field(None, min_length=6, max_length=200)


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


def _set_member_cookie(response: Response, member_id: int, phone: str) -> None:
    token = create_member_session(member_id, phone)
    response.set_cookie(
        MEMBER_COOKIE, token, max_age=SESSION_TTL_SECONDS,
        httponly=True, samesite="lax", path="/",
        secure=IS_PUBLIC_DEPLOY,
    )


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
            "SELECT id FROM members WHERE firebase_uid = ?", (firebase_uid,)
        ).fetchone()
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

    _set_member_cookie(response, member_id, phone)
    return {"ok": True, "member_id": member_id, "phone": phone, "is_new": is_new}


@app.post("/api/member/login")
def member_login(payload: MemberLoginIn, response: Response) -> dict[str, Any]:
    """Login ด้วย email + password (เลือกใช้แทน OTP สำหรับคนที่ตั้งรหัสไว้แล้ว)"""
    email = payload.email.strip().lower()
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, phone, email, pw_hash, pw_salt FROM members WHERE LOWER(email) = ?",
            (email,),
        ).fetchone()
    if not row or not row["pw_hash"]:
        raise HTTPException(status_code=401, detail="email หรือ password ไม่ถูกต้อง")
    if not verify_password(payload.password, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(status_code=401, detail="email หรือ password ไม่ถูกต้อง")

    now = utc_now().isoformat()
    with db_conn() as conn:
        conn.execute(
            "UPDATE members SET last_login_at = ? WHERE id = ?", (now, row["id"])
        )
    _set_member_cookie(response, row["id"], row["phone"])
    return {"ok": True, "member_id": row["id"]}


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
PROFILE_PATH = BASE_DIR / "profile.html"


@app.get("/login", include_in_schema=False)
def serve_member_login() -> FileResponse:
    if not LOGIN_PATH.exists():
        raise HTTPException(status_code=404, detail="login.html missing")
    return FileResponse(LOGIN_PATH, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store"})


@app.get("/profile", include_in_schema=False)
def serve_profile() -> FileResponse:
    if not PROFILE_PATH.exists():
        raise HTTPException(status_code=404, detail="profile.html missing")
    return FileResponse(PROFILE_PATH, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store"})


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
def serve_admin_login() -> FileResponse:
    if not ADMIN_LOGIN_PATH.exists():
        raise HTTPException(status_code=404, detail="admin_login.html missing")
    return FileResponse(ADMIN_LOGIN_PATH, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store"})


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

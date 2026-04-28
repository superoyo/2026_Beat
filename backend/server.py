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

            -- Card owners (for sites' billing info)
            CREATE TABLE IF NOT EXISTS card_owners (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                created_at  TEXT NOT NULL
            );

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

            -- v1.11 — ให้สิทธิ์ credential กับ member โดยตรง (bypass team)
            CREATE TABLE IF NOT EXISTS credential_members (
                credential_id  INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
                member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                added_at       TEXT NOT NULL,
                PRIMARY KEY (credential_id, member_id)
            );

            -- v1.13 — ขอสิทธิ์เข้าถึง site (member request → admin accept/reject)
            CREATE TABLE IF NOT EXISTS access_requests (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                requested_at   TEXT NOT NULL,
                status         TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'accepted' | 'rejected'
                note           TEXT,                              -- เหตุผล/ข้อความจาก member
                decided_at     TEXT,
                decided_by     TEXT                               -- 'admin:username' หรือ 'member:N'
            );
            CREATE INDEX IF NOT EXISTS idx_team_members_member ON team_members(member_id);
            CREATE INDEX IF NOT EXISTS idx_team_sites_site ON team_sites(site_id);
            CREATE INDEX IF NOT EXISTS idx_credential_members_member ON credential_members(member_id);
            CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
            CREATE INDEX IF NOT EXISTS idx_access_requests_member ON access_requests(member_id);
            -- ป้องกัน duplicate pending request (1 member ต่อ 1 site ต่อ 1 pending)
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_access_request_pending
                ON access_requests(member_id, site_id) WHERE status = 'pending';
            """
        )

        # ---- 2. migrations: เพิ่มคอลัมน์ใหม่ให้ DB เก่าโดย ALTER TABLE
        existing_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(snapshots)").fetchall()
        }
        for col_name, col_def in [
            ("profile_name",  "TEXT"),
            ("profile_email", "TEXT"),
            ("host_name",     "TEXT"),
            ("host_ip",       "TEXT"),
            ("credits_spent", "REAL"),   # v1.8.0 — Spent value (จะมาคู่กับ balance)
        ]:
            if col_name not in existing_cols:
                conn.execute(f"ALTER TABLE snapshots ADD COLUMN {col_name} {col_def}")

        # usage_logs migration — เพิ่ม device_label สำหรับ Option C
        log_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(usage_logs)").fetchall()
        }
        if "device_label" not in log_cols:
            conn.execute("ALTER TABLE usage_logs ADD COLUMN device_label TEXT")

        # sites migration — เพิ่มข้อมูล billing/lifecycle
        site_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(sites)").fetchall()
        }
        for col_name, col_def in [
            ("renew_day",     "INTEGER"),                           # 1-31 (ใช้กับ monthly เท่านั้น)
            ("card_owner_id", "INTEGER REFERENCES card_owners(id) ON DELETE SET NULL"),
            ("cancelled",     "INTEGER NOT NULL DEFAULT 0"),
            ("cancelled_at",  "TEXT"),                              # ISO date
            ("payment_type",  "TEXT"),                              # ดู PAYMENT_TYPES ด้านล่าง
            ("usage_reason",  "TEXT"),                              # free text
            # v1.9 — รอบบิล + ค่าใช้จ่าย + ช่วงเวลา
            ("billing_cycle", "TEXT"),                              # 'monthly' | 'yearly' | NULL
            ("cost_amount",   "REAL"),                              # ค่าใช้จ่าย (per cycle)
            ("cost_currency", "TEXT"),                              # 'THB' | 'USD' | etc.
            ("start_date",    "TEXT"),                              # ISO date — วันเริ่มต้น
            ("end_date",      "TEXT"),                              # ISO date — วันสิ้นสุด (NULL = ongoing)
            # v1.12 — site logo (square, base64 data URL)
            ("logo_data",     "TEXT"),                              # data:image/png;base64,...
        ]:
            if col_name not in site_cols:
                conn.execute(f"ALTER TABLE sites ADD COLUMN {col_name} {col_def}")

        # credentials table — billing/lifecycle fields ย้ายมาจาก sites (v1.10)
        # หลังจากนี้ user จะ config ที่ระดับ credential แทน site
        cred_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(credentials)").fetchall()
        }
        for col_name, col_def in [
            ("renew_day",     "INTEGER"),
            ("card_owner_id", "INTEGER REFERENCES card_owners(id) ON DELETE SET NULL"),
            ("cancelled",     "INTEGER NOT NULL DEFAULT 0"),
            ("cancelled_at",  "TEXT"),
            ("payment_type",  "TEXT"),
            ("usage_reason",  "TEXT"),
            ("billing_cycle", "TEXT"),
            ("cost_amount",   "REAL"),
            ("cost_currency", "TEXT"),
            ("start_date",    "TEXT"),
            ("end_date",      "TEXT"),
        ]:
            if col_name not in cred_cols:
                conn.execute(f"ALTER TABLE credentials ADD COLUMN {col_name} {col_def}")

        # members table — เพิ่มคอลัมน์ email + password + enabled
        member_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(members)").fetchall()
        }
        for col_name, col_def in [
            ("email",       "TEXT"),
            ("pw_hash",     "TEXT"),
            ("pw_salt",     "TEXT"),
            ("enabled",     "INTEGER NOT NULL DEFAULT 1"),
            ("is_admin",    "INTEGER NOT NULL DEFAULT 0"),
            # v1.15 — avatar (square photo, base64 data URL)
            ("avatar_data", "TEXT"),
            # v1.17 — extension version tracking (per-member)
            ("extension_version",      "TEXT"),
            ("extension_last_used_at", "TEXT"),
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


def _member_is_admin(member_id: int) -> bool:
    """ตรวจว่า member นี้ถูก promote เป็น admin หรือยัง"""
    try:
        with db_conn() as conn:
            row = conn.execute(
                "SELECT is_admin FROM members WHERE id = ?", (member_id,)
            ).fetchone()
        return bool(row and row["is_admin"])
    except Exception:
        return False


def require_admin(
    fct_session: Optional[str] = Cookie(default=None),
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """ผ่านถ้าเป็น super admin (admin_users) หรือ member ที่มี is_admin=1"""
    sess = get_session(fct_session)
    if sess:
        return {**sess, "role": "admin", "is_super": True}
    msess = get_member_session(fct_member_session)
    if msess and _member_is_admin(msess["member_id"]):
        return {**msess, "role": "admin", "is_super": False}
    raise HTTPException(status_code=401, detail="ต้องเป็น admin เท่านั้น")


def require_super_admin(
    fct_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """เฉพาะ super admin (admin_users) — ใช้กับ ops ที่กระทบ admin หลัก"""
    sess = get_session(fct_session)
    if not sess:
        raise HTTPException(
            status_code=403,
            detail="ต้องเป็น super admin (เข้าด้วย username/password ของ admin หลัก) เท่านั้น",
        )
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


def record_member_extension_use(member_id: Optional[int], version: Optional[str]) -> None:
    """บันทึก extension version ของ member นี้ + timestamp ล่าสุดที่ใช้ extension
    เรียกจาก endpoint ที่ extension ส่ง member_id มา (paired-as-member)
    Header: X-FCT-Version จาก background.js
    """
    if not member_id or not version:
        return
    # validation อย่างหลวม — version ควรเป็น semver-ish, ไม่ยาวเกิน
    v = (version or "").strip()
    if not v or len(v) > 60:
        return
    try:
        with db_conn() as conn:
            conn.execute(
                "UPDATE members SET extension_version = ?, extension_last_used_at = ? "
                "WHERE id = ?",
                (v, utc_now().isoformat(), member_id),
            )
    except Exception:
        pass  # ห้ามกระทบ business logic


def require_admin_or_api_key(
    fct_session: Optional[str] = Cookie(default=None),
    fct_member_session: Optional[str] = Cookie(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> str:
    """ผ่านถ้า admin หรือ admin-member หรือส่ง X-API-Key ที่ตรงกับ config"""
    if get_session(fct_session):
        return "session"
    msess = get_member_session(fct_member_session)
    if msess and _member_is_admin(msess["member_id"]):
        return "admin_member"
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
    profile_email: Optional[str] = None
    credits_spent: Optional[float] = Field(None, ge=0)

    @field_validator("balance")
    @classmethod
    def _finite(cls, v: float) -> float:
        if v != v or v in (float("inf"), float("-inf")):
            raise ValueError("balance must be finite")
        return v

    @field_validator("credits_spent")
    @classmethod
    def _finite_spent(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return None
        if v != v or v in (float("inf"), float("-inf")):
            raise ValueError("credits_spent must be finite")
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
    profile_email = (snapshot.profile_email or "").strip().lower() or None

    credits_spent = (
        float(snapshot.credits_spent)
        if snapshot.credits_spent is not None
        else None
    )

    # host info — backend รันในเครื่อง user เอง ดังนั้น autofill ได้เลย
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO snapshots"
            "(timestamp, balance, source_url, user_agent, profile_name, profile_email, host_name, host_ip, credits_spent) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ts_iso,
                float(snapshot.balance),
                snapshot.source_url,
                user_agent,
                profile_name,
                profile_email,
                HOST_NAME,
                HOST_IP,
                credits_spent,
            ),
        )
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id}


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------
@app.get("/api/history")
def get_history(
    days: int = 30,
    profile_email: Optional[str] = None,
    profile_name: Optional[str] = None,
    _auth: str = Depends(require_any_auth),
) -> dict[str, Any]:
    """ประวัติยอดคงเหลือรายวัน — กรองด้วย profile_email หรือ profile_name (account)
    ได้ ถ้าไม่ส่งจะเป็น aggregate ของทั้งระบบ
    """
    days = max(1, min(365, days))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()

    where_extra = ""
    params: list[Any] = [cutoff]
    if profile_email:
        where_extra += " AND LOWER(profile_email) = LOWER(?)"
        params.append(profile_email)
    elif profile_name:
        where_extra += " AND profile_name = ?"
        params.append(profile_name)

    sql = f"""
        WITH ranked AS (
            SELECT
                DATE(timestamp) AS day,
                balance,
                timestamp,
                ROW_NUMBER() OVER (PARTITION BY DATE(timestamp) ORDER BY timestamp DESC) AS rn,
                COUNT(*) OVER (PARTITION BY DATE(timestamp)) AS cnt
            FROM snapshots
            WHERE timestamp >= ?{where_extra}
        )
        SELECT day, balance, cnt
        FROM ranked
        WHERE rn = 1
        ORDER BY day DESC
    """
    with db_conn() as conn:
        rows = conn.execute(sql, params).fetchall()

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
    profile_email: Optional[str] = None,
    profile_name: Optional[str] = None,
    _auth: str = Depends(require_any_auth),
) -> dict[str, Any]:
    """รายการ snapshots ล่าสุด — กรองด้วย profile_email หรือ profile_name ได้"""
    limit = max(1, min(500, limit))
    where: list[str] = []
    params: list[Any] = []
    if profile_email:
        where.append("LOWER(profile_email) = LOWER(?)")
        params.append(profile_email)
    elif profile_name:
        where.append("profile_name = ?")
        params.append(profile_name)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    params.append(limit)

    sql = (
        "SELECT id, timestamp, balance, credits_spent, source_url, profile_name, profile_email, "
        "       host_name, host_ip, user_agent "
        "FROM snapshots" + where_sql + " ORDER BY timestamp DESC LIMIT ?"
    )
    with db_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {
        "snapshots": [
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "balance": r["balance"],
                "credits_spent": r["credits_spent"],
                "source_url": r["source_url"],
                "profile_name": r["profile_name"],
                "profile_email": r["profile_email"],
                "host_name": r["host_name"],
                "host_ip": r["host_ip"],
                "user_agent": r["user_agent"],
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


@app.get("/api/top-platforms")
def top_platforms(
    limit: int = 5,
    days: int = 30,
    sess: dict = Depends(require_admin_or_member),
) -> dict[str, Any]:
    """Top N platforms ที่ถูกคลิก/ใช้งานบ่อยสุด (จาก usage_logs)

    นับจาก usage_logs (action = prefill credential) ในช่วง N วันล่าสุด
    GROUP BY site_id → COUNT(*) DESC → top N

    Filter ตาม role:
    - Super admin → เห็น top platforms ทั้งระบบ
    - Member → เห็นเฉพาะ platforms ที่ตนเองมีสิทธิ์ใน team (strict opt-in)
    """
    limit = max(1, min(50, limit))
    days = max(1, min(365, days))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()

    member_id = sess.get("member_id")
    is_super_admin = (sess.get("role") == "admin")

    with db_conn() as conn:
        if is_super_admin or not member_id:
            # Super admin → all sites
            rows = conn.execute(
                """
                SELECT
                    s.id, s.name, s.url_pattern,
                    COUNT(ul.id) AS click_count,
                    MAX(ul.timestamp) AS last_used_at,
                    (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count
                FROM usage_logs ul
                JOIN sites s ON s.id = ul.site_id
                WHERE ul.timestamp >= ?
                GROUP BY s.id
                ORDER BY click_count DESC
                LIMIT ?
                """,
                (cutoff, limit),
            ).fetchall()
        else:
            # Member → filter by team_sites
            rows = conn.execute(
                """
                SELECT
                    s.id, s.name, s.url_pattern,
                    COUNT(ul.id) AS click_count,
                    MAX(ul.timestamp) AS last_used_at,
                    (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count
                FROM usage_logs ul
                JOIN sites s ON s.id = ul.site_id
                WHERE ul.timestamp >= ?
                  AND s.id IN (
                    SELECT ts.site_id
                    FROM team_sites ts
                    JOIN team_members tm ON tm.team_id = ts.team_id
                    WHERE tm.member_id = ?
                    UNION
                    SELECT c.site_id FROM credentials c
                    JOIN credential_members cm ON cm.credential_id = c.id
                    WHERE cm.member_id = ?
                  )
                GROUP BY s.id
                ORDER BY click_count DESC
                LIMIT ?
                """,
                (cutoff, member_id, member_id, limit),
            ).fetchall()

    return {
        "platforms": [
            {
                "id": r["id"],
                "name": r["name"],
                "url_pattern": r["url_pattern"],
                "click_count": r["click_count"],
                "last_used_at": r["last_used_at"],
                "cred_count": r["cred_count"],
            }
            for r in rows
        ],
        "days": days,
    }


@app.get("/api/credits-by-account")
def credits_by_account(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """แสดงเครดิตล่าสุดของแต่ละบัญชี — group ด้วย profile_email > profile_name.

    พยายาม match กับ credentials.username เพื่อโชว์ label/credential_id
    """
    cycle_day = int(get_config().get("billing_cycle_day", DEFAULT_CONFIG["billing_cycle_day"]))
    cycle_start, _ = billing_cycle_window(utc_now(), cycle_day)
    cutoff = (utc_now() - timedelta(days=30)).isoformat()  # ดูย้อนหลัง 30 วัน

    # latest snapshot ของแต่ละ "account key" (email > name)
    sql = """
        WITH ranked AS (
            SELECT s.*,
                COALESCE(LOWER(profile_email), profile_name) AS account_key,
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(LOWER(profile_email), profile_name)
                    ORDER BY timestamp DESC
                ) AS rn
            FROM snapshots s
            WHERE timestamp >= ?
              AND (profile_email IS NOT NULL OR profile_name IS NOT NULL)
        )
        SELECT account_key, profile_name, profile_email, balance, timestamp,
               source_url, host_name, credits_spent
        FROM ranked WHERE rn = 1
        ORDER BY balance ASC
    """
    with db_conn() as conn:
        rows = conn.execute(sql, (cutoff,)).fetchall()
        creds = conn.execute(
            "SELECT id, label, username, site_id FROM credentials"
        ).fetchall()
    cred_by_username = {(c["username"] or "").lower(): dict(c) for c in creds if c["username"]}

    accounts = []
    for r in rows:
        match = None
        # Try email first
        if r["profile_email"]:
            match = cred_by_username.get((r["profile_email"] or "").lower())
        # Fallback: profile_name อาจเป็น email format (ในระบบบางที่)
        if not match and r["profile_name"] and "@" in r["profile_name"]:
            match = cred_by_username.get(r["profile_name"].lower())
        spent = r["credits_spent"]
        bal = r["balance"]
        # estimated_quota = balance + spent (ถ้า spent มี)
        est_quota = None
        if spent is not None and bal is not None:
            try:
                est_quota = float(bal) + float(spent)
            except (TypeError, ValueError):
                est_quota = None
        accounts.append({
            "account_key": r["account_key"],
            "profile_name": r["profile_name"],
            "profile_email": r["profile_email"],
            "balance": bal,
            "credits_spent": spent,
            "estimated_quota": est_quota,
            "last_seen": r["timestamp"],
            "source_url": r["source_url"],
            "host_name": r["host_name"],
            "credential_id": match["id"] if match else None,
            "credential_label": match["label"] if match else None,
            "credential_username": match["username"] if match else None,
        })

    return {
        "accounts": accounts,
        "count": len(accounts),
        "cycle_start": cycle_start.date().isoformat(),
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
    sess: dict = Depends(require_super_admin),
) -> dict[str, Any]:
    """เปลี่ยน username และ/หรือ password ของ super admin (admin_users) เท่านั้น"""
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

        # === v1.14 — สำหรับแต่ละ member: หาว่ามี direct grant ที่อยู่นอก team_sites ===
        team_site_ids = {s["id"] for s in sites}
        members_data = [dict(m) for m in members]
        for mem in members_data:
            extra_rows = conn.execute(
                """
                SELECT DISTINCT s.id, s.name
                FROM credential_members cm
                JOIN credentials c ON c.id = cm.credential_id
                JOIN sites s ON s.id = c.site_id
                WHERE cm.member_id = ?
                ORDER BY s.name
                """,
                (mem["id"],),
            ).fetchall()
            mem["extra_sites"] = [
                {"id": r["id"], "name": r["name"]}
                for r in extra_rows
                if r["id"] not in team_site_ids
            ]

    return {
        "team": dict(team),
        "members": members_data,
        "sites": [
            {**dict(s), "credentials": site_creds.get(s["id"], [])}
            for s in sites
        ],
    }


# === v1.14 — Per-member site access management ===

@app.get("/api/admin/members/{member_id}/site-access")
def admin_member_site_access(
    member_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """List all sites + access status สำหรับ member นี้
    - via_teams: ถ้าเข้าถึงผ่าน team(s)
    - direct_credentials: จำนวน credential ที่ grant ตรง (ใน credential_members)
    """
    with db_conn() as conn:
        member = conn.execute(
            "SELECT id, phone, email, display_name FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if not member:
            raise HTTPException(status_code=404, detail="member not found")

        all_sites = conn.execute(
            "SELECT s.id, s.name, s.url_pattern, s.logo_data, "
            "       (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS total_creds "
            "FROM sites s ORDER BY s.name COLLATE NOCASE"
        ).fetchall()

        # via_teams: site → list of teams ที่ member อยู่ + ทีมนั้นมี team_sites
        team_access_rows = conn.execute(
            """
            SELECT ts.site_id, t.id AS team_id, t.name AS team_name, ts.access_type
            FROM team_members tm
            JOIN team_sites ts ON ts.team_id = tm.team_id
            JOIN teams t ON t.id = tm.team_id
            WHERE tm.member_id = ?
            """,
            (member_id,),
        ).fetchall()
        team_access: dict[int, list[dict[str, Any]]] = {}
        for r in team_access_rows:
            team_access.setdefault(r["site_id"], []).append({
                "id": r["team_id"], "name": r["team_name"], "access_type": r["access_type"],
            })

        # direct grants: site → count of credentials ที่อยู่ใน credential_members
        direct_rows = conn.execute(
            """
            SELECT c.site_id, COUNT(DISTINCT c.id) AS n
            FROM credential_members cm
            JOIN credentials c ON c.id = cm.credential_id
            WHERE cm.member_id = ?
            GROUP BY c.site_id
            """,
            (member_id,),
        ).fetchall()
        direct_counts = {r["site_id"]: r["n"] for r in direct_rows}

    sites_data = []
    for s in all_sites:
        sd = dict(s)
        via_teams = team_access.get(sd["id"], [])
        direct_n = direct_counts.get(sd["id"], 0)
        sd["via_teams"] = via_teams
        sd["direct_credentials"] = direct_n
        sd["has_access"] = bool(via_teams) or direct_n > 0
        sites_data.append(sd)

    return {"member": dict(member), "sites": sites_data}


class MemberSiteAccessIn(BaseModel):
    grant: bool


@app.put("/api/admin/members/{member_id}/site-direct-access/{site_id}")
def admin_member_set_direct_site_access(
    member_id: int,
    site_id: int,
    payload: MemberSiteAccessIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """Toggle direct grant สำหรับ member นี้ + site นี้
    grant=true: INSERT credential_members ทุก credential ของ site นั้น (idempotent)
    grant=false: DELETE credential_members ทุก credential ของ site นี้สำหรับ member นี้
    """
    now = utc_now().isoformat()
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (member_id,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        cred_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM credentials WHERE site_id = ?", (site_id,)
        ).fetchall()]
        if not cred_ids:
            raise HTTPException(status_code=404, detail="site has no credentials yet")

        if payload.grant:
            for cid in cred_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO credential_members(credential_id, member_id, added_at) VALUES (?, ?, ?)",
                    (cid, member_id, now),
                )
            return {"ok": True, "action": "granted", "credentials": len(cred_ids)}
        else:
            placeholders = ",".join("?" * len(cred_ids))
            cur = conn.execute(
                f"DELETE FROM credential_members WHERE member_id = ? AND credential_id IN ({placeholders})",
                (member_id, *cred_ids),
            )
            return {"ok": True, "action": "revoked", "removed": cur.rowcount}


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


class MemberRolePatch(BaseModel):
    is_admin: bool


@app.get("/api/admin/members")
def admin_list_members(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, phone, email, display_name, enabled, is_admin, avatar_data, "
            "       extension_version, extension_last_used_at, "
            "       (pw_hash IS NOT NULL) AS has_password, "
            "       created_at, last_login_at "
            "FROM members ORDER BY created_at DESC"
        ).fetchall()
        # ดึง team membership ของทุก member ในคำขอเดียว → group ใน Python
        tm_rows = conn.execute(
            "SELECT tm.member_id, t.id AS team_id, t.name AS team_name "
            "FROM team_members tm JOIN teams t ON t.id = tm.team_id "
            "ORDER BY t.name"
        ).fetchall()
    teams_by_member: dict[int, list[dict[str, Any]]] = {}
    for r in tm_rows:
        teams_by_member.setdefault(r["member_id"], []).append(
            {"id": r["team_id"], "name": r["team_name"]}
        )
    return {
        "members": [
            {
                "id": r["id"],
                "phone": r["phone"],
                "email": r["email"],
                "display_name": r["display_name"],
                "enabled": bool(r["enabled"]) if r["enabled"] is not None else True,
                "is_admin": bool(r["is_admin"]) if r["is_admin"] is not None else False,
                "has_password": bool(r["has_password"]),
                "avatar_data": r["avatar_data"] if "avatar_data" in r.keys() else None,
                "extension_version": r["extension_version"] if "extension_version" in r.keys() else None,
                "extension_last_used_at": r["extension_last_used_at"] if "extension_last_used_at" in r.keys() else None,
                "created_at": r["created_at"],
                "last_login_at": r["last_login_at"],
                "teams": teams_by_member.get(r["id"], []),
            }
            for r in rows
        ]
    }


class MemberTeamsPatch(BaseModel):
    team_ids: list[int]


@app.get("/api/admin/members/{member_id}/stats")
def admin_member_stats(
    member_id: int,
    days: int = 30,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """สถิติ platform usage ของ member 1 คน — group by site, count clicks
    Query: ?days=7|30|90|180
    """
    days = max(1, min(365, days))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()
    with db_conn() as conn:
        member = conn.execute(
            "SELECT id, display_name, email, phone FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if not member:
            raise HTTPException(status_code=404, detail="member not found")
        rows = conn.execute(
            """
            SELECT
                s.id AS site_id,
                COALESCE(s.name, ul.site_name) AS site_name,
                s.url_pattern,
                COUNT(ul.id) AS click_count,
                MAX(ul.timestamp) AS last_used_at
            FROM usage_logs ul
            LEFT JOIN sites s ON s.id = ul.site_id
            WHERE ul.member_id = ?
              AND ul.timestamp >= ?
            GROUP BY ul.site_id
            ORDER BY click_count DESC
            """,
            (member_id, cutoff),
        ).fetchall()
        total_row = conn.execute(
            "SELECT COUNT(*) AS n FROM usage_logs WHERE member_id = ? AND timestamp >= ?",
            (member_id, cutoff),
        ).fetchone()
    return {
        "member": dict(member),
        "days": days,
        "total_clicks": total_row["n"] if total_row else 0,
        "platforms": [
            {
                "site_id": r["site_id"],
                "site_name": r["site_name"] or "(ลบแล้ว)",
                "url_pattern": r["url_pattern"],
                "click_count": r["click_count"],
                "last_used_at": r["last_used_at"],
            }
            for r in rows
        ],
    }


@app.put("/api/admin/members/{member_id}/teams")
def admin_set_member_teams(
    member_id: int,
    payload: MemberTeamsPatch,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ตั้ง teams ของ member เป็นชุดที่กำหนด (replace all)
    Diff old vs new → INSERT/DELETE rows ใน team_members
    """
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (member_id,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        current = {r["team_id"] for r in conn.execute(
            "SELECT team_id FROM team_members WHERE member_id = ?", (member_id,)
        ).fetchall()}
        target = set(int(t) for t in payload.team_ids)
        # validate ว่า team ทั้งหมดที่ส่งมามีอยู่จริง
        if target:
            valid = {r["id"] for r in conn.execute(
                f"SELECT id FROM teams WHERE id IN ({','.join('?' * len(target))})",
                tuple(target),
            ).fetchall()}
            if valid != target:
                missing = target - valid
                raise HTTPException(status_code=400, detail=f"team not found: {sorted(missing)}")

        to_add = target - current
        to_remove = current - target
        now = utc_now().isoformat()
        for team_id in to_add:
            conn.execute(
                "INSERT INTO team_members(team_id, member_id, added_at) VALUES (?, ?, ?)",
                (team_id, member_id, now),
            )
        for team_id in to_remove:
            conn.execute(
                "DELETE FROM team_members WHERE team_id = ? AND member_id = ?",
                (team_id, member_id),
            )
    return {"ok": True, "added": len(to_add), "removed": len(to_remove)}


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


@app.patch("/api/admin/members/{member_id}/admin")
def admin_set_member_admin(
    member_id: int,
    payload: MemberRolePatch,
    _sess: dict = Depends(require_super_admin),  # ⚠️ super only — กัน admin promote กันเอง
) -> dict[str, Any]:
    """Promote/demote member เป็น admin (เฉพาะ super admin ทำได้)"""
    with db_conn() as conn:
        cur = conn.execute(
            "UPDATE members SET is_admin = ? WHERE id = ?",
            (1 if payload.is_admin else 0, member_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="ไม่พบ member")
    return {"ok": True, "is_admin": payload.is_admin}


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
PAYMENT_TYPES = [
    "credit_card", "debit_card", "bank_transfer", "promptpay",
    "truemoney", "paypal", "crypto", "other",
]


class SiteIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    url_pattern: str = Field(..., min_length=1, max_length=500)
    renew_day: Optional[int] = Field(None, ge=1, le=31)
    card_owner: Optional[str] = Field(None, max_length=120)  # name (auto-create ถ้าไม่มี)
    cancelled: Optional[bool] = None
    cancelled_at: Optional[str] = Field(None, max_length=40)  # ISO date
    payment_type: Optional[str] = Field(None, max_length=40)
    usage_reason: Optional[str] = Field(None, max_length=2000)
    # v1.9
    billing_cycle: Optional[str] = Field(None, pattern="^(monthly|yearly)$")
    cost_amount: Optional[float] = Field(None, ge=0)
    cost_currency: Optional[str] = Field(None, max_length=10)
    start_date: Optional[str] = Field(None, max_length=40)   # ISO YYYY-MM-DD
    end_date: Optional[str] = Field(None, max_length=40)     # ISO YYYY-MM-DD
    # v1.12 — logo data URL (data:image/png;base64,...) ขนาด max 500 KB
    logo_data: Optional[str] = Field(None, max_length=700_000)


class SitePatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    url_pattern: Optional[str] = Field(None, min_length=1, max_length=500)
    renew_day: Optional[int] = Field(None, ge=1, le=31)
    card_owner: Optional[str] = Field(None, max_length=120)  # ส่ง '' เพื่อ clear
    cancelled: Optional[bool] = None
    cancelled_at: Optional[str] = Field(None, max_length=40)
    payment_type: Optional[str] = Field(None, max_length=40)
    usage_reason: Optional[str] = Field(None, max_length=2000)
    # v1.9 — ส่ง '' หรือ null เพื่อ clear
    billing_cycle: Optional[str] = Field(None, pattern="^(monthly|yearly|)$")
    cost_amount: Optional[float] = Field(None, ge=0)
    cost_currency: Optional[str] = Field(None, max_length=10)
    start_date: Optional[str] = Field(None, max_length=40)
    end_date: Optional[str] = Field(None, max_length=40)
    # v1.12 — ส่ง '' เพื่อลบ logo
    logo_data: Optional[str] = Field(None, max_length=700_000)


def _resolve_card_owner_id(name: Optional[str]) -> Optional[int]:
    """หา card_owner.id จากชื่อ — ถ้าไม่มี สร้างใหม่ คืน id; ถ้า name ว่าง คืน None"""
    if not name:
        return None
    name = name.strip()
    if not name:
        return None
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id FROM card_owners WHERE LOWER(name) = LOWER(?)", (name,)
        ).fetchone()
        if row:
            return row["id"]
        cur = conn.execute(
            "INSERT INTO card_owners(name, created_at) VALUES (?, ?)",
            (name, utc_now().isoformat()),
        )
        return cur.lastrowid


class CredentialIn(BaseModel):
    label: Optional[str] = Field(None, max_length=120)
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=500)
    # billing/lifecycle (v1.10 — ย้ายจาก site)
    renew_day: Optional[int] = Field(None, ge=1, le=31)
    card_owner: Optional[str] = Field(None, max_length=120)
    cancelled: Optional[bool] = None
    cancelled_at: Optional[str] = Field(None, max_length=40)
    payment_type: Optional[str] = Field(None, max_length=40)
    usage_reason: Optional[str] = Field(None, max_length=2000)
    billing_cycle: Optional[str] = Field(None, pattern="^(monthly|yearly|)$")
    cost_amount: Optional[float] = Field(None, ge=0)
    cost_currency: Optional[str] = Field(None, max_length=10)
    start_date: Optional[str] = Field(None, max_length=40)
    end_date: Optional[str] = Field(None, max_length=40)


class CredentialPatchIn(BaseModel):
    label: Optional[str] = Field(None, max_length=120)
    username: Optional[str] = Field(None, min_length=1, max_length=200)
    password: Optional[str] = Field(None, min_length=1, max_length=500)
    # billing/lifecycle
    renew_day: Optional[int] = Field(None, ge=1, le=31)
    card_owner: Optional[str] = Field(None, max_length=120)
    cancelled: Optional[bool] = None
    cancelled_at: Optional[str] = Field(None, max_length=40)
    payment_type: Optional[str] = Field(None, max_length=40)
    usage_reason: Optional[str] = Field(None, max_length=2000)
    billing_cycle: Optional[str] = Field(None, pattern="^(monthly|yearly|)$")
    cost_amount: Optional[float] = Field(None, ge=0)
    cost_currency: Optional[str] = Field(None, max_length=10)
    start_date: Optional[str] = Field(None, max_length=40)
    end_date: Optional[str] = Field(None, max_length=40)


@app.get("/api/admin/card-owners")
def list_card_owners(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    """รายชื่อเจ้าของบัตรเครดิตทั้งหมด — ใช้กับ datalist ใน UI"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at FROM card_owners ORDER BY name"
        ).fetchall()
    return {"card_owners": [dict(r) for r in rows]}


@app.get("/api/admin/payment-types")
def list_payment_types(_sess: dict = Depends(require_admin)) -> dict[str, list[str]]:
    """รายชื่อ payment type ที่ระบบรองรับ — fixed list"""
    return {"payment_types": PAYMENT_TYPES}


@app.get("/api/admin/site-logo-suggestions")
def site_logo_suggestions(
    domain: str,
    _sess: dict = Depends(require_admin),
) -> dict[str, list[dict[str, str]]]:
    """ข้อเสนอ logo จาก URL/domain — frontend ลองโหลดและ filter ที่ failed
    ใช้ public APIs ที่ไม่ต้อง key
    """
    # Normalize domain
    d = (domain or "").strip().lower()
    d = d.replace("https://", "").replace("http://", "")
    d = d.split("/")[0]
    d = d.replace("www.", "")
    # ตัด wildcard pattern (* และ : port)
    d = d.replace("*.", "").replace("*", "").split(":")[0].strip()
    if not d or "." not in d:
        return {"suggestions": []}
    return {
        "suggestions": [
            {"name": "Clearbit Logo", "url": f"https://logo.clearbit.com/{d}", "size": "256"},
            {"name": "Google Favicon (256)", "url": f"https://www.google.com/s2/favicons?domain={d}&sz=256", "size": "256"},
            {"name": "Google Favicon (128)", "url": f"https://www.google.com/s2/favicons?domain={d}&sz=128", "size": "128"},
            {"name": "DuckDuckGo Icon", "url": f"https://icons.duckduckgo.com/ip3/{d}.ico", "size": "?"},
            {"name": "Icon Horse", "url": f"https://icon.horse/icon/{d}", "size": "?"},
        ]
    }


# === Image proxy — แก้ CORS เมื่อ frontend อยาก fetch logo จาก external source ===
import base64 as _b64
from urllib import request as _urlreq
from urllib.parse import urlparse as _urlparse

_PROXY_ALLOWED_HOSTS = (
    "logo.clearbit.com",
    "www.google.com",
    "icons.duckduckgo.com",
    "icon.horse",
    "external-content.duckduckgo.com",
)
_PROXY_MAX_BYTES = 2_000_000   # 2 MB
_PROXY_TIMEOUT_SEC = 10


@app.get("/api/admin/proxy-image")
def proxy_image(
    url: str,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """Proxy image fetch — bypass browser CORS เมื่อจะโหลด logo มา crop

    Whitelist เฉพาะ host ที่ใช้สำหรับ logo suggestions
    คืน data URL (base64) สำหรับ frontend ใช้ใน Cropper.js โดยตรง
    """
    if not (url.startswith("https://") or url.startswith("http://")):
        raise HTTPException(status_code=400, detail="invalid URL scheme")
    host = (_urlparse(url).hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in _PROXY_ALLOWED_HOSTS):
        raise HTTPException(status_code=400, detail=f"host not allowed: {host}")

    try:
        req = _urlreq.Request(url, headers={
            "User-Agent": "Mozilla/5.0 FEFL-Beat/1.0",
            "Accept": "image/png,image/jpeg,image/webp,image/svg+xml,image/*,*/*;q=0.8",
        })
        with _urlreq.urlopen(req, timeout=_PROXY_TIMEOUT_SEC) as resp:
            ct = (resp.headers.get("Content-Type") or "image/png").split(";")[0].strip().lower()
            if not ct.startswith("image/"):
                # บาง endpoint ส่ง octet-stream มา — เดา PNG
                ct = "image/png"
            # Read with size limit
            data = resp.read(_PROXY_MAX_BYTES + 1)
            if len(data) > _PROXY_MAX_BYTES:
                raise HTTPException(status_code=413, detail="image too large (>2MB)")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"fetch failed: {e.__class__.__name__}: {e}")

    b64 = _b64.b64encode(data).decode("ascii")
    return {
        "data_url": f"data:{ct};base64,{b64}",
        "size": len(data),
        "content_type": ct,
    }


@app.get("/api/admin/sites")
def list_sites(_sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    """List ALL sites — ใช้กับหน้า Config (admin-only ในฝั่ง UI)

    ไม่ filter ที่นี่ — Platforms page จะใช้ /api/my-platforms ที่มี strict filter แทน
    """
    with db_conn() as conn:
        sites = conn.execute(
            "SELECT s.id, s.name, s.url_pattern, s.created_at, s.logo_data, "
            "       (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count "
            "FROM sites s ORDER BY s.created_at DESC"
        ).fetchall()
    return {"sites": [dict(r) for r in sites]}


@app.get("/api/my-platforms")
def my_platforms(sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    """คืน sites แยก 2 กลุ่ม:
    - accessible: site ที่ user เข้าถึงได้ (ผ่าน team หรือ direct grant)
    - no_access: site ที่ user ยังไม่มีสิทธิ์ → กดขอ access ได้

    Super admin → accessible = all, no_access = []
    แต่ละ site แนบ click stats:
    - my_clicks: จำนวนที่ user นี้คลิก prefill (30 วัน)
    - global_clicks: จำนวนรวมในระบบ (30 วัน)
    """
    member_id = sess.get("member_id")
    cutoff = (utc_now() - timedelta(days=30)).isoformat()

    # query click stats เป็น dict: {site_id: count}
    with db_conn() as conn:
        global_click_rows = conn.execute(
            "SELECT site_id, COUNT(*) AS n FROM usage_logs "
            "WHERE timestamp >= ? AND site_id IS NOT NULL GROUP BY site_id",
            (cutoff,),
        ).fetchall()
        global_clicks = {r["site_id"]: r["n"] for r in global_click_rows}

        my_clicks = {}
        if member_id:
            my_click_rows = conn.execute(
                "SELECT site_id, COUNT(*) AS n FROM usage_logs "
                "WHERE timestamp >= ? AND member_id = ? AND site_id IS NOT NULL GROUP BY site_id",
                (cutoff, member_id),
            ).fetchall()
            my_clicks = {r["site_id"]: r["n"] for r in my_click_rows}

        # ทุก site ในระบบ
        all_sites = conn.execute(
            "SELECT s.id, s.name, s.url_pattern, s.created_at, s.logo_data, "
            "       (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count "
            "FROM sites s ORDER BY s.created_at DESC"
        ).fetchall()

        # Super admin → ทุก site = accessible
        if not member_id:
            sites_data = []
            for r in all_sites:
                d = dict(r)
                d["my_clicks"] = 0
                d["global_clicks"] = global_clicks.get(d["id"], 0)
                sites_data.append(d)
            return {
                "accessible": sites_data,
                "no_access": [],
                "viewer": "super_admin",
                "note": "Super admin ไม่อยู่ในทีมใด — แสดงทั้งหมดเพื่อการจัดการ",
            }

        # Member: หา site_ids ที่เข้าถึงได้
        accessible_id_rows = conn.execute(
            """
            SELECT DISTINCT site_id FROM (
                SELECT ts.site_id FROM team_sites ts
                JOIN team_members tm ON tm.team_id = ts.team_id
                WHERE tm.member_id = ?
                UNION
                SELECT c.site_id FROM credentials c
                JOIN credential_members cm ON cm.credential_id = c.id
                WHERE cm.member_id = ?
            )
            """,
            (member_id, member_id),
        ).fetchall()
        accessible_ids = {r["site_id"] for r in accessible_id_rows}

        # Pending requests ของ member นี้
        pending_rows = conn.execute(
            "SELECT site_id FROM access_requests WHERE member_id = ? AND status = 'pending'",
            (member_id,),
        ).fetchall()
        pending_ids = {r["site_id"] for r in pending_rows}

    accessible = []
    no_access = []
    for r in all_sites:
        d = dict(r)
        d["my_clicks"] = my_clicks.get(d["id"], 0)
        d["global_clicks"] = global_clicks.get(d["id"], 0)
        if d["id"] in accessible_ids:
            accessible.append(d)
        else:
            d["request_pending"] = d["id"] in pending_ids
            no_access.append(d)

    return {
        "accessible": accessible,
        "no_access": no_access,
        "viewer": "member",
    }


# === Access requests (member → admin approval flow) ===

class AccessRequestIn(BaseModel):
    site_id: int
    note: Optional[str] = Field(None, max_length=500)


class AccessRequestDecide(BaseModel):
    action: str = Field(..., pattern="^(accept|reject)$")
    note: Optional[str] = Field(None, max_length=500)


@app.post("/api/access-requests")
def create_access_request(
    payload: AccessRequestIn,
    sess: dict = Depends(require_admin_or_member),
) -> dict[str, Any]:
    """Member ขอสิทธิ์เข้าถึง site"""
    member_id = sess.get("member_id")
    if not member_id:
        raise HTTPException(status_code=400, detail="ต้องเป็น member เท่านั้น (super admin ใช้ Config โดยตรง)")
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM sites WHERE id = ?", (payload.site_id,)).fetchone():
            raise HTTPException(status_code=404, detail="site not found")
        # ตรวจ pending ซ้ำ
        existing = conn.execute(
            "SELECT id FROM access_requests WHERE member_id = ? AND site_id = ? AND status = 'pending'",
            (member_id, payload.site_id),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="คุณมี request ที่ pending อยู่แล้ว")
        cur = conn.execute(
            "INSERT INTO access_requests(member_id, site_id, requested_at, status, note) "
            "VALUES (?, ?, ?, 'pending', ?)",
            (member_id, payload.site_id, utc_now().isoformat(), payload.note),
        )
    return {"ok": True, "id": cur.lastrowid}


@app.get("/api/me/access-requests")
def list_my_access_requests(
    sess: dict = Depends(require_admin_or_member),
) -> dict[str, Any]:
    """Member ดู requests ของตัวเอง (ทุก status)"""
    member_id = sess.get("member_id")
    if not member_id:
        return {"requests": []}
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT ar.id, ar.site_id, s.name AS site_name, ar.status, ar.note, "
            "       ar.requested_at, ar.decided_at, ar.decided_by "
            "FROM access_requests ar JOIN sites s ON s.id = ar.site_id "
            "WHERE ar.member_id = ? "
            "ORDER BY ar.requested_at DESC",
            (member_id,),
        ).fetchall()
    return {"requests": [dict(r) for r in rows]}


@app.get("/api/admin/access-requests")
def admin_list_access_requests(
    status: str = "pending",
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """Admin ดู requests — default แสดง pending"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT ar.id, ar.member_id, m.display_name, m.email, m.phone, "
            "       ar.site_id, s.name AS site_name, s.url_pattern, s.logo_data, "
            "       ar.status, ar.note, ar.requested_at, ar.decided_at, ar.decided_by "
            "FROM access_requests ar "
            "JOIN members m ON m.id = ar.member_id "
            "JOIN sites s ON s.id = ar.site_id "
            "WHERE ar.status = ? "
            "ORDER BY ar.requested_at DESC",
            (status,),
        ).fetchall()
        # นับจำนวนแยกตาม status — สำหรับแสดงเป็น tab counts
        counts = dict(conn.execute(
            "SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status"
        ).fetchall() and [(r["status"], r["n"]) for r in conn.execute(
            "SELECT status, COUNT(*) AS n FROM access_requests GROUP BY status"
        ).fetchall()])
    return {"requests": [dict(r) for r in rows], "counts": counts}


@app.patch("/api/admin/access-requests/{req_id}")
def admin_decide_access_request(
    req_id: int,
    payload: AccessRequestDecide,
    sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """Admin accept/reject request

    Accept = ให้ direct grant ทุก credential ของ site นั้นๆ ผ่าน credential_members
            (admin สามารถ refine ทีหลังได้ใน Config → Credential edit)
    Reject = แค่ mark status, ไม่ทำอะไร
    """
    now = utc_now().isoformat()
    decided_by = f"admin:{sess.get('username') or sess.get('member_id') or '?'}"
    new_status = "accepted" if payload.action == "accept" else "rejected"

    with db_conn() as conn:
        req = conn.execute(
            "SELECT id, member_id, site_id, status FROM access_requests WHERE id = ?",
            (req_id,),
        ).fetchone()
        if not req:
            raise HTTPException(status_code=404, detail="request not found")
        if req["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"request นี้ตัดสินแล้ว (status={req['status']})")

        if payload.action == "accept":
            # Grant access ผ่าน credential_members ทุก credential ของ site
            cred_ids = [r["id"] for r in conn.execute(
                "SELECT id FROM credentials WHERE site_id = ?", (req["site_id"],)
            ).fetchall()]
            for cid in cred_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO credential_members(credential_id, member_id, added_at) "
                    "VALUES (?, ?, ?)",
                    (cid, req["member_id"], now),
                )

        conn.execute(
            "UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ?, note = COALESCE(?, note) "
            "WHERE id = ?",
            (new_status, now, decided_by, payload.note, req_id),
        )

    return {"ok": True, "status": new_status}


@app.get("/api/admin/access-requests/pending-count")
def admin_pending_request_count(_sess: dict = Depends(require_admin)) -> dict[str, int]:
    """แสดงเลข badge ในเมนู — เร็ว, ไม่ดึง list"""
    with db_conn() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'"
        ).fetchone()["n"]
    return {"count": n}


@app.post("/api/admin/sites")
def create_site(payload: SiteIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    card_owner_id = _resolve_card_owner_id(payload.card_owner) if payload.card_owner else None
    cancelled_int = 1 if payload.cancelled else 0
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO sites(name, url_pattern, created_at, "
            "  renew_day, card_owner_id, cancelled, cancelled_at, payment_type, usage_reason, "
            "  billing_cycle, cost_amount, cost_currency, start_date, end_date, logo_data) "
            "VALUES (?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?)",
            (
                payload.name, payload.url_pattern, utc_now().isoformat(),
                payload.renew_day, card_owner_id, cancelled_int,
                payload.cancelled_at, payload.payment_type, payload.usage_reason,
                payload.billing_cycle, payload.cost_amount, payload.cost_currency,
                payload.start_date, payload.end_date,
                payload.logo_data or None,
            ),
        )
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id}


@app.get("/api/admin/sites/{site_id}")
def get_site(site_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        site = conn.execute(
            "SELECT s.*, co.name AS card_owner_name "
            "FROM sites s LEFT JOIN card_owners co ON co.id = s.card_owner_id "
            "WHERE s.id = ?",
            (site_id,),
        ).fetchone()
        if not site:
            raise HTTPException(status_code=404, detail="site not found")
        creds = conn.execute(
            "SELECT c.*, co.name AS card_owner_name "
            "FROM credentials c LEFT JOIN card_owners co ON co.id = c.card_owner_id "
            "WHERE c.site_id = ? ORDER BY c.created_at DESC",
            (site_id,),
        ).fetchall()
    site_dict = dict(site)
    if "cancelled" in site_dict and site_dict["cancelled"] is not None:
        site_dict["cancelled"] = bool(site_dict["cancelled"])
    cred_list = []
    for c in creds:
        cd = dict(c)
        if "cancelled" in cd and cd["cancelled"] is not None:
            cd["cancelled"] = bool(cd["cancelled"])
        cred_list.append(cd)
    return {
        "site": site_dict,
        "credentials": cred_list,
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
    """แก้ไข site — รองรับทุกฟิลด์ (partial update)"""
    updates: dict[str, Any] = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()
    if payload.url_pattern is not None:
        updates["url_pattern"] = payload.url_pattern.strip()
    if payload.renew_day is not None:
        updates["renew_day"] = payload.renew_day
    if payload.card_owner is not None:
        # ถ้าเป็น empty string → clear (NULL)
        updates["card_owner_id"] = _resolve_card_owner_id(payload.card_owner) if payload.card_owner else None
    if payload.cancelled is not None:
        updates["cancelled"] = 1 if payload.cancelled else 0
    if payload.cancelled_at is not None:
        updates["cancelled_at"] = payload.cancelled_at or None
    if payload.payment_type is not None:
        updates["payment_type"] = payload.payment_type or None
    if payload.usage_reason is not None:
        updates["usage_reason"] = payload.usage_reason or None
    if payload.billing_cycle is not None:
        # '' = clear (NULL); 'monthly'/'yearly' = set
        updates["billing_cycle"] = payload.billing_cycle or None
    if payload.cost_amount is not None:
        updates["cost_amount"] = payload.cost_amount
    if payload.cost_currency is not None:
        updates["cost_currency"] = payload.cost_currency or None
    if payload.start_date is not None:
        updates["start_date"] = payload.start_date or None
    if payload.end_date is not None:
        updates["end_date"] = payload.end_date or None
    if payload.logo_data is not None:
        # ส่ง '' (empty string) → ลบ logo (set NULL); ส่ง data:image/... → save
        updates["logo_data"] = payload.logo_data or None
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
    """แก้ไข label / username / password / billing fields ของ credential"""
    updates: dict[str, Any] = {}
    if payload.label is not None:
        v = payload.label.strip()
        updates["label"] = v or None
    if payload.username is not None:
        updates["username"] = payload.username.strip()
    if payload.password is not None:
        updates["password"] = payload.password
    # billing/lifecycle (v1.10)
    if payload.renew_day is not None:
        updates["renew_day"] = payload.renew_day
    if payload.card_owner is not None:
        updates["card_owner_id"] = _resolve_card_owner_id(payload.card_owner) if payload.card_owner else None
    if payload.cancelled is not None:
        updates["cancelled"] = 1 if payload.cancelled else 0
    if payload.cancelled_at is not None:
        updates["cancelled_at"] = payload.cancelled_at or None
    if payload.payment_type is not None:
        updates["payment_type"] = payload.payment_type or None
    if payload.usage_reason is not None:
        updates["usage_reason"] = payload.usage_reason or None
    if payload.billing_cycle is not None:
        updates["billing_cycle"] = payload.billing_cycle or None
    if payload.cost_amount is not None:
        updates["cost_amount"] = payload.cost_amount
    if payload.cost_currency is not None:
        updates["cost_currency"] = payload.cost_currency or None
    if payload.start_date is not None:
        updates["start_date"] = payload.start_date or None
    if payload.end_date is not None:
        updates["end_date"] = payload.end_date or None
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
    card_owner_id = _resolve_card_owner_id(payload.card_owner) if payload.card_owner else None
    cancelled_int = 1 if payload.cancelled else 0
    with db_conn() as conn:
        site = conn.execute("SELECT 1 FROM sites WHERE id = ?", (site_id,)).fetchone()
        if not site:
            raise HTTPException(status_code=404, detail="site not found")
        cur = conn.execute(
            "INSERT INTO credentials("
            "  site_id, label, username, password, created_at,"
            "  renew_day, card_owner_id, cancelled, cancelled_at, payment_type, usage_reason,"
            "  billing_cycle, cost_amount, cost_currency, start_date, end_date"
            ") VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)",
            (
                site_id, payload.label, payload.username, payload.password, utc_now().isoformat(),
                payload.renew_day, card_owner_id, cancelled_int, payload.cancelled_at,
                payload.payment_type, payload.usage_reason,
                payload.billing_cycle or None, payload.cost_amount, payload.cost_currency,
                payload.start_date, payload.end_date,
            ),
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


# === v1.11 — Credential access control (per-credential team + direct member grants) ===

class CredentialAccessIn(BaseModel):
    team_ids: list[int] = []
    member_ids: list[int] = []


@app.get("/api/admin/credentials/{cred_id}/access")
def get_credential_access(
    cred_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """คืน access ปัจจุบันของ credential นี้:
    - teams: ทีมที่อยู่ใน team_credentials ของ credential นี้
            + label ว่า team นั้นมี team_sites ระดับใด ('all', 'select', 'none')
    - members: member ที่อยู่ใน credential_members (direct grant)
    """
    with db_conn() as conn:
        cred = conn.execute(
            "SELECT id, site_id, label, username FROM credentials WHERE id = ?",
            (cred_id,),
        ).fetchone()
        if not cred:
            raise HTTPException(status_code=404, detail="credential not found")
        site_id = cred["site_id"]

        # Teams ที่มี cred นี้ใน team_credentials (ถูก "select" ไว้)
        team_rows = conn.execute(
            """
            SELECT t.id, t.name,
                   COALESCE(ts.access_type, 'none') AS site_access
            FROM teams t
            LEFT JOIN team_sites ts ON ts.team_id = t.id AND ts.site_id = ?
            WHERE t.id IN (SELECT team_id FROM team_credentials WHERE credential_id = ?)
            ORDER BY t.name
            """,
            (site_id, cred_id),
        ).fetchall()
        # ทุกทีมที่มี team_sites['all'] ของ site นี้ก็เห็น cred นี้โดยอัตโนมัติ —
        # เก็บไว้บอก UI เพื่อแสดงเป็น "auto-granted (via all)"
        auto_team_rows = conn.execute(
            """
            SELECT t.id, t.name
            FROM teams t
            JOIN team_sites ts ON ts.team_id = t.id
            WHERE ts.site_id = ? AND ts.access_type = 'all'
            ORDER BY t.name
            """,
            (site_id,),
        ).fetchall()

        # Direct member grants
        member_rows = conn.execute(
            """
            SELECT m.id, m.display_name, m.email, m.phone
            FROM members m
            JOIN credential_members cm ON cm.member_id = m.id
            WHERE cm.credential_id = ?
            ORDER BY m.display_name, m.id
            """,
            (cred_id,),
        ).fetchall()

    return {
        "credential": {"id": cred["id"], "label": cred["label"], "username": cred["username"], "site_id": site_id},
        "teams": [{"id": r["id"], "name": r["name"], "site_access": r["site_access"]} for r in team_rows],
        "auto_teams": [{"id": r["id"], "name": r["name"]} for r in auto_team_rows],
        "members": [
            {"id": r["id"], "display_name": r["display_name"], "email": r["email"], "phone": r["phone"]}
            for r in member_rows
        ],
    }


@app.put("/api/admin/credentials/{cred_id}/access")
def set_credential_access(
    cred_id: int,
    payload: CredentialAccessIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ตั้ง access ของ credential นี้เป็นชุดที่กำหนด (replace all)

    - teams: รายชื่อทีมที่จะเห็น credential นี้ (ผ่าน team_credentials)
      ถ้าทีมไม่มี team_sites สำหรับ site → สร้าง row พร้อม access_type='select'
    - members: รายชื่อ member ที่จะเห็นโดยตรง (ผ่าน credential_members)
    """
    now = utc_now().isoformat()
    target_teams = set(int(t) for t in payload.team_ids)
    target_members = set(int(m) for m in payload.member_ids)

    with db_conn() as conn:
        cred = conn.execute(
            "SELECT id, site_id FROM credentials WHERE id = ?", (cred_id,)
        ).fetchone()
        if not cred:
            raise HTTPException(status_code=404, detail="credential not found")
        site_id = cred["site_id"]

        # Validate teams + members exist
        if target_teams:
            valid_t = {r["id"] for r in conn.execute(
                f"SELECT id FROM teams WHERE id IN ({','.join('?'*len(target_teams))})",
                tuple(target_teams),
            ).fetchall()}
            if valid_t != target_teams:
                raise HTTPException(status_code=400, detail=f"team not found: {sorted(target_teams - valid_t)}")
        if target_members:
            valid_m = {r["id"] for r in conn.execute(
                f"SELECT id FROM members WHERE id IN ({','.join('?'*len(target_members))})",
                tuple(target_members),
            ).fetchall()}
            if valid_m != target_members:
                raise HTTPException(status_code=400, detail=f"member not found: {sorted(target_members - valid_m)}")

        # === Teams ===
        current_teams = {r["team_id"] for r in conn.execute(
            "SELECT team_id FROM team_credentials WHERE credential_id = ?", (cred_id,)
        ).fetchall()}
        for tid in target_teams - current_teams:
            # ตรวจ team_sites — ถ้ายังไม่มี → สร้างด้วย access_type='select'
            existing = conn.execute(
                "SELECT 1 FROM team_sites WHERE team_id = ? AND site_id = ?",
                (tid, site_id),
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT INTO team_sites(team_id, site_id, access_type, added_at) "
                    "VALUES (?, ?, 'select', ?)",
                    (tid, site_id, now),
                )
            conn.execute(
                "INSERT INTO team_credentials(team_id, credential_id, added_at) VALUES (?, ?, ?)",
                (tid, cred_id, now),
            )
        for tid in current_teams - target_teams:
            conn.execute(
                "DELETE FROM team_credentials WHERE team_id = ? AND credential_id = ?",
                (tid, cred_id),
            )

        # === Direct member grants ===
        current_members = {r["member_id"] for r in conn.execute(
            "SELECT member_id FROM credential_members WHERE credential_id = ?", (cred_id,)
        ).fetchall()}
        for mid in target_members - current_members:
            conn.execute(
                "INSERT INTO credential_members(credential_id, member_id, added_at) VALUES (?, ?, ?)",
                (cred_id, mid, now),
            )
        for mid in current_members - target_members:
            conn.execute(
                "DELETE FROM credential_members WHERE credential_id = ? AND member_id = ?",
                (cred_id, mid),
            )

    return {"ok": True}


# ===========================================================================
# Extension-facing endpoints (no admin auth — local only)
# ===========================================================================
@app.get("/api/extension/match")
def extension_match(
    url: str,
    member_id: Optional[int] = None,
    x_fct_version: Optional[str] = Header(default=None, alias="X-FCT-Version"),
    _auth: str = Depends(require_admin_or_api_key),
) -> dict[str, Any]:
    """ตรวจว่า URL ตรงกับ site ใดที่ลงทะเบียนไว้ ถ้าใช่ คืน credentials.

    Strict opt-in (consistent กับ /api/my-platforms):
    - Admin-paired extension (member_id=None) → คืน credentials ทุก row ของ site
    - Member-paired extension → ต้องอยู่ใน team ที่มี team_sites ผูกกับ site นี้:
      * access_type='all'    → เห็น credentials ทุก row ของ site
      * access_type='select' → เห็นเฉพาะ credentials ที่ team_credentials ระบุ
      * Member ในหลายทีม → union (ถ้าทีมใดทีมหนึ่งมี 'all' → เห็นทั้งหมด)
    - ถ้า site ไม่ถูกผูกทีมใดเลย → member ไม่ได้ autofill (คืน credentials ว่าง)
      เพื่อให้ตรงกับ Platforms page ที่ก็ไม่โชว์ site แบบนี้ให้ member
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

        # access_info: diagnostic เพื่อบอกฝั่ง extension ว่า credentials ที่ส่งกลับ
        # มาจาก rule ไหน — ช่วย debug "ทำไมยังเห็น"
        access_info: dict[str, Any] = {
            "member_id": member_id,
            "via": None,           # 'admin_paired' | 'team_all' | 'team_select' | 'no_access'
            "teams": [],           # list of {id, name, access_type} ที่ contribute
        }

        if member_id is None:
            # Admin-paired → ไม่ filter (ใช้สำหรับ admin หรือ super admin)
            creds = conn.execute(
                "SELECT id, label, username, password "
                "FROM credentials WHERE site_id = ? "
                "ORDER BY last_used_at DESC NULLS LAST, created_at DESC",
                (matched_id,),
            ).fetchall()
            access_info["via"] = "admin_paired"
            access_info["reason"] = "Extension ถูก pair เป็น admin (member_id=null) — bypass team filter ทั้งหมด"
        else:
            # Member-paired → รวมสิทธิ์จาก team_sites/team_credentials + direct credential_members
            access_rows = conn.execute(
                "SELECT t.id AS team_id, t.name AS team_name, ts.access_type "
                "FROM team_members tm "
                "JOIN team_sites ts ON ts.team_id = tm.team_id "
                "JOIN teams t ON t.id = tm.team_id "
                "WHERE ts.site_id = ? AND tm.member_id = ?",
                (matched_id, member_id),
            ).fetchall()
            access_info["teams"] = [
                {"id": r["team_id"], "name": r["team_name"], "access_type": r["access_type"]}
                for r in access_rows
            ]
            # v1.11 — direct member grants (อยู่นอกระบบ team)
            direct_cred_rows = conn.execute(
                "SELECT c.id, c.label, c.username, c.password "
                "FROM credentials c "
                "JOIN credential_members cm ON cm.credential_id = c.id "
                "WHERE c.site_id = ? AND cm.member_id = ? "
                "ORDER BY c.last_used_at DESC NULLS LAST, c.created_at DESC",
                (matched_id, member_id),
            ).fetchall()
            access_info["direct_credentials"] = len(direct_cred_rows)

            cred_map: dict[int, dict[str, Any]] = {}   # id → row dict (UNION across all sources)

            if any(r["access_type"] == "all" for r in access_rows):
                # อย่างน้อย 1 ทีมให้ access 'all' → ทุก credential ของ site
                team_all_rows = conn.execute(
                    "SELECT id, label, username, password "
                    "FROM credentials WHERE site_id = ? "
                    "ORDER BY last_used_at DESC NULLS LAST, created_at DESC",
                    (matched_id,),
                ).fetchall()
                for r in team_all_rows:
                    cred_map[r["id"]] = dict(r)
                all_teams = [t["name"] for t in access_info["teams"] if t["access_type"] == "all"]
                access_info["via"] = "team_all"
                access_info["reason"] = (
                    f"ผ่าน team '{', '.join(all_teams)}' (access_type=all) → ทุก credential"
                )
            elif access_rows:
                # ทุกทีมเป็น 'select' → เอา credentials ที่ team_credentials ระบุไว้
                team_sel_rows = conn.execute(
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
                for r in team_sel_rows:
                    cred_map[r["id"]] = dict(r)
                sel_teams = [t["name"] for t in access_info["teams"]]
                access_info["via"] = "team_select"
                access_info["reason"] = (
                    f"ผ่าน team '{', '.join(sel_teams)}' (access_type=select) → "
                    f"{len(team_sel_rows)} credential"
                )

            # Add direct grants (UNION) — แม้ไม่มี team access ก็เห็น credential ที่ถูก grant ตรง
            for r in direct_cred_rows:
                cred_map[r["id"]] = dict(r)

            if not cred_map:
                creds = []
                access_info["via"] = "no_access"
                access_info["reason"] = (
                    f"member_id={member_id} ไม่อยู่ใน team ใดที่ grant site นี้ + "
                    f"ไม่มี direct grant → ไม่มี credential"
                )
            else:
                creds = list(cred_map.values())
                # ถ้ามาจาก direct grant อย่างเดียว (ไม่ได้ผ่าน team) → ปรับ via
                if not access_rows and direct_cred_rows:
                    access_info["via"] = "direct_grant"
                    access_info["reason"] = (
                        f"ผ่าน direct grant ที่ credential_members → {len(direct_cred_rows)} credential"
                    )
                elif direct_cred_rows:
                    access_info["reason"] += (
                        f" + direct grant {len(direct_cred_rows)} credential"
                    )

    # v1.17 — บันทึก extension version ของ member นี้ (ถ้า paired-as-member)
    record_member_extension_use(member_id, x_fct_version)

    return {
        "matched": True,
        "site": matched_site,
        "credentials": [dict(c) for c in creds],
        "access": access_info,
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
    x_fct_version: Optional[str] = Header(default=None, alias="X-FCT-Version"),
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
    # v1.17 — บันทึก extension version ของ member นี้
    record_member_extension_use(member_id, x_fct_version)

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
    avatar_data: Optional[str] = Field(None, max_length=700_000)   # data:image/png;base64,...


def _require_member_session(token: Optional[str]) -> dict[str, Any]:
    sess = get_member_session(token)
    if not sess:
        raise HTTPException(status_code=401, detail="ไม่ได้เข้าสู่ระบบ")
    return sess


def _member_row_to_profile(row: sqlite3.Row) -> dict[str, Any]:
    # is_admin อาจไม่มีใน row เก่า — fallback เป็น False
    try:
        is_admin = bool(row["is_admin"])
    except (KeyError, IndexError):
        is_admin = False
    try:
        avatar_data = row["avatar_data"]
    except (KeyError, IndexError):
        avatar_data = None
    return {
        "id": row["id"],
        "phone": row["phone"],
        "email": row["email"],
        "display_name": row["display_name"],
        "has_password": bool(row["pw_hash"]),
        "is_admin": is_admin,
        "avatar_data": avatar_data,
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
    if payload.avatar_data is not None:
        # ส่ง '' (empty string) → ลบ avatar (NULL)
        updates["avatar_data"] = payload.avatar_data or None

    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [member_id]
    try:
        with db_conn() as conn:
            conn.execute(f"UPDATE members SET {set_clause} WHERE id = ?", values)
            row = conn.execute(
                "SELECT id, phone, email, display_name, pw_hash, is_admin, avatar_data, "
                "       created_at, last_login_at "
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


@app.get("/api/teams-overview")
def teams_overview(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """รายชื่อทีม + site_ids ที่แต่ละทีมเข้าถึงได้ — ใช้ใน Platforms page (spotlight)
    เปิดให้ทุก authenticated user เพื่อให้ member เห็นภาพรวมแผนกได้
    """
    with db_conn() as conn:
        teams = conn.execute(
            "SELECT id, name, description, "
            "  (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count "
            "FROM teams t ORDER BY name COLLATE NOCASE"
        ).fetchall()
        ts_rows = conn.execute(
            "SELECT team_id, site_id FROM team_sites"
        ).fetchall()
    site_by_team: dict[int, list[int]] = {}
    for r in ts_rows:
        site_by_team.setdefault(r["team_id"], []).append(r["site_id"])
    return {
        "teams": [
            {
                "id": t["id"],
                "name": t["name"],
                "description": t["description"],
                "member_count": t["member_count"],
                "site_ids": site_by_team.get(t["id"], []),
            }
            for t in teams
        ]
    }


@app.get("/api/members/{member_id}/accessible-sites")
def member_accessible_sites(
    member_id: int,
    sess: dict = Depends(require_admin_or_member),
) -> dict[str, Any]:
    """รายชื่อ platform ที่ member นี้เข้าถึงได้ — เปิดให้ทุก logged-in user

    คืนแต่ละ site พร้อม access breakdown:
      - via_teams: [{id, name, access_type}, ...] — ทีมที่ grant site นี้
      - direct_credentials: int — จำนวน credential ที่ direct grant
    """
    can_manage = (
        sess.get("role") == "admin"
        or (sess.get("role") == "member" and _member_is_admin(sess.get("member_id", 0)))
    )

    with db_conn() as conn:
        member = conn.execute(
            "SELECT id, display_name, email, phone, avatar_data, created_at "
            "FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if not member:
            raise HTTPException(status_code=404, detail="member not found")

        accessible = conn.execute(
            """
            SELECT DISTINCT s.id, s.name, s.url_pattern, s.logo_data,
                   (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count
            FROM sites s
            WHERE s.id IN (
                SELECT ts.site_id FROM team_sites ts
                JOIN team_members tm ON tm.team_id = ts.team_id
                WHERE tm.member_id = ?
                UNION
                SELECT c.site_id FROM credentials c
                JOIN credential_members cm ON cm.credential_id = c.id
                WHERE cm.member_id = ?
            )
            ORDER BY s.name COLLATE NOCASE
            """,
            (member_id, member_id),
        ).fetchall()

        teams = conn.execute(
            "SELECT t.id, t.name "
            "FROM team_members tm JOIN teams t ON t.id = tm.team_id "
            "WHERE tm.member_id = ? ORDER BY t.name",
            (member_id,),
        ).fetchall()

        # Per-site access breakdown — เพื่อแสดงว่า "ใช้ได้เพราะ team / direct" ในแต่ละ card
        team_access_rows = conn.execute(
            """
            SELECT ts.site_id, t.id AS team_id, t.name AS team_name, ts.access_type
            FROM team_members tm
            JOIN team_sites ts ON ts.team_id = tm.team_id
            JOIN teams t ON t.id = tm.team_id
            WHERE tm.member_id = ?
            """,
            (member_id,),
        ).fetchall()
        team_by_site: dict[int, list[dict[str, Any]]] = {}
        for r in team_access_rows:
            team_by_site.setdefault(r["site_id"], []).append({
                "id": r["team_id"], "name": r["team_name"], "access_type": r["access_type"],
            })

        direct_rows = conn.execute(
            """
            SELECT c.site_id, COUNT(DISTINCT c.id) AS n
            FROM credential_members cm
            JOIN credentials c ON c.id = cm.credential_id
            WHERE cm.member_id = ?
            GROUP BY c.site_id
            """,
            (member_id,),
        ).fetchall()
        direct_by_site = {r["site_id"]: r["n"] for r in direct_rows}

        no_access = []
        if can_manage:
            no_access = conn.execute(
                """
                SELECT s.id, s.name, s.url_pattern, s.logo_data,
                       (SELECT COUNT(*) FROM credentials c WHERE c.site_id = s.id) AS cred_count
                FROM sites s
                WHERE s.id NOT IN (
                    SELECT ts.site_id FROM team_sites ts
                    JOIN team_members tm ON tm.team_id = ts.team_id
                    WHERE tm.member_id = ?
                    UNION
                    SELECT c.site_id FROM credentials c
                    JOIN credential_members cm ON cm.credential_id = c.id
                    WHERE cm.member_id = ?
                )
                ORDER BY s.name COLLATE NOCASE
                """,
                (member_id, member_id),
            ).fetchall()

    # แนบ via_teams + direct_credentials ให้แต่ละ accessible site
    accessible_data = []
    for s in accessible:
        sd = dict(s)
        sd["via_teams"] = team_by_site.get(sd["id"], [])
        sd["direct_credentials"] = direct_by_site.get(sd["id"], 0)
        accessible_data.append(sd)

    return {
        "member": dict(member),
        "teams": [dict(t) for t in teams],
        "sites": accessible_data,
        "sites_no_access": [dict(s) for s in no_access] if can_manage else [],
        "viewer_can_manage": can_manage,
    }


@app.get("/api/members/recent")
def members_recent(
    limit: int = 20,
    _auth: str = Depends(require_any_auth),
) -> dict[str, Any]:
    """Member ที่เข้ามาใหม่ — sort created_at DESC, ใช้ใน Dashboard

    เปิดให้ admin และ member อ่านได้ — แต่จะ filter เอาเฉพาะ enabled members
    """
    limit = max(1, min(100, limit))
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, display_name, email, phone, avatar_data, created_at "
            "FROM members WHERE COALESCE(enabled, 1) = 1 "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {
        "members": [
            {
                "id": r["id"],
                "display_name": r["display_name"],
                "email": r["email"],
                "phone": r["phone"],
                "avatar_data": r["avatar_data"],
                "created_at": r["created_at"],
            }
            for r in rows
        ],
    }


@app.get("/api/member/me")
def member_me(
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = get_member_session(fct_member_session)
    if not sess:
        return {"logged_in": False}
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, phone, email, display_name, pw_hash, is_admin, avatar_data, "
            "       created_at, last_login_at "
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

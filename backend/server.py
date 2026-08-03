"""Freepik Credit Tracker — local FastAPI backend.

Receives credit-balance snapshots from the Chrome extension, stores them in
SQLite, and serves analytics + a single-page dashboard. Bind only to
127.0.0.1 — this server is not meant to be exposed to the network.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json as _json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import urllib.error
import urllib.request
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
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
_SQLITE_PRAGMA_DONE = False


@contextmanager
def db_conn() -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection (WAL + busy_timeout เพื่อลด lock contention / กันบันทึกค้าง)."""
    global _SQLITE_PRAGMA_DONE
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout=15000")   # รอ lock ได้สูงสุด 15s (แทน 5s default)
        if not _SQLITE_PRAGMA_DONE:
            # WAL: reader/writer ไม่บล็อกกัน (ตั้งครั้งเดียวก็ persistent ทั้ง DB)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            _SQLITE_PRAGMA_DONE = True
    except sqlite3.Error:
        pass
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
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL UNIQUE,
                description     TEXT,
                created_at      TEXT NOT NULL,
                -- v1.9.58: รองรับ hierarchy — NULL = ทีมระดับบนสุด (root)
                parent_team_id  INTEGER REFERENCES teams(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS team_members (
                team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                added_at   TEXT NOT NULL,
                PRIMARY KEY (team_id, member_id)
            );
            -- v1.9.125: member supervise teams (ดูข้อมูลทีมที่ดูแลได้ — ไม่ใช่สมาชิกทีม)
            CREATE TABLE IF NOT EXISTS member_supervised_teams (
                member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (member_id, team_id)
            );
            -- v1.9.132: Skill Marketplace
            CREATE TABLE IF NOT EXISTS skills (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                description    TEXT,
                category       TEXT NOT NULL DEFAULT 'development',
                content        TEXT,                -- SKILL.md content (markdown)
                tags           TEXT,                -- comma-separated
                file_name      TEXT,                -- ไฟล์ skill ต้นฉบับ (สำหรับ download)
                file_data      TEXT,                -- base64
                file_mime      TEXT,
                owner_member_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
                owner_name         TEXT,
                uploader_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
                uploader_name      TEXT,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL,
                updated_at     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
            CREATE TABLE IF NOT EXISTS skill_examples (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                skill_id        INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
                prompt          TEXT,
                result_filename TEXT,
                result_mime     TEXT,
                result_data     TEXT,               -- base64
                creator_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
                creator_name    TEXT,
                created_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_skill_examples_skill ON skill_examples(skill_id);
            -- v1.9.135: หมวดหมู่ skill (เพิ่ม/แก้ไขได้)
            CREATE TABLE IF NOT EXISTS skill_categories (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                key        TEXT NOT NULL UNIQUE,
                icon       TEXT,
                label      TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            -- v1.9.143: AI Project (gallery เว็บ AI ในองค์กร)
            CREATE TABLE IF NOT EXISTS ai_projects (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                title          TEXT NOT NULL,
                url            TEXT,
                description    TEXT,
                department     TEXT,                -- แผนก (ชื่อทีม) สำหรับ filter
                tags           TEXT,                -- comma-separated
                image_data     TEXT,                -- base64 data URL (crop 16:9)
                started_month  TEXT,                -- 'YYYY-MM' เดือนที่เริ่มสร้าง
                owner_member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
                owner_name        TEXT,
                creator_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
                creator_name      TEXT,
                created_at     TEXT NOT NULL,
                updated_at     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ai_projects_dept ON ai_projects(department);
            -- v1.9.162: IAM — กำหนดสิทธิ์เข้าถึง module (Ads/Customer/Platform) ต่อบุคคล/ทีม/ทั้งหมด
            CREATE TABLE IF NOT EXISTS iam_module_config (
                module_key TEXT PRIMARY KEY,            -- 'ads' | 'customer' | 'platform'
                mode       TEXT NOT NULL DEFAULT 'restricted',  -- 'all' | 'restricted'
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS iam_module_members (
                module_key TEXT NOT NULL,
                member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                PRIMARY KEY (module_key, member_id)
            );
            CREATE TABLE IF NOT EXISTS iam_module_teams (
                module_key TEXT NOT NULL,
                team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                PRIMARY KEY (module_key, team_id)
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

            -- v1.18 — Domain name tracking (general เห็นได้, admin จัดการ)
            CREATE TABLE IF NOT EXISTS domains (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL UNIQUE,
                register_date   TEXT,                -- ISO YYYY-MM-DD
                expire_date     TEXT,                -- ISO YYYY-MM-DD
                provider        TEXT,                -- e.g., GoDaddy, Namecheap
                notes           TEXT,
                created_at      TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS domain_renewals (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                domain_id        INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
                renewed_at       TEXT NOT NULL,
                new_expire_date  TEXT NOT NULL,
                old_expire_date  TEXT,
                receipt_data     TEXT,               -- base64 (PDF/image)
                receipt_name     TEXT,               -- original filename
                receipt_type     TEXT,               -- MIME type
                cost_amount      REAL,
                cost_currency    TEXT,
                note             TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_domains_expire ON domains(expire_date);
            CREATE INDEX IF NOT EXISTS idx_domain_renewals_domain ON domain_renewals(domain_id);

            -- v1.9.36 — Hardware (PC / Device / Network) + ประวัติการครอบครอง
            CREATE TABLE IF NOT EXISTS hardware (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                hw_type           TEXT NOT NULL,   -- 'pc' | 'device' | 'network'
                name              TEXT NOT NULL,   -- ชื่อเครื่อง / device
                asset_number      TEXT,            -- เลข assets ภายใน
                purchased_at      TEXT,            -- ISO YYYY-MM-DD
                notes             TEXT,
                created_at        TEXT NOT NULL,
                -- PC-specific fields
                os                TEXT,            -- macOS / Windows / Linux / etc.
                cpu               TEXT,
                ram               TEXT,            -- '16GB DDR4'
                storage           TEXT,            -- '512GB SSD'
                -- Device-specific fields
                device_subtype    TEXT,            -- 'External HDD' / 'WACOM' / 'Monitor' (free-form)
                capacity          TEXT,            -- '1TB' / '4K 27"' (free-form)
                -- ผูกกับ member ปัจจุบัน
                current_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
                -- v1.9.37: รูปภาพ (base64 JPEG, ~640x480)
                photo_data        TEXT,
                -- v1.9.38: extended PC fields
                serial_number     TEXT,
                display           TEXT,
                department        TEXT,
                location          TEXT,
                os_version        TEXT,
                model             TEXT,
                mainboard         TEXT,
                gpu               TEXT,
                battery           TEXT,
                ups               TEXT,
                status            TEXT,
                quotation         TEXT,
                -- v1.9.50: รูปภาพหมายเลข asset (ติด tag/sticker บนเครื่อง)
                asset_photo_data  TEXT,
                -- v1.9.65: ทีม/แผนกที่เครื่องสังกัด เมื่อยังไม่มี owner (เช่น เก็บใน stock)
                unassigned_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
                -- v1.9.65: ตำแหน่งเก็บฟิสิคัล (ตู้/ชั้น) เมื่อยังไม่มี owner
                storage_location  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_hardware_type ON hardware(hw_type);
            CREATE INDEX IF NOT EXISTS idx_hardware_member ON hardware(current_member_id);
            CREATE TABLE IF NOT EXISTS hardware_assignments (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                hardware_id     INTEGER NOT NULL REFERENCES hardware(id) ON DELETE CASCADE,
                member_id       INTEGER REFERENCES members(id) ON DELETE SET NULL,
                member_label    TEXT,           -- snapshot ของชื่อ member ตอน assign (กันสูญหาย)
                assigned_at     TEXT NOT NULL,
                unassigned_at   TEXT,           -- NULL = ยังถือครองอยู่
                note            TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_hw_asg_hw ON hardware_assignments(hardware_id);
            CREATE INDEX IF NOT EXISTS idx_hw_asg_member ON hardware_assignments(member_id);

            -- v1.9.76 — Financial Document (เอกสารการสั่งซื้อ) + หลายหน้าต่อชุด
            CREATE TABLE IF NOT EXISTS financial_documents (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,           -- ชื่อชุดเอกสาร (auto จาก OCR หรือ user)
                doc_date    TEXT,                    -- ISO YYYY-MM-DD (จาก OCR หรือ user)
                amount      REAL,                    -- จำนวนเงิน (จาก OCR หรือ user)
                currency    TEXT DEFAULT 'THB',
                vendor      TEXT,                    -- ผู้รับเงิน (optional)
                notes       TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_findoc_date ON financial_documents(doc_date);
            CREATE TABLE IF NOT EXISTS financial_document_pages (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id  INTEGER NOT NULL REFERENCES financial_documents(id) ON DELETE CASCADE,
                page_order   INTEGER NOT NULL DEFAULT 0,
                image_data   TEXT NOT NULL,          -- v1.9.80: base64 ต้นฉบับ (no recompress)
                thumb_data   TEXT,                   -- v1.9.80: base64 JPEG ~300px สำหรับ grid
                ocr_text     TEXT,                   -- ผล OCR (ไว้ debug / search future)
                created_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_findoc_pages_doc ON financial_document_pages(document_id, page_order);

            -- v1.9.85 — member aliases: เก็บค่า identity เดิมของ account ที่ถูก merge เข้ามา
            -- เพื่อให้ login เดิม (phone/firebase_uid/email) ยังเจอ profile ใหม่ (primary)
            CREATE TABLE IF NOT EXISTS member_aliases (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                kind        TEXT NOT NULL,           -- 'phone' | 'email' | 'firebase_uid'
                value       TEXT NOT NULL,
                source      TEXT,                    -- e.g. 'merged_from:42'
                created_at  TEXT NOT NULL,
                UNIQUE (kind, value)
            );
            CREATE INDEX IF NOT EXISTS idx_member_aliases_member ON member_aliases(member_id);

            -- v1.9.82 — M:N link ระหว่าง hardware (PC) กับ financial documents
            CREATE TABLE IF NOT EXISTS hardware_financial_documents (
                hardware_id            INTEGER NOT NULL REFERENCES hardware(id) ON DELETE CASCADE,
                financial_document_id  INTEGER NOT NULL REFERENCES financial_documents(id) ON DELETE CASCADE,
                created_at             TEXT NOT NULL,
                PRIMARY KEY (hardware_id, financial_document_id)
            );
            CREATE INDEX IF NOT EXISTS idx_hwfindoc_doc ON hardware_financial_documents(financial_document_id);

            -- v1.9.25 — บริการ Hosting / SSL / Others + ผูกกับ domain (Website)
            CREATE TABLE IF NOT EXISTS services (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                service_type  TEXT NOT NULL,   -- 'hosting' | 'ssl' | 'others'
                name          TEXT NOT NULL,   -- ชื่อบริการ เช่น "DigitalOcean Droplet"
                provider      TEXT,            -- ผู้ให้บริการ
                price         REAL,            -- ราคา
                currency      TEXT DEFAULT 'THB',   -- THB / USD
                expire_date   TEXT,            -- ISO YYYY-MM-DD
                notes         TEXT,
                created_at    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_services_type ON services(service_type);
            CREATE INDEX IF NOT EXISTS idx_services_expire ON services(expire_date);
            -- Many-to-many: 1 domain ผูกกับหลาย service ได้ และ 1 service ผูกได้หลาย domain
            CREATE TABLE IF NOT EXISTS domain_services (
                domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
                service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
                created_at  TEXT NOT NULL,
                PRIMARY KEY (domain_id, service_id)
            );
            CREATE INDEX IF NOT EXISTS idx_domain_services_service ON domain_services(service_id);

            -- v1.9.278 — Workflow builder (n8n-style) — nodes/edges เก็บเป็น JSON ใน data
            CREATE TABLE IF NOT EXISTS workflows (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                name               TEXT NOT NULL,
                department         TEXT,
                creator_member_id  INTEGER,
                data               TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
                is_active          INTEGER NOT NULL DEFAULT 1,
                created_at         TEXT NOT NULL,
                updated_at         TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_collaborators (
                workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
                member_id    INTEGER NOT NULL,
                added_at     TEXT NOT NULL,
                PRIMARY KEY (workflow_id, member_id)
            );
            CREATE TABLE IF NOT EXISTS workflow_notes (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
                member_id    INTEGER,
                body         TEXT NOT NULL,
                created_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_wf_notes_wf ON workflow_notes(workflow_id);

            -- v1.9.291 — ประวัติสถานะคอมฯ (หมายเหตุ + checkbox) — แทรกใหม่บนสุด เก็บผู้กรอก
            CREATE TABLE IF NOT EXISTS hardware_status_log (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                hardware_id       INTEGER NOT NULL REFERENCES hardware(id) ON DELETE CASCADE,
                note_category     TEXT,
                notes             TEXT,
                is_personal_owned INTEGER NOT NULL DEFAULT 0,
                for_new_position  INTEGER NOT NULL DEFAULT 0,
                is_handed_down    INTEGER NOT NULL DEFAULT 0,
                created_by        TEXT,
                created_at        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_hw_status_log_hw ON hardware_status_log(hardware_id);

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
            # v1.9.303 — รูป screenshot/อ้างอิงของเว็บ (กด preview ได้)
            ("image_data",    "TEXT"),                              # data:image/jpeg;base64,...
            # v1.9.304 — หมายเหตุระดับ platform (ก่อน login)
            ("note",          "TEXT"),
        ]:
            if col_name not in site_cols:
                conn.execute(f"ALTER TABLE sites ADD COLUMN {col_name} {col_def}")

        # teams table — display_order สำหรับ drag-to-reorder (v1.18)
        team_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(teams)").fetchall()
        }
        if "display_order" not in team_cols:
            conn.execute("ALTER TABLE teams ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0")
            # initial seed: order ตาม created_at ASC
            existing = conn.execute("SELECT id FROM teams ORDER BY created_at ASC").fetchall()
            for idx, r in enumerate(existing):
                conn.execute("UPDATE teams SET display_order = ? WHERE id = ?", (idx, r["id"]))
        # v1.9.58 — parent_team_id เพื่อให้ทีมเป็น hierarchy ได้
        if "parent_team_id" not in team_cols:
            conn.execute("ALTER TABLE teams ADD COLUMN parent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_teams_parent ON teams(parent_team_id)")

        # domains table — per-field WHOIS sync timestamps (v1.9.17)
        # ใช้ track ว่า register_date / expire_date มาจาก WHOIS เมื่อใด
        domain_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(domains)").fetchall()
        }
        for col_name in ("register_whois_synced_at", "expire_whois_synced_at"):
            if col_name not in domain_cols:
                conn.execute(f"ALTER TABLE domains ADD COLUMN {col_name} TEXT")
        # v1.9.30 — logo (base64 data URL) สำหรับ Website/Domain card
        if "logo_data" not in domain_cols:
            conn.execute("ALTER TABLE domains ADD COLUMN logo_data TEXT")
        # v1.9.272 — สถานะลูกค้า: 'current' (ลูกค้าปัจจุบัน) | 'former' (อดีตลูกค้า)
        if "customer_status" not in domain_cols:
            conn.execute("ALTER TABLE domains ADD COLUMN customer_status TEXT NOT NULL DEFAULT 'current'")

        # v1.9.37 — photo + v1.9.38 — extended PC fields (serial, display, dept,
        # location, os_version, model, mainboard, gpu, battery, ups, status, quotation)
        try:
            hw_cols = {
                row["name"] for row in conn.execute("PRAGMA table_info(hardware)").fetchall()
            }
            extra_cols = [
                ("photo_data", "TEXT"),
                ("serial_number", "TEXT"),
                ("display", "TEXT"),
                ("department", "TEXT"),
                ("location", "TEXT"),
                ("os_version", "TEXT"),
                ("model", "TEXT"),
                ("mainboard", "TEXT"),
                ("gpu", "TEXT"),
                ("battery", "TEXT"),
                ("ups", "TEXT"),
                ("status", "TEXT"),
                ("quotation", "TEXT"),
                # v1.9.50
                ("asset_photo_data", "TEXT"),
                # v1.9.65
                ("unassigned_team_id", "INTEGER REFERENCES teams(id) ON DELETE SET NULL"),
                ("storage_location", "TEXT"),
                # v1.9.245 — หมวดหมายเหตุ: 'general' | 'keep' (ยังไม่เปลี่ยน) | 'procuring' (อยู่ระหว่างจัดหา)
                ("note_category", "TEXT"),
                # v1.9.252 — เครื่องเป็นของพนักงานเอง (BYOD)
                ("is_personal_owned", "INTEGER NOT NULL DEFAULT 0"),
                # v1.9.289 — คอมฯสำหรับตำแหน่งเปิดใหม่ (สำรองรอพนักงานใหม่)
                ("for_new_position", "INTEGER NOT NULL DEFAULT 0"),
                # v1.9.290 — คอมฯส่งต่อมาจากท่านอื่น (มือสอง — ไม่นำไปคำนวณว่าควรเปลี่ยน)
                ("is_handed_down", "INTEGER NOT NULL DEFAULT 0"),
                # v1.9.329 — สถานะคอมเก่าเมื่อได้เครื่องนี้มา
                ("old_pc_bought_by_employee", "INTEGER NOT NULL DEFAULT 0"),   # พนักงานซื้อคอมเก่าไป
                ("old_pc_broken",             "INTEGER NOT NULL DEFAULT 0"),   # ชำรุดซ่อมไม่ได้
                ("old_pc_donated_sold",       "INTEGER NOT NULL DEFAULT 0"),   # บริจาค / จำหน่าย
            ]
            for col_name, col_type in extra_cols:
                if hw_cols and col_name not in hw_cols:
                    conn.execute(f"ALTER TABLE hardware ADD COLUMN {col_name} {col_type}")
        except sqlite3.OperationalError:
            # hardware table อาจไม่มีอยู่ (DB เก่ามาก) — schema CREATE TABLE จะสร้างให้ในรอบนี้
            pass

        # v1.9.80 — financial_document_pages: เพิ่ม thumb_data column สำหรับ grid display
        try:
            fp_cols = {
                row["name"] for row in conn.execute("PRAGMA table_info(financial_document_pages)").fetchall()
            }
            if fp_cols and "thumb_data" not in fp_cols:
                conn.execute("ALTER TABLE financial_document_pages ADD COLUMN thumb_data TEXT")
        except sqlite3.OperationalError:
            pass

        # v1.9.301 — financial_documents: tags (หมวดหมู่ — comma-separated)
        try:
            fd_cols = {
                row["name"] for row in conn.execute("PRAGMA table_info(financial_documents)").fetchall()
            }
            if fd_cols and "tags" not in fd_cols:
                conn.execute("ALTER TABLE financial_documents ADD COLUMN tags TEXT")
        except sqlite3.OperationalError:
            pass

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
            # v1.9.74 — shirt size สำหรับ admin order เสื้อพนักงาน
            ("shirt_size",             "TEXT"),
            # v1.9.75 — วันเกิด (ISO YYYY-MM-DD)
            ("birthdate",              "TEXT"),
            # v1.9.92 — เก็บ Wazzup profileURL (raw จาก Wazzup) เพื่อให้ admin ดึงรูปได้
            ("wazzup_profile_url",     "TEXT"),
            # v1.9.93 — Wazzup employee code (admin ป้อนเอง / extract จาก profileURL ตอน login)
            ("wazzup_emp_code",        "TEXT"),
            # v1.9.147 — privacy: แชร์ข้อมูลให้คนอื่นเห็นไหม (1=แชร์, 0=ส่วนตัว)
            ("share_birthdate",        "INTEGER NOT NULL DEFAULT 1"),
            ("share_shirt_size",       "INTEGER NOT NULL DEFAULT 1"),
            ("share_phone",            "INTEGER NOT NULL DEFAULT 1"),
            # v1.9.229 — Temporary Staff: สร้างก่อนเจ้าตัว login (placeholder firebase_uid) → ผูกอุปกรณ์/แผนกชั่วคราว
            ("is_temp",                "INTEGER NOT NULL DEFAULT 0"),
            ("temp_department",        "TEXT"),
            # v1.9.261 — ใช้คอมพิวเตอร์ของตนเอง (BYOD) สำหรับคนที่ไม่มีเครื่องบริษัท + ระบุว่าเป็นคอมฯอะไร
            ("uses_own_computer",      "INTEGER NOT NULL DEFAULT 0"),
            ("own_computer_info",      "TEXT"),
            # v1.9.263 — Alumni (อดีตพนักงาน) + วันทำงานวันสุดท้าย — ไม่นับรวมจำนวนพนักงาน
            ("is_alumni",              "INTEGER NOT NULL DEFAULT 0"),
            ("last_working_day",       "TEXT"),
            # v1.9.328 — คนที่ replace (มาแทน) — ชี้ไป member_id ของ alumni ที่คนนี้มาแทน
            ("replaces_member_id",     "INTEGER REFERENCES members(id) ON DELETE SET NULL"),
            # v1.9.385 — ข้อมูลตามระบบ HR (admin แก้ไขได้) — hr_employee_id ใช้จับคู่ประวัติการลา (Absence)
            ("hr_name",                "TEXT"),
            ("hr_employee_id",         "TEXT"),
        ]:
            if col_name not in member_cols:
                conn.execute(f"ALTER TABLE members ADD COLUMN {col_name} {col_def}")
        # Email ต้องไม่ซ้ำ (ใช้ partial unique index — เฉพาะ row ที่ email ไม่ NULL)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email "
            "ON members(email) WHERE email IS NOT NULL"
        )

        # v1.9.369 — ai_projects: pin โปรเจกต์สำคัญไว้บนสุด
        aiproj_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(ai_projects)").fetchall()
        }
        for col_name, col_def in [
            ("pinned",    "INTEGER NOT NULL DEFAULT 0"),
            ("pinned_at", "TEXT"),
        ]:
            if col_name not in aiproj_cols:
                conn.execute(f"ALTER TABLE ai_projects ADD COLUMN {col_name} {col_def}")

        # ---- 3. indexes ที่ขึ้นกับคอลัมน์ใหม่ (สร้างหลัง migration)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_profile ON snapshots(profile_name)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_host ON snapshots(host_name)"
        )

        # ---- 3.5 v1.9.113 — ล้าง orphaned member_aliases (member ถูกลบแต่ alias ค้าง
        # เพราะ FK CASCADE ไม่ทำงาน) เพื่อปลดล็อก email/phone ที่ค้างใช้ซ้ำไม่ได้
        try:
            conn.execute(
                "DELETE FROM member_aliases WHERE member_id NOT IN (SELECT id FROM members)"
            )
        except Exception:
            pass

        # ---- 3.9 v1.9.207 — Claude RateLimit tables
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS claude_accounts (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                label          TEXT    NOT NULL,
                storage_state  TEXT,                       -- encrypted (fe:/b64:)
                session_status TEXT    DEFAULT 'no_session', -- healthy | expired | no_session
                created_at     TEXT    NOT NULL,
                updated_at     TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS claude_usage_snapshots (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id           INTEGER NOT NULL,
                session_pct          REAL,
                session_reset_at     TEXT,
                weekly_pct           REAL,
                weekly_reset_at      TEXT,
                weekly_opus_pct      REAL,
                weekly_opus_reset_at TEXT,
                raw_json             TEXT,
                status               TEXT,                 -- ok | full | expired | error
                checked_at           TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_clrl_snap ON claude_usage_snapshots(account_id, checked_at);
            CREATE TABLE IF NOT EXISTS claude_ratelimit_settings (
                id            INTEGER PRIMARY KEY CHECK (id = 1),
                check_cron    TEXT,
                alert_config  TEXT,                        -- json {webhook_url,line_token,line_to,quiet_start,quiet_end}
                threshold_pct REAL    DEFAULT 90,
                updated_at    TEXT
            );
            CREATE TABLE IF NOT EXISTS sso_clients (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id     TEXT    UNIQUE NOT NULL,
                client_secret TEXT    NOT NULL,
                name          TEXT    NOT NULL,
                redirect_uris TEXT    NOT NULL DEFAULT '',   -- คั่นด้วยขึ้นบรรทัด/ช่องว่าง
                enabled       INTEGER DEFAULT 1,
                created_at    TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sso_codes (
                code        TEXT    PRIMARY KEY,
                client_id   TEXT    NOT NULL,
                redirect_uri TEXT   NOT NULL,
                sub         TEXT    NOT NULL,
                email       TEXT,
                name        TEXT,
                role        TEXT,
                expires_at  TEXT    NOT NULL,
                used        INTEGER DEFAULT 0,
                created_at  TEXT    NOT NULL
            );
            -- v1.9.218 — Credit Card reconciliation (จับคู่รายการบัตรเครดิต กับ invoice/receipt)
            CREATE TABLE IF NOT EXISTS cc_bills (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                card_number   TEXT,                  -- เลขบัตร (mask/last4 จาก OCR)
                bill_month    INTEGER,               -- 1..12
                bill_year     INTEGER,               -- ค.ศ.
                note          TEXT,
                created_by_id INTEGER,
                created_by    TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT
            );
            CREATE TABLE IF NOT EXISTS cc_statement_pages (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                bill_id     INTEGER NOT NULL REFERENCES cc_bills(id) ON DELETE CASCADE,
                page_order  INTEGER DEFAULT 0,
                image_data  TEXT,                    -- base64 data URL
                ocr_text    TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cc_pages_bill ON cc_statement_pages(bill_id, page_order);
            CREATE TABLE IF NOT EXISTS cc_transactions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                bill_id     INTEGER NOT NULL REFERENCES cc_bills(id) ON DELETE CASCADE,
                txn_date    TEXT,                    -- ISO หรือข้อความตามสลิป
                description TEXT,
                amount      REAL,
                row_order   INTEGER DEFAULT 0,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cc_txn_bill ON cc_transactions(bill_id, row_order);
            CREATE TABLE IF NOT EXISTS cc_invoices (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                bill_id       INTEGER REFERENCES cc_bills(id) ON DELETE CASCADE,  -- nullable: invoice ลอยได้ (ยังไม่ผูกบิล)
                company       TEXT,                  -- บริษัท/platform จาก OCR
                kind          TEXT DEFAULT 'invoice',-- 'invoice' | 'receipt'
                inv_month     INTEGER,
                inv_year      INTEGER,
                amount        REAL,
                file_data     TEXT,                  -- base64 (PDF/รูป)
                file_name     TEXT,
                file_mime     TEXT,
                ocr_text      TEXT,
                description   TEXT,                  -- รายละเอียดเอกสาร (user กรอก)
                uploaded_by_id INTEGER,
                uploaded_by   TEXT,
                created_at    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cc_inv_bill ON cc_invoices(bill_id);
            CREATE TABLE IF NOT EXISTS cc_matches (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                bill_id        INTEGER NOT NULL REFERENCES cc_bills(id) ON DELETE CASCADE,
                transaction_id INTEGER NOT NULL REFERENCES cc_transactions(id) ON DELETE CASCADE,
                invoice_id     INTEGER NOT NULL REFERENCES cc_invoices(id) ON DELETE CASCADE,
                created_by     TEXT,
                created_at     TEXT NOT NULL,
                UNIQUE(transaction_id, invoice_id)
            );
            CREATE INDEX IF NOT EXISTS idx_cc_match_bill ON cc_matches(bill_id);
            """
        )
        conn.execute(
            "INSERT OR IGNORE INTO claude_ratelimit_settings(id, check_cron, alert_config, threshold_pct, updated_at) "
            "VALUES (1, '0 * * * *', '{}', 90, ?)",
            (utc_now().isoformat(),),
        )

        # v1.9.219/222 — migrate cc_invoices.bill_id → nullable (invoice ลอยได้)
        # ใช้ create-temp → copy → drop → rename-temp (กัน SQLite rewrite FK ของ cc_matches ตอน rename)
        _cci = conn.execute("PRAGMA table_info(cc_invoices)").fetchall()
        _billcol = next((c for c in _cci if c["name"] == "bill_id"), None)
        if _billcol is not None and _billcol["notnull"] == 1:
            conn.executescript(
                """
                DROP TABLE IF EXISTS cc_invoices_new;
                CREATE TABLE cc_invoices_new (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    bill_id       INTEGER REFERENCES cc_bills(id) ON DELETE CASCADE,
                    company       TEXT,
                    kind          TEXT DEFAULT 'invoice',
                    inv_month     INTEGER,
                    inv_year      INTEGER,
                    amount        REAL,
                    file_data     TEXT,
                    file_name     TEXT,
                    file_mime     TEXT,
                    ocr_text      TEXT,
                    uploaded_by_id INTEGER,
                    uploaded_by   TEXT,
                    created_at    TEXT NOT NULL
                );
                INSERT INTO cc_invoices_new
                    SELECT id,bill_id,company,kind,inv_month,inv_year,amount,file_data,file_name,file_mime,ocr_text,uploaded_by_id,uploaded_by,created_at FROM cc_invoices;
                DROP TABLE cc_invoices;
                ALTER TABLE cc_invoices_new RENAME TO cc_invoices;
                CREATE INDEX IF NOT EXISTS idx_cc_inv_bill ON cc_invoices(bill_id);
                """
            )
        conn.execute("DROP TABLE IF EXISTS cc_invoices_old")   # cleanup เผื่อ migration เก่าค้าง
        # v1.9.222 — repair: migration เดิม (rename) ทำให้ FK ของ cc_matches ชี้ไป cc_invoices_old → รื้อใหม่ให้ถูก
        _mrow = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='cc_matches'").fetchone()
        if _mrow and _mrow["sql"] and "cc_invoices_old" in _mrow["sql"]:
            conn.executescript(
                """
                DROP TABLE IF EXISTS cc_matches_new;
                CREATE TABLE cc_matches_new (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    bill_id        INTEGER NOT NULL REFERENCES cc_bills(id) ON DELETE CASCADE,
                    transaction_id INTEGER NOT NULL REFERENCES cc_transactions(id) ON DELETE CASCADE,
                    invoice_id     INTEGER NOT NULL REFERENCES cc_invoices(id) ON DELETE CASCADE,
                    created_by     TEXT,
                    created_at     TEXT NOT NULL,
                    UNIQUE(transaction_id, invoice_id)
                );
                INSERT INTO cc_matches_new
                    SELECT id,bill_id,transaction_id,invoice_id,created_by,created_at FROM cc_matches;
                DROP TABLE cc_matches;
                ALTER TABLE cc_matches_new RENAME TO cc_matches;
                CREATE INDEX IF NOT EXISTS idx_cc_match_bill ON cc_matches(bill_id);
                """
            )
        # v1.9.224 — cc_invoices: เพิ่ม description (รายละเอียดเอกสาร)
        _cic = [r["name"] for r in conn.execute("PRAGMA table_info(cc_invoices)").fetchall()]
        if "description" not in _cic:
            conn.execute("ALTER TABLE cc_invoices ADD COLUMN description TEXT")
        # v1.9.306 — cc_invoices: เลข Job / ชื่อสินค้า / AM ที่ดูแล / หมายเหตุ
        # v1.9.309 — expense_category: หมวดค่าใช้จ่าย (credit_card / paid_self / unspecified / other)
        for _c in ("job_number", "product_name", "am_name", "note", "expense_category"):
            if _c not in _cic:
                conn.execute(f"ALTER TABLE cc_invoices ADD COLUMN {_c} TEXT")
        # v1.9.391 — inv_day: วันที่บนใบเสร็จ (1-31) สำหรับปักปฏิทินตามวันจริง
        if "inv_day" not in _cic:
            conn.execute("ALTER TABLE cc_invoices ADD COLUMN inv_day INTEGER")
        # v1.9.314 — cc_transactions: เพิ่ม user_note (รายละเอียดที่ user กรอกใต้รายการ)
        _cct = [r["name"] for r in conn.execute("PRAGMA table_info(cc_transactions)").fetchall()]
        if "user_note" not in _cct:
            conn.execute("ALTER TABLE cc_transactions ADD COLUMN user_note TEXT")
        # v1.9.343 — cc_bills: วันกำหนดชำระ (ISO YYYY-MM-DD)
        # v1.9.344 — is_completed: ทำเครื่องหมายเสร็จสิ้น (ปิดการเตือนเลยกำหนด)
        _ccb = [r["name"] for r in conn.execute("PRAGMA table_info(cc_bills)").fetchall()]
        if "due_date" not in _ccb:
            conn.execute("ALTER TABLE cc_bills ADD COLUMN due_date TEXT")
        if "is_completed" not in _ccb:
            conn.execute("ALTER TABLE cc_bills ADD COLUMN is_completed INTEGER NOT NULL DEFAULT 0")
        if "completed_at" not in _ccb:
            conn.execute("ALTER TABLE cc_bills ADD COLUMN completed_at TEXT")

        # ---- 4. seed config defaults
        for key, value in DEFAULT_CONFIG.items():
            conn.execute(
                "INSERT OR IGNORE INTO config(key, value) VALUES (?, ?)",
                (key, value),
            )

        # ---- 4.5 v1.9.135 — seed default skill categories (insert-or-ignore)
        _now = utc_now().isoformat()
        for i, (k, ic, lb) in enumerate([
            ("development", "💻", "Development"),
            ("devops", "🚀", "DevOps & Infrastructure"),
            ("security", "🔒", "Security"),
            ("design", "🎨", "Design & Creative"),
            ("documents", "📄", "Documents"),
            ("communication", "💬", "Communication"),
            ("marketing", "📣", "Marketing"),
            ("integration", "🔌", "Integration"),
            ("other", "📦", "Other"),
        ]):
            conn.execute(
                "INSERT OR IGNORE INTO skill_categories(key, icon, label, sort_order, created_at) VALUES (?,?,?,?,?)",
                (k, ic, lb, i, _now),
            )

        # v1.9.162 — seed IAM module config (platform=ทุกคน, customer/ads=restricted ตามเดิม)
        # v1.9.339 — hw-* (Device & Software submenus) = restricted (admin เท่านั้น จนกว่าจะ grant)
        for _mk, _mode in [("platform", "all"), ("customer", "restricted"), ("ads", "restricted"), ("tv", "restricted"),
                           ("hw-dashboard", "restricted"), ("hw-pc", "restricted"), ("hw-central", "restricted"),
                           ("hw-device", "restricted"), ("hw-network", "restricted"), ("hw-report", "restricted"),
                           ("hw-findoc", "restricted")]:
            conn.execute(
                "INSERT OR IGNORE INTO iam_module_config(module_key, mode, updated_at) VALUES (?,?,?)",
                (_mk, _mode, _now),
            )

        # ---- emergency reset (ถ้า user ตั้ง env เอง)
        if ADMIN_RESET_ON_BOOT:
            n = conn.execute("DELETE FROM admin_users").rowcount
            print(f"⚠️  ADMIN_RESET_ON_BOOT=1 — wiped {n} admin user(s). "
                  f"Visit /login to set up again. "
                  f"REMOVE the env var after setup!")

        # ---- 5. seed default sites (ครั้งแรกเท่านั้น)
        # ทั้ง 2 site นี้ extension จะ scrape balance อัตโนมัติ — Freepik ใช้ "credits",
        # Magnific ใช้ "tokens" แต่ logic การ scrape เหมือนกัน
        for site_name, pattern in [
            ("Freepik", "*.freepik.com/*"),
            ("Magnific", "*.magnific.com/*"),
            ("Magnific (.ai)", "*.magnific.ai/*"),
        ]:
            existing = conn.execute(
                "SELECT 1 FROM sites WHERE url_pattern = ?", (pattern,)
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT INTO sites(name, url_pattern, created_at) VALUES (?, ?, ?)",
                    (site_name, pattern, utc_now().isoformat()),
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


# v1.9.339 — ผ่านถ้าเป็น admin หรือ member ที่ได้รับ IAM module ใดโมดูลหนึ่งใน list
# (ใช้เปิด endpoint ที่เดิม require_admin ให้ member ที่ถูก grant ผ่าน IAM เข้าได้)
_HW_MODULE_KEYS = ("hw-dashboard", "hw-pc", "hw-central", "hw-device",
                   "hw-network", "hw-report", "hw-findoc")


def require_admin_or_modules(*module_keys: str):
    def _dep(fct_session: Optional[str] = Cookie(default=None),
             fct_member_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
        sess = get_session(fct_session)
        if sess:
            return {**sess, "role": "admin", "is_super": True}
        msess = get_member_session(fct_member_session)
        if not msess:
            raise HTTPException(status_code=401, detail="ไม่ได้เข้าสู่ระบบ")
        mid = msess["member_id"]
        with db_conn() as conn:
            row = conn.execute("SELECT is_admin FROM members WHERE id = ?", (mid,)).fetchone()
            is_admin = bool(row["is_admin"]) if row else False
            mods = _member_accessible_modules(conn, mid, is_admin)
        if is_admin or any(k in mods for k in module_keys):
            return {**msess, "role": "admin" if is_admin else "member", "is_super": False}
        raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์เข้าถึงเมนูนี้")
    return _dep


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


# v1.9.114 — Login page appearance (background image + tagline) — เก็บใน config
class LoginAppearanceIn(BaseModel):
    bg_image: Optional[str] = Field(None, max_length=6_000_000)  # base64 data URL หรือ '' เพื่อลบ
    tagline: Optional[str] = Field(None, max_length=300)


@app.get("/api/login-appearance")
def get_login_appearance() -> dict[str, Any]:
    """Public — login page อ่าน background + tagline (ไม่ต้อง auth เพราะใช้ก่อน login)"""
    cfg = get_config()
    return {
        "bg_image": cfg.get("login_bg_image") or None,
        "tagline": cfg.get("login_tagline") or None,
    }


@app.post("/api/admin/login-appearance")
def set_login_appearance(
    payload: LoginAppearanceIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """admin — ตั้งค่า background image + tagline ของหน้า login"""
    updates: dict[str, str] = {}
    if payload.bg_image is not None:
        bg = payload.bg_image.strip()
        if bg and not bg.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="bg_image ต้องเป็น data URL (data:image/...)")
        updates["login_bg_image"] = bg  # '' = ลบ
    if payload.tagline is not None:
        updates["login_tagline"] = payload.tagline.strip()
    if updates:
        set_config(updates)
    cfg = get_config()
    return {"ok": True, "bg_image": cfg.get("login_bg_image") or None, "tagline": cfg.get("login_tagline") or None}


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
    """ลอง admin ก่อน ถ้าไม่ผ่าน ค่อยลอง member (treat username เป็น email)
    v1.9.111 — error message แยกตามสาเหตุ: ไม่พบบัญชี / รหัสผิด / ยังไม่ตั้งรหัส / ถูกระงับ"""
    username = payload.username.strip()
    # 1) ลอง admin
    with db_conn() as conn:
        admin_row = conn.execute(
            "SELECT id, username, pw_hash, pw_salt FROM admin_users WHERE username = ?",
            (username,),
        ).fetchone()
    admin_found = bool(admin_row)
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

    # 2) ลอง member (username = email) — เผื่อ alias (บัญชีที่ถูก merge)
    email = username.lower()
    with db_conn() as conn:
        m_row = conn.execute(
            "SELECT id, phone, email, pw_hash, pw_salt, enabled FROM members WHERE LOWER(email) = ?",
            (email,),
        ).fetchone()
        if not m_row:
            m_row = conn.execute(
                "SELECT m.id, m.phone, m.email, m.pw_hash, m.pw_salt, m.enabled "
                "FROM member_aliases a JOIN members m ON m.id = a.member_id "
                "WHERE a.kind = 'email' AND a.value = ?",
                (email,),
            ).fetchone()

    # ไม่พบทั้ง admin และ member
    if not m_row:
        if admin_found:
            # username เป็น admin แต่รหัสผ่านผิด
            raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง")
        raise HTTPException(status_code=401, detail="ไม่พบบัญชีนี้ในระบบ — ตรวจสอบ username/อีเมลอีกครั้ง")

    # พบ member
    if _is_member_disabled(m_row):
        raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน — ติดต่อผู้ดูแลระบบ")
    if not m_row["pw_hash"]:
        raise HTTPException(
            status_code=401,
            detail="บัญชีนี้ยังไม่ได้ตั้งรหัสผ่าน — เข้าด้วยเบอร์โทร (OTP) หรือ Wazzup ก่อน แล้วไปตั้งรหัสผ่านในหน้าบัญชีของฉัน",
        )
    if not verify_password(payload.password, m_row["pw_hash"], m_row["pw_salt"]):
        raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง")

    # สำเร็จ
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
    # v1.9.58 — null/omitted = root team
    parent_team_id: Optional[int] = None


class TeamPatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)
    # v1.9.58 — parent_team_id: null = ตั้งเป็น root, omitted = no change, int = ผูกกับ team นั้น
    parent_team_id: Optional[int] = None


# v1.9.58 — helper สำหรับตรวจ cycle ใน hierarchy
def _team_would_create_cycle(conn: sqlite3.Connection, team_id: int, new_parent_id: Optional[int]) -> bool:
    """ตั้ง team_id.parent = new_parent_id จะสร้าง cycle หรือเปล่า?
    เดินขึ้นจาก new_parent_id ตามสาย parent — ถ้าเจอ team_id แสดงว่า cycle"""
    if new_parent_id is None:
        return False
    if new_parent_id == team_id:
        return True   # self-parent
    cur = new_parent_id
    visited: set[int] = set()
    while cur is not None and cur not in visited:
        if cur == team_id:
            return True
        visited.add(cur)
        row = conn.execute(
            "SELECT parent_team_id FROM teams WHERE id = ?", (cur,)
        ).fetchone()
        if not row:
            return False
        cur = row["parent_team_id"]
    return False


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
def admin_list_teams(_sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT t.id, t.name, t.description, t.created_at, t.display_order, "
            "  t.parent_team_id, "
            "  (SELECT COUNT(*) FROM team_members tm JOIN members m ON m.id = tm.member_id WHERE tm.team_id = t.id AND m.is_alumni = 0) AS member_count, "
            "  (SELECT COUNT(*) FROM team_sites   WHERE team_id = t.id) AS site_count "
            "FROM teams t ORDER BY t.display_order ASC, t.name COLLATE NOCASE ASC"
        ).fetchall()
    return {"teams": [dict(r) for r in rows]}


class TeamReorderIn(BaseModel):
    team_ids: list[int]


@app.put("/api/admin/teams/reorder")
def admin_reorder_teams(
    payload: TeamReorderIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """Reorder teams — รับ list ของ team_ids ตามลำดับใหม่
    UPDATE display_order ของแต่ละ row ตาม index ใน array
    """
    with db_conn() as conn:
        # Validate: all team_ids ต้องมีจริง
        if payload.team_ids:
            placeholders = ",".join("?" * len(payload.team_ids))
            existing = {r["id"] for r in conn.execute(
                f"SELECT id FROM teams WHERE id IN ({placeholders})",
                tuple(payload.team_ids),
            ).fetchall()}
            missing = set(payload.team_ids) - existing
            if missing:
                raise HTTPException(status_code=400, detail=f"team not found: {sorted(missing)}")
        # Update each team's display_order ตาม index
        for idx, tid in enumerate(payload.team_ids):
            conn.execute(
                "UPDATE teams SET display_order = ? WHERE id = ?",
                (idx, tid),
            )
    return {"ok": True, "count": len(payload.team_ids)}


@app.post("/api/admin/teams")
def admin_create_team(payload: TeamIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        # v1.9.58 — validate parent_team_id (ถ้าระบุ → ต้องมีอยู่จริง)
        if payload.parent_team_id is not None:
            row = conn.execute(
                "SELECT id FROM teams WHERE id = ?", (payload.parent_team_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=400, detail="parent team ไม่มีอยู่จริง")
        try:
            cur = conn.execute(
                "INSERT INTO teams(name, description, created_at, parent_team_id) "
                "VALUES (?, ?, ?, ?)",
                (
                    payload.name.strip(),
                    payload.description,
                    utc_now().isoformat(),
                    payload.parent_team_id,
                ),
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
        # v1.9.59 — รวมสมาชิกจาก subtree (current team + ทุก descendant)
        # คลิกทีมแม่ → เห็นสมาชิกทุกคนของทีมย่อยลงไปด้วย
        subtree_id_rows = conn.execute(
            """
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM teams WHERE id = ?
                UNION ALL
                SELECT t.id FROM teams t INNER JOIN subtree s ON t.parent_team_id = s.id
            )
            SELECT id FROM subtree
            """,
            (team_id,),
        ).fetchall()
        subtree_ids = [r["id"] for r in subtree_id_rows]
        if subtree_ids:
            pl_sub = ",".join("?" * len(subtree_ids))
            member_rows = conn.execute(
                f"SELECT m.id, m.phone, m.email, m.display_name, m.enabled, m.avatar_data, "
                f"  m.is_alumni, m.last_working_day, m.uses_own_computer, m.own_computer_info, "
                f"  m.replaces_member_id, "
                f"  rm.display_name AS replaces_display_name, rm.email AS replaces_email, "
                f"  rm.avatar_data AS replaces_avatar, rm.last_working_day AS replaces_last_working_day, "
                f"  tm.team_id AS source_team_id, tm.added_at "
                f"FROM team_members tm JOIN members m ON m.id = tm.member_id "
                f"LEFT JOIN members rm ON rm.id = m.replaces_member_id "
                f"WHERE tm.team_id IN ({pl_sub}) "
                f"ORDER BY tm.added_at DESC",
                subtree_ids,
            ).fetchall()
            subtree_team_name_rows = conn.execute(
                f"SELECT id, name FROM teams WHERE id IN ({pl_sub})",
                subtree_ids,
            ).fetchall()
            subtree_team_names = {r["id"]: r["name"] for r in subtree_team_name_rows}
        else:
            member_rows = []
            subtree_team_names = {}

        # dedup โดย member.id — เก็บ row แรก (ใหม่สุด) + ทำ flag direct + รายชื่อ sub_team_names
        members = []
        members_index: dict[int, dict[str, Any]] = {}
        for r in member_rows:
            mid = r["id"]
            if mid not in members_index:
                d = {
                    "id": r["id"],
                    "phone": r["phone"],
                    "email": r["email"],
                    "display_name": r["display_name"],
                    "enabled": r["enabled"],
                    "avatar_data": r["avatar_data"],
                    "added_at": r["added_at"],
                    "is_alumni": bool(r["is_alumni"]),
                    "last_working_day": r["last_working_day"],
                    "uses_own_computer": bool(r["uses_own_computer"]),
                    "own_computer_info": r["own_computer_info"],
                    "replaces_member_id": r["replaces_member_id"],
                    "replaces_member_label": r["replaces_display_name"] or r["replaces_email"] or None,
                    "replaces_member_avatar": r["replaces_avatar"],
                    "replaces_last_working_day": r["replaces_last_working_day"],
                    "direct": False,
                    "sub_team_names": [],
                }
                members_index[mid] = d
                members.append(d)
            rec = members_index[mid]
            if r["source_team_id"] == team_id:
                rec["direct"] = True
            else:
                tname = subtree_team_names.get(r["source_team_id"])
                if tname and tname not in rec["sub_team_names"]:
                    rec["sub_team_names"].append(tname)
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

        # === v1.9.54 — หา teams ทั้งหมดของแต่ละ member (เพื่อโชว์ chip บอกว่าเขาอยู่ทีมไหนบ้าง) ===
        member_ids = [m["id"] for m in members_data]
        if member_ids:
            placeholders = ",".join("?" * len(member_ids))
            tm_rows = conn.execute(
                f"SELECT tm.member_id, t.id AS team_id, t.name AS team_name "
                f"FROM team_members tm JOIN teams t ON t.id = tm.team_id "
                f"WHERE tm.member_id IN ({placeholders}) "
                f"ORDER BY t.name COLLATE NOCASE",
                member_ids,
            ).fetchall()
            teams_by_member: dict[int, list[dict[str, Any]]] = {}
            for r in tm_rows:
                teams_by_member.setdefault(r["member_id"], []).append(
                    {"id": r["team_id"], "name": r["team_name"]}
                )
            for mem in members_data:
                mem["teams"] = teams_by_member.get(mem["id"], [])
        else:
            for mem in members_data:
                mem["teams"] = []

        # === v1.9.55 — แนบ PC spec ย่อ + วันที่ซื้อ ของแต่ละ member (ใช้ในหน้า team detail) ===
        # v1.9.57 — เพิ่ม photo_data เพื่อให้คลิกเปิดดูรูปได้
        # v1.9.62 — SELECT * เพื่อให้ frontend เปิด detail modal + edit ได้ครบ field
        if member_ids:
            pl = ",".join("?" * len(member_ids))
            pc_rows = conn.execute(
                f"SELECT * FROM hardware "
                f"WHERE hw_type = 'pc' AND current_member_id IN ({pl}) "
                f"ORDER BY current_member_id, name COLLATE NOCASE",
                member_ids,
            ).fetchall()
            pcs_by_member: dict[int, list[dict[str, Any]]] = {}
            for r in pc_rows:
                pcs_by_member.setdefault(r["current_member_id"], []).append(dict(r))
            for mem in members_data:
                mem["pcs"] = pcs_by_member.get(mem["id"], [])
        else:
            for mem in members_data:
                mem["pcs"] = []

    # v1.9.58 — แนบ parent (breadcrumb path ขึ้นไป root) + sub_teams (ลูกตรง)
    team_dict = dict(team)
    parent_path: list[dict[str, Any]] = []
    with db_conn() as conn:
        cur_pid = team_dict.get("parent_team_id")
        seen: set[int] = set()
        while cur_pid is not None and cur_pid not in seen:
            seen.add(cur_pid)
            prow = conn.execute(
                "SELECT id, name, parent_team_id FROM teams WHERE id = ?", (cur_pid,)
            ).fetchone()
            if not prow:
                break
            parent_path.insert(0, {"id": prow["id"], "name": prow["name"]})
            cur_pid = prow["parent_team_id"]
        sub_rows = conn.execute(
            "SELECT id, name, "
            "  (SELECT COUNT(*) FROM team_members tm JOIN members m ON m.id = tm.member_id WHERE tm.team_id = teams.id AND m.is_alumni = 0) AS member_count, "
            "  (SELECT COUNT(*) FROM team_sites   WHERE team_id = teams.id) AS site_count "
            "FROM teams WHERE parent_team_id = ? "
            "ORDER BY display_order ASC, name COLLATE NOCASE ASC",
            (team_id,),
        ).fetchall()
    # v1.9.67 — unassigned PCs (คอมส่วนกลางที่ยังไม่ผูก owner) ใน subtree นี้
    with db_conn() as conn:
        if subtree_ids:
            pl2 = ",".join("?" * len(subtree_ids))
            up_rows = conn.execute(
                f"SELECT h.*, t.name AS unassigned_team_name "
                f"FROM hardware h "
                f"LEFT JOIN teams t ON t.id = h.unassigned_team_id "
                f"WHERE h.hw_type = 'pc' AND h.current_member_id IS NULL "
                f"  AND h.unassigned_team_id IN ({pl2}) "
                f"ORDER BY h.name COLLATE NOCASE",
                subtree_ids,
            ).fetchall()
            unassigned_pcs = [dict(r) for r in up_rows]
        else:
            unassigned_pcs = []
    return {
        "team": team_dict,
        "parent_path": parent_path,
        "sub_teams": [dict(r) for r in sub_rows],
        "members": members_data,
        "unassigned_pcs": unassigned_pcs,
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
    raw = payload.model_dump(exclude_unset=True)
    updates: dict[str, Any] = {}
    if "name" in raw and raw["name"] is not None:
        updates["name"] = raw["name"].strip()
    if "description" in raw:
        updates["description"] = raw["description"]
    # v1.9.58 — parent_team_id: null = clear (root), int = ผูกกับ team นั้น
    with db_conn() as conn:
        if "parent_team_id" in raw:
            new_parent = raw["parent_team_id"]
            if new_parent is not None:
                row = conn.execute(
                    "SELECT id FROM teams WHERE id = ?", (new_parent,)
                ).fetchone()
                if not row:
                    raise HTTPException(status_code=400, detail="parent team ไม่มีอยู่จริง")
                if _team_would_create_cycle(conn, team_id, new_parent):
                    raise HTTPException(
                        status_code=400,
                        detail="ตั้ง parent นี้จะทำให้เกิด loop (ทีมนี้เป็น ancestor ของ parent ที่เลือกอยู่)",
                    )
            updates["parent_team_id"] = new_parent
        if not updates:
            raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [team_id]
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
def admin_list_members(_sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, phone, email, display_name, enabled, is_admin, avatar_data, "
            "       extension_version, extension_last_used_at, firebase_uid, "
            "       (pw_hash IS NOT NULL) AS has_password, "
            "       wazzup_emp_code, is_temp, temp_department, is_alumni, last_working_day, "
            "       (wazzup_profile_url IS NOT NULL AND wazzup_profile_url != '') AS has_wazzup_photo, "
            "       created_at, last_login_at "
            "FROM members ORDER BY created_at DESC"
        ).fetchall()
        # ดึง team membership ของทุก member ในคำขอเดียว → group ใน Python
        tm_rows = conn.execute(
            "SELECT tm.member_id, t.id AS team_id, t.name AS team_name "
            "FROM team_members tm JOIN teams t ON t.id = tm.team_id "
            "ORDER BY t.name"
        ).fetchall()
        # v1.9.86 — aliases per member สำหรับ login_methods detection
        # v1.9.87 — รวม value ด้วยเพื่อแสดง label
        alias_rows = conn.execute(
            "SELECT member_id, kind, value FROM member_aliases"
        ).fetchall()
    teams_by_member: dict[int, list[dict[str, Any]]] = {}
    for r in tm_rows:
        teams_by_member.setdefault(r["member_id"], []).append(
            {"id": r["team_id"], "name": r["team_name"]}
        )
    aliases_by_member: dict[int, list[dict[str, str]]] = {}
    for ar in alias_rows:
        aliases_by_member.setdefault(ar["member_id"], []).append(
            {"kind": ar["kind"], "value": ar["value"]}
        )
    # v1.9.82 — strip placeholder phone (email:...) สำหรับ email-signup user
    def _phone_clean(p):
        return None if (p and (p.startswith("email:") or p.startswith("nophone:"))) else p
    # v1.9.86/87/88/98 — ใช้ shared helper _build_login_methods + _aliases_for_display
    def _login_methods(r, aliases):
        return _build_login_methods(
            firebase_uid=r["firebase_uid"],
            phone=r["phone"],
            email=r["email"],
            has_password=bool(r["has_password"]),
            aliases=aliases,
            wazzup_emp_code=r["wazzup_emp_code"] if "wazzup_emp_code" in r.keys() else None,
        )
    return {
        "members": [
            {
                "id": r["id"],
                "phone": _phone_clean(r["phone"]),
                "email": r["email"],
                "display_name": r["display_name"],
                "enabled": bool(r["enabled"]) if r["enabled"] is not None else True,
                "is_admin": bool(r["is_admin"]) if r["is_admin"] is not None else False,
                "has_password": bool(r["has_password"]),
                # v1.9.86/87 — login methods (with labels) + aliases (for display)
                "login_methods": _login_methods(r, aliases_by_member.get(r["id"], [])),
                "aliases": _aliases_for_display(aliases_by_member.get(r["id"], [])),
                "alias_count": len(aliases_by_member.get(r["id"], [])),
                "avatar_data": r["avatar_data"] if "avatar_data" in r.keys() else None,
                "has_wazzup_photo": bool(r["has_wazzup_photo"]),  # v1.9.92 — มี profileURL เก็บไว้
                "wazzup_emp_code": r["wazzup_emp_code"],  # v1.9.93 — admin pre-fill ได้ใน modal
                "extension_version": r["extension_version"] if "extension_version" in r.keys() else None,
                "extension_last_used_at": r["extension_last_used_at"] if "extension_last_used_at" in r.keys() else None,
                "created_at": r["created_at"],
                "last_login_at": r["last_login_at"],
                "is_temp": bool(r["is_temp"]) if "is_temp" in r.keys() else False,
                "temp_department": r["temp_department"] if "temp_department" in r.keys() else None,
                "is_alumni": bool(r["is_alumni"]) if "is_alumni" in r.keys() else False,
                "last_working_day": r["last_working_day"] if "last_working_day" in r.keys() else None,
                "teams": teams_by_member.get(r["id"], []),
            }
            for r in rows
        ]
    }


def _normalize_th_phone(raw: str) -> str:
    """แปลงเบอร์ไทยเป็น E.164 (+66...) ให้ตรงกับที่ Firebase OTP เก็บ — ตรงกับ normalizePhone ฝั่ง login"""
    p = re.sub(r"\D", "", raw or "")
    if not p:
        return ""
    if p.startswith("0"):
        p = p[1:]
    elif p.startswith("66") and len(p) >= 11:
        p = p[2:]
    return "+66" + p


class TempStaffIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    # v1.9.263 — เบอร์ optional: ถ้าใส่ → ใช้ merge ตอน login OTP / ถ้าไม่ใส่ → placeholder
    phone: Optional[str] = Field(None, max_length=30)
    department: Optional[str] = Field(None, max_length=120)


@app.post("/api/admin/temp-staff")
def admin_create_temp_staff(payload: TempStaffIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    """v1.9.229 — สร้างพนักงานชั่วคราว (ชื่อ + เบอร์ optional) เป็น member row (firebase_uid placeholder, is_temp=1)
    เมื่อเจ้าของเบอร์ login OTP จริง → re-link by phone จะเซ็ต firebase_uid + is_temp=0 ให้ row เดิม
    (= account จริง โดย id ไม่เปลี่ยน → อุปกรณ์/ทีมที่ผูกไว้ติดไปอัตโนมัติ)
    ไม่ใส่เบอร์ก็ได้ แต่จะ merge อัตโนมัติไม่ได้ (phone เป็น NOT NULL UNIQUE → ใส่ placeholder)"""
    raw_phone = (payload.phone or "").strip()
    now = utc_now().isoformat()
    with db_conn() as conn:
        if raw_phone:
            phone = _normalize_th_phone(raw_phone)
            if len(re.sub(r"\D", "", phone)) < 11:
                raise HTTPException(status_code=400, detail="เบอร์โทรไม่ถูกต้อง (ต้องเป็นเบอร์มือถือไทย)")
            ex = conn.execute("SELECT id, is_temp, display_name FROM members WHERE phone = ?", (phone,)).fetchone()
            if ex:
                kind = "พนักงานชั่วคราว" if ex["is_temp"] else "ผู้ใช้จริง"
                raise HTTPException(status_code=409, detail=f"เบอร์นี้มีอยู่แล้ว ({kind}: {ex['display_name'] or phone})")
        else:
            # ไม่มีเบอร์ → placeholder ที่ไม่ตรงกับ OTP ใด ๆ (กัน NOT NULL UNIQUE)
            phone = "nophone:" + secrets.token_hex(8)
        fake_uid = "temp:" + secrets.token_hex(12)
        cur = conn.execute(
            "INSERT INTO members(phone, firebase_uid, display_name, is_temp, temp_department, created_at) "
            "VALUES (?, ?, ?, 1, ?, ?)",
            (phone, fake_uid, payload.name.strip(), (payload.department or "").strip() or None, now))
        mid = cur.lastrowid
    return {"ok": True, "id": mid, "phone": (phone if raw_phone else None)}


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


# v1.9.125 — Supervise: ทีมที่ member นี้ดูแล/ดูข้อมูลได้ (ไม่ใช่สมาชิกทีม)
@app.get("/api/admin/members/{member_id}/supervised-teams")
def admin_get_supervised_teams(member_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (member_id,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        rows = conn.execute(
            "SELECT team_id FROM member_supervised_teams WHERE member_id = ?", (member_id,)
        ).fetchall()
    return {"team_ids": [r["team_id"] for r in rows]}


@app.put("/api/admin/members/{member_id}/supervised-teams")
def admin_set_supervised_teams(
    member_id: int,
    payload: MemberTeamsPatch,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ตั้งทีมที่ member นี้ supervise (replace all)"""
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (member_id,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        current = {r["team_id"] for r in conn.execute(
            "SELECT team_id FROM member_supervised_teams WHERE member_id = ?", (member_id,)
        ).fetchall()}
        target = set(int(t) for t in payload.team_ids)
        if target:
            valid = {r["id"] for r in conn.execute(
                f"SELECT id FROM teams WHERE id IN ({','.join('?' * len(target))})",
                tuple(target),
            ).fetchall()}
            if valid != target:
                raise HTTPException(status_code=400, detail=f"team not found: {sorted(target - valid)}")
        to_add = target - current
        to_remove = current - target
        now = utc_now().isoformat()
        for team_id in to_add:
            conn.execute(
                "INSERT OR IGNORE INTO member_supervised_teams(member_id, team_id, created_at) VALUES (?, ?, ?)",
                (member_id, team_id, now),
            )
        for team_id in to_remove:
            conn.execute(
                "DELETE FROM member_supervised_teams WHERE member_id = ? AND team_id = ?",
                (member_id, team_id),
            )
    return {"ok": True, "added": len(to_add), "removed": len(to_remove), "team_ids": sorted(target)}


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
    """ลบ member ทั้งคน (sessions + record + aliases)"""
    _invalidate_member_sessions(member_id)
    with db_conn() as conn:
        # v1.9.113 — เคลียร์ aliases ก่อน (db_conn ไม่เปิด FK → CASCADE ไม่ทำงานเอง)
        conn.execute("DELETE FROM member_aliases WHERE member_id = ?", (member_id,))
        cur = conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="ไม่พบ member")
    return {"ok": True}


# v1.9.84 — Merge 2 members into 1 (กรณีคน ๆ เดียวกันสมัครไว้ 2 บัญชี)
class MemberMergeIn(BaseModel):
    source_id: int   # อีกบัญชี — จะถูก merge เข้ามา + ลบทิ้ง
    # v1.9.94 — admin เลือก field ที่จะเก็บ {field_name: "primary" | "source"}
    # ถ้าไม่ส่ง → ใช้ default behavior (primary wins ถ้ามีค่า)
    field_choices: Optional[dict[str, str]] = None


def _is_placeholder_phone(v: Optional[str]) -> bool:
    return bool(v) and str(v).startswith("email:")


# v1.9.88 — shared helper สำหรับสร้าง login_methods (admin list + member self)
# v1.9.98 — wazzup_emp_code: ใช้แสดง empCode เป็น label หลัก, อีเมล์ในวงเล็บ
def _build_login_methods(*, firebase_uid, phone, email, has_password, aliases, wazzup_emp_code=None) -> list[dict[str, str]]:
    """aliases = list of dicts with 'kind' (and optional 'value' for labels)"""
    kinds = [a["kind"] for a in aliases]
    methods: list[dict[str, str]] = []
    # Phone OTP: firebase_uid จริง หรือ alias kind=firebase_uid
    if (firebase_uid and not str(firebase_uid).startswith("email:")) or "firebase_uid" in kinds:
        primary_phone = phone if (phone and not str(phone).startswith("email:")) else None
        methods.append({"kind": "phone", "label": primary_phone or "(Phone OTP)"})
    # Email + Password
    if email and has_password:
        methods.append({"kind": "email_pw", "label": email})
    # Wazzup: มี email (หรือ alias kind=email) — label = empCode (email) ถ้ามี empCode
    email_alias_vals = [a["value"] for a in aliases if a["kind"] == "email"]
    waz_email = email or (email_alias_vals[0] if email_alias_vals else None)
    if waz_email:
        if wazzup_emp_code:
            label = f"{wazzup_emp_code} ({waz_email})"
        else:
            label = waz_email
        methods.append({"kind": "wazzup", "label": label})
    return methods


def _aliases_for_display(aliases: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        {"kind": a["kind"], "value": a["value"]}
        for a in aliases if a["kind"] in ("phone", "email")
    ]


def _fetch_member_login_meta(conn: sqlite3.Connection, member_id: int) -> dict[str, Any]:
    """Query aliases + return {login_methods, aliases, alias_count} สำหรับ member นี้"""
    row = conn.execute(
        "SELECT firebase_uid, phone, email, (pw_hash IS NOT NULL) AS has_password, "
        "       wazzup_emp_code "
        "FROM members WHERE id = ?",
        (member_id,),
    ).fetchone()
    if not row:
        return {"login_methods": [], "aliases": [], "alias_count": 0}
    alias_rows = conn.execute(
        "SELECT kind, value FROM member_aliases WHERE member_id = ?", (member_id,)
    ).fetchall()
    aliases = [{"kind": a["kind"], "value": a["value"]} for a in alias_rows]
    methods = _build_login_methods(
        firebase_uid=row["firebase_uid"],
        phone=row["phone"],
        email=row["email"],
        has_password=bool(row["has_password"]),
        aliases=aliases,
        wazzup_emp_code=row["wazzup_emp_code"] if "wazzup_emp_code" in row.keys() else None,
    )
    return {
        "login_methods": methods,
        "aliases": _aliases_for_display(aliases),
        "alias_count": len(aliases),
    }


# v1.9.94 — preview diff ก่อน merge → admin เห็นความต่าง + เลือก field ที่จะเก็บ
@app.get("/api/admin/members/{primary_id}/merge-preview")
def admin_merge_preview(
    primary_id: int,
    source_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    if primary_id == source_id:
        raise HTTPException(status_code=400, detail="primary และ source เป็นคนเดียวกัน")
    with db_conn() as conn:
        prim = conn.execute("SELECT * FROM members WHERE id = ?", (primary_id,)).fetchone()
        src  = conn.execute("SELECT * FROM members WHERE id = ?", (source_id,)).fetchone()
    if not prim:
        raise HTTPException(status_code=404, detail="primary member ไม่พบ")
    if not src:
        raise HTTPException(status_code=404, detail="source member ไม่พบ")
    prim_d = dict(prim)
    src_d = dict(src)
    def _clean_phone(v):
        return None if _is_placeholder_phone(v) else (v or None)
    def _clean(field, v):
        if field in ("phone", "firebase_uid"):
            return _clean_phone(v)
        return v if v else None
    # fields ที่ admin เลือกได้
    field_specs = [
        {"field": "display_name",      "label": "ชื่อแสดง",        "type": "text"},
        {"field": "email",             "label": "อีเมล",            "type": "text"},
        {"field": "phone",             "label": "เบอร์มือถือ",     "type": "text"},
        {"field": "avatar_data",       "label": "รูปประจำตัว",     "type": "image"},
        {"field": "shirt_size",        "label": "Shirt Size",       "type": "text"},
        {"field": "birthdate",         "label": "วันเกิด",          "type": "text"},
        {"field": "wazzup_profile_url","label": "Wazzup profileURL","type": "text"},
        {"field": "wazzup_emp_code",   "label": "Wazzup empCode",   "type": "text"},
    ]
    fields_out = []
    for spec in field_specs:
        f = spec["field"]
        pv = _clean(f, prim_d.get(f))
        sv = _clean(f, src_d.get(f))
        in_conflict = bool(pv) and bool(sv) and pv != sv
        default_choice = "primary" if pv else ("source" if sv else "primary")
        fields_out.append({**spec, "primary_value": pv, "source_value": sv,
                           "in_conflict": in_conflict, "default_choice": default_choice})
    # summary
    def _summary(row):
        return {
            "id": row["id"],
            "display_name": row.get("display_name"),
            "email": row.get("email"),
            "phone": _clean_phone(row.get("phone")),
            "avatar_data": row.get("avatar_data"),
            "is_admin": bool(row.get("is_admin")),
            "enabled": bool(row.get("enabled")) if row.get("enabled") is not None else True,
            "has_password": bool(row.get("pw_hash")),
            "created_at": row.get("created_at"),
            "last_login_at": row.get("last_login_at"),
        }
    return {
        "primary": _summary(prim_d),
        "source":  _summary(src_d),
        "fields": fields_out,
    }


@app.post("/api/admin/members/{primary_id}/merge")
def admin_merge_members(
    primary_id: int,
    payload: MemberMergeIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """รวม 2 บัญชีเข้าด้วยกัน:
    - ย้าย FK relations (teams, credentials, hardware, history, requests, logs) จาก source → primary
    - fill missing fields ของ primary ด้วยค่าจาก source (primary wins ถ้ามีอยู่ + ไม่ใช่ placeholder)
    - ลบ source member"""
    source_id = payload.source_id
    if primary_id == source_id:
        raise HTTPException(status_code=400, detail="primary และ source เป็นคนเดียวกัน — ผสานไม่ได้")
    with db_conn() as conn:
        prim = conn.execute("SELECT * FROM members WHERE id = ?", (primary_id,)).fetchone()
        src  = conn.execute("SELECT * FROM members WHERE id = ?", (source_id,)).fetchone()
        if not prim:
            raise HTTPException(status_code=404, detail="primary member ไม่พบ")
        if not src:
            raise HTTPException(status_code=404, detail="source member ไม่พบ")

        # 1) ย้าย team_members (PK = team_id+member_id — ป้องกัน duplicate ด้วย INSERT OR IGNORE)
        conn.execute(
            "INSERT OR IGNORE INTO team_members(team_id, member_id, added_at) "
            "SELECT team_id, ?, added_at FROM team_members WHERE member_id = ?",
            (primary_id, source_id),
        )
        conn.execute("DELETE FROM team_members WHERE member_id = ?", (source_id,))

        # 2) ย้าย credential_members
        conn.execute(
            "INSERT OR IGNORE INTO credential_members(credential_id, member_id, added_at) "
            "SELECT credential_id, ?, added_at FROM credential_members WHERE member_id = ?",
            (primary_id, source_id),
        )
        conn.execute("DELETE FROM credential_members WHERE member_id = ?", (source_id,))

        # 3) Update hardware references
        conn.execute(
            "UPDATE hardware SET current_member_id = ? WHERE current_member_id = ?",
            (primary_id, source_id),
        )
        conn.execute(
            "UPDATE hardware_assignments SET member_id = ? WHERE member_id = ?",
            (primary_id, source_id),
        )

        # 4) usage_logs
        conn.execute(
            "UPDATE usage_logs SET member_id = ? WHERE member_id = ?",
            (primary_id, source_id),
        )

        # 5) access_requests (uniq pending per member+site)
        conn.execute(
            "INSERT OR IGNORE INTO access_requests(member_id, site_id, requested_at, status, note, decided_at, decided_by) "
            "SELECT ?, site_id, requested_at, status, note, decided_at, decided_by FROM access_requests WHERE member_id = ?",
            (primary_id, source_id),
        )
        conn.execute("DELETE FROM access_requests WHERE member_id = ?", (source_id,))

        # 6) Build merged fields — v1.9.94: รองรับ field_choices จาก admin
        prim_d = dict(prim)
        src_d = dict(src)
        updates: dict[str, Any] = {}
        fc = payload.field_choices or {}
        def _apply_choice(field, sv_value, default_to_source: bool):
            """default_to_source: True = ถ้าไม่มี choice + primary empty → source ชนะ (existing logic)"""
            choice = fc.get(field)
            if choice == "source":
                if sv_value:
                    updates[field] = sv_value
            elif choice == "primary":
                pass  # explicit keep primary
            else:  # no choice → default behavior
                if default_to_source and sv_value:
                    updates[field] = sv_value
        # phone + firebase_uid — placeholder-aware
        for f in ("phone", "firebase_uid"):
            pv = prim_d.get(f)
            sv = src_d.get(f)
            choice = fc.get(f)
            if choice == "source":
                if sv and not _is_placeholder_phone(sv):
                    updates[f] = sv
            elif choice == "primary":
                pass
            else:
                if _is_placeholder_phone(pv) and sv and not _is_placeholder_phone(sv):
                    updates[f] = sv
                elif not pv and sv:
                    updates[f] = sv
        # อื่น ๆ — รองรับ field_choices, default = fill ถ้า primary empty
        for f in ("display_name", "email", "avatar_data", "shirt_size", "birthdate",
                  "pw_hash", "pw_salt", "extension_version", "extension_last_used_at",
                  "wazzup_profile_url", "wazzup_emp_code"):
            pv = prim_d.get(f)
            sv = src_d.get(f)
            _apply_choice(f, sv, default_to_source=(not pv))
        # is_admin: OR (true ถ้าฝั่งใดเป็น admin)
        if int(prim_d.get("is_admin") or 0) == 0 and int(src_d.get("is_admin") or 0) == 1:
            updates["is_admin"] = 1
        # enabled: OR (true ถ้าฝั่งใด enabled)
        prim_en = 1 if (prim_d.get("enabled") in (None, 1)) else 0
        src_en  = 1 if (src_d.get("enabled")  in (None, 1)) else 0
        if prim_en == 0 and src_en == 1:
            updates["enabled"] = 1
        # last_login_at: ใช้ค่ามากสุด (recent)
        pll = prim_d.get("last_login_at") or ""
        sll = src_d.get("last_login_at") or ""
        if sll > pll:
            updates["last_login_at"] = sll

        # v1.9.85 — เก็บ identity values ของ source เป็น alias → primary
        # เพื่อให้ login เดิม (phone OTP / email / Wazzup) ยังเจอ primary หลัง source ถูกลบ
        now_iso = utc_now().isoformat()
        src_origin = f"merged_from:{source_id}"
        def _maybe_alias(kind, value):
            if not value:
                return
            if isinstance(value, str) and value.startswith("email:"):
                return  # ข้าม placeholder (ไม่ใช่ค่าจริง)
            # อย่า alias ค่าที่ตรงกับของ primary อยู่แล้ว
            prim_val = prim_d.get(kind)
            if prim_val and value == prim_val:
                return
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO member_aliases(member_id, kind, value, source, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (primary_id, kind, value, src_origin, now_iso),
                )
            except Exception:
                pass
        _maybe_alias("phone",        src_d.get("phone"))
        _maybe_alias("firebase_uid", src_d.get("firebase_uid"))
        em = src_d.get("email")
        if em:
            _maybe_alias("email", em.lower())

        # 7) ลบ source ก่อน (ปลด UNIQUE constraint)
        _invalidate_member_sessions(source_id)
        # v1.9.113 — ย้าย aliases ที่เหลือของ source → primary แล้วเคลียร์ที่เหลือ (กัน orphan)
        conn.execute(
            "UPDATE OR IGNORE member_aliases SET member_id = ? WHERE member_id = ?",
            (primary_id, source_id),
        )
        conn.execute("DELETE FROM member_aliases WHERE member_id = ?", (source_id,))
        conn.execute("DELETE FROM members WHERE id = ?", (source_id,))

        # 8) Update primary ด้วยค่าที่ merge
        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            try:
                conn.execute(
                    f"UPDATE members SET {set_clause} WHERE id = ?",
                    list(updates.values()) + [primary_id],
                )
            except sqlite3.IntegrityError as e:
                raise HTTPException(status_code=409, detail=f"merge ขัดกับ UNIQUE constraint: {e}")

    return {"ok": True, "merged_fields": list(updates.keys())}


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
    # v1.9.303 — รูป screenshot/อ้างอิง (กด preview)
    image_data: Optional[str] = Field(None, max_length=6_000_000)
    # v1.9.304 — หมายเหตุ platform
    note: Optional[str] = Field(None, max_length=4000)


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
    # v1.9.303 — รูป screenshot (ส่ง '' เพื่อลบ)
    image_data: Optional[str] = Field(None, max_length=6_000_000)
    # v1.9.304 — หมายเหตุ platform (ส่ง '' เพื่อลบ)
    note: Optional[str] = Field(None, max_length=4000)


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
    if payload.image_data is not None:
        updates["image_data"] = payload.image_data or None        # v1.9.303
    if payload.note is not None:
        updates["note"] = payload.note.strip() or None            # v1.9.304
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
    # v1.9.74 — phone (เบอร์มือถือ): สามารถแก้ได้เอง (unique)
    phone: Optional[str] = Field(None, min_length=4, max_length=40)
    # v1.9.74 — shirt_size: 'XS' / 'S' / 'M' / 'L' / 'XL' / 'XXL' / หรือข้อความอิสระ
    shirt_size: Optional[str] = Field(None, max_length=40)
    # v1.9.75 — birthdate: ISO YYYY-MM-DD; '' = clear
    birthdate: Optional[str] = Field(None, max_length=20)
    # v1.9.147 — privacy: แชร์ข้อมูลให้คนอื่นเห็นไหม
    share_birthdate: Optional[bool] = None
    share_shirt_size: Optional[bool] = None
    share_phone: Optional[bool] = None


def _require_member_session(token: Optional[str]) -> dict[str, Any]:
    sess = get_member_session(token)
    if not sess:
        raise HTTPException(status_code=401, detail="ไม่ได้เข้าสู่ระบบ")
    return sess


def _row_share(row: sqlite3.Row, key: str) -> int:
    """v1.9.147 — อ่านค่า privacy share flag (default 1=แชร์) แบบ defensive"""
    try:
        v = row[key]
    except (KeyError, IndexError):
        return 1
    return 0 if v == 0 else 1


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
    try:
        shirt_size = row["shirt_size"]
    except (KeyError, IndexError):
        shirt_size = None
    try:
        birthdate = row["birthdate"]
    except (KeyError, IndexError):
        birthdate = None
    # v1.9.105 — มีรูป Wazzup เก็บไว้ไหม (ให้ frontend แสดงปุ่ม 'เอาภาพจาก Wazzup' แม้ session หมด)
    try:
        wpu = row["wazzup_profile_url"]
    except (KeyError, IndexError):
        wpu = None
    # v1.9.82 — placeholder phone สำหรับ email-signup user → คืน null ให้ frontend
    raw_phone = row["phone"]
    phone = None if (raw_phone and raw_phone.startswith("email:")) else raw_phone
    return {
        "id": row["id"],
        "phone": phone,
        "email": row["email"],
        "display_name": row["display_name"],
        "has_password": bool(row["pw_hash"]),
        "is_admin": is_admin,
        "avatar_data": avatar_data,
        "shirt_size": shirt_size,
        "birthdate": birthdate,
        "has_wazzup_photo": bool(wpu),
        # v1.9.147 — privacy share flags (self เห็นค่าตัวเองเสมอ)
        "share_birthdate": _row_share(row, "share_birthdate"),
        "share_shirt_size": _row_share(row, "share_shirt_size"),
        "share_phone": _row_share(row, "share_phone"),
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

    try:
        with db_conn() as conn:
            existing = conn.execute(
                "SELECT id, enabled FROM members WHERE firebase_uid = ?", (firebase_uid,)
            ).fetchone()
            # v1.9.85 — fallback: หาใน member_aliases (กรณีบัญชีนี้ถูก merge ไปแล้ว)
            via_alias = False
            if not existing:
                existing = conn.execute(
                    "SELECT m.id, m.enabled FROM member_aliases a "
                    "JOIN members m ON m.id = a.member_id "
                    "WHERE a.kind = 'firebase_uid' AND a.value = ?",
                    (firebase_uid,),
                ).fetchone()
                via_alias = bool(existing)
            if existing and _is_member_disabled(existing):
                raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
            if existing:
                # v1.9.85 — ถ้า match ผ่าน alias ไม่ overwrite phone (primary's identity ต่างกัน)
                if via_alias:
                    conn.execute(
                        "UPDATE members SET last_login_at = ? WHERE id = ?",
                        (now, existing["id"]),
                    )
                else:
                    conn.execute(
                        "UPDATE members SET phone = ?, display_name = COALESCE(?, display_name), "
                        "last_login_at = ? WHERE id = ?",
                        (phone, display_name, now, existing["id"]),
                    )
                member_id = existing["id"]
                is_new = False
            else:
                # v1.9.226 — กัน UNIQUE(phone) ชน → 500: ถ้าเบอร์นี้มี member อยู่แล้วแต่ firebase_uid ไม่ตรง
                # (เช่นเปลี่ยน Firebase project / ลบ-สร้าง user ใหม่ → uid เปลี่ยน) → re-link uid ใหม่เข้ากับ member เดิม
                by_phone = conn.execute(
                    "SELECT id, enabled FROM members WHERE phone = ?", (phone,)
                ).fetchone()
                if by_phone:
                    if _is_member_disabled(by_phone):
                        raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
                    # v1.9.229 — ถ้าเป็น temp staff → claim เป็น account จริง (is_temp=0); ทุกอย่างที่ผูกไว้ติดมาเพราะ id เดิม
                    conn.execute(
                        "UPDATE members SET firebase_uid = ?, display_name = COALESCE(?, display_name), "
                        "is_temp = 0, last_login_at = ? WHERE id = ?",
                        (firebase_uid, display_name, now, by_phone["id"]),
                    )
                    member_id = by_phone["id"]
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
    except HTTPException:
        raise
    except Exception as e:   # v1.9.226 — log สาเหตุจริงแทน 500 เปล่า ๆ
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"บันทึกบัญชีไม่สำเร็จ ({type(e).__name__})")
    return {"ok": True, "role": "member", "member_id": member_id, "phone": phone,
            "is_new": is_new, "token": token, "label": display_name or phone}


class MemberSignupEmailIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=4, max_length=200)
    display_name: Optional[str] = Field(None, max_length=120)


# v1.9.83 — Wazzup SSO (Fareast Fameline identity backend)
WAZZUP_BASE_URL = os.environ.get("WAZZUP_BASE_URL", "https://api.fareastfamelineddb.com")
# v1.9.141 — รูปประจำตัวจาก Wazzup อาจอยู่คนละ subdomain (เช่น datafirst.fareastfamelineddb.com)
# → อนุญาตทุก subdomain ของ suffix นี้ (กัน SSRF แต่ยอมรับ host ในเครือ)
WAZZUP_PHOTO_HOST_SUFFIX = os.environ.get("WAZZUP_PHOTO_HOST_SUFFIX", "fareastfamelineddb.com")
# v1.9.116 — Beacon device API (ตำแหน่ง check-in พนักงาน) — host คนละตัวกับ Wazzup auth
BEACON_BASE_URL = os.environ.get("BEACON_BASE_URL", "https://123d92f01m.execute-api.ap-southeast-1.amazonaws.com/dev")
BEACON_ORIGIN = os.environ.get("BEACON_ORIGIN", "https://job.fareastfamelineddb.com")
# v1.9.157 — Windsor.ai (ดึงยอดใช้จ่ายค่าโฆษณา Meta/TikTok/X ฯลฯ) — ต้องตั้ง WINDSOR_API_KEY บน Railway
WINDSOR_API_KEY = os.environ.get("WINDSOR_API_KEY", "").strip()
WINDSOR_BASE_URL = os.environ.get("WINDSOR_BASE_URL", "https://connectors.windsor.ai").rstrip("/")
# v1.9.167 — Ads Benchmark: Google Sheet (public) ที่ดึง CPM benchmark — tab แรก
ADS_BENCHMARK_SHEET_ID = os.environ.get("ADS_BENCHMARK_SHEET_ID", "1V2dx573u9NcbAdwYOABo4HpqcuOMTJNme2iay-i4fFw")
# v1.9.198 — Ads Campaign: Google Sheet (public) รายการแคมเปญ — sheet แรก (ตั้ง GID ได้ถ้าอยู่แท็บอื่น)
ADS_CAMPAIGN_SHEET_ID = os.environ.get("ADS_CAMPAIGN_SHEET_ID", "17gjfbjCv5Ap7Isx5gdLW5E8kwjBEy5QmJcycquOl31E")
ADS_CAMPAIGN_SHEET_GID = os.environ.get("ADS_CAMPAIGN_SHEET_GID", "").strip()
# v1.9.199 — ทางเลือกสำรองสำหรับชีตที่องค์กรล็อกการแชร์: ใช้ลิงก์ "เผยแพร่ไปยังเว็บ" (Publish to web → CSV)
ADS_CAMPAIGN_CSV_URL = os.environ.get("ADS_CAMPAIGN_CSV_URL", "").strip()

# ===========================================================================
# v1.9.207 — Claude RateLimit: เข้ารหัส storageState (session credential)
#   key: env CLAUDE_RL_KEY (Fernet base64 key) — ถ้าไม่ตั้ง จะ gen แล้วเก็บไฟล์ข้าง DB (Railway Volume)
#   *** storageState = credential เต็มของ session — ห้าม log ค่า cookie ดิบ / ห้าม commit ***
# ===========================================================================
CLAUDE_RL_KEY = os.environ.get("CLAUDE_RL_KEY", "").strip()
# v1.9.209 — token สำหรับ local runner POST ผล usage เข้ามา (ไม่ต้องอัปโหลด session เข้าเว็บ)
CLAUDE_RL_INGEST_TOKEN = os.environ.get("CLAUDE_RL_INGEST_TOKEN", "").strip()

# ===========================================================================
# v1.9.211 — SSO (Identity Provider): ระบบอื่น login ด้วย Beat ได้ (OAuth/OIDC-ish)
#   Beat ออก id_token (JWT) พิสูจน์ตัวตน — ไม่แชร์รหัสผ่าน
# ===========================================================================
SSO_ISSUER = os.environ.get("SSO_ISSUER", "https://beat.datafirst.id").rstrip("/")
SSO_ID_TOKEN_TTL = int(os.environ.get("SSO_ID_TOKEN_TTL", "3600"))   # อายุ id_token (วินาที)
SSO_CODE_TTL = 120                                                    # อายุ authorization code (วินาที)
# v1.9.213 — TV Ad Monitor: ฝัง iframe หน้า scheduling (auto-login ด้วย Beat id_token)
TV_MONITOR_BASE_URL = os.environ.get("TV_MONITOR_BASE_URL", "http://10.22.50.65:5050").rstrip("/")
TV_MONITOR_CLIENT_ID = os.environ.get("TV_MONITOR_CLIENT_ID", "beat_f5fe57cd90ad9852").strip()


def _sso_b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _sso_b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sso_jwt_encode(payload: dict, secret: str) -> str:
    import hmac as _hmac
    import hashlib as _hashlib
    head = _sso_b64u(_json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _sso_b64u(_json.dumps(payload, separators=(",", ":")).encode())
    seg = f"{head}.{body}"
    sig = _sso_b64u(_hmac.new(secret.encode(), seg.encode(), _hashlib.sha256).digest())
    return f"{seg}.{sig}"


def _sso_jwt_decode(token: str, secret: str) -> Optional[dict]:
    import hmac as _hmac
    import hashlib as _hashlib
    try:
        seg, sig = token.rsplit(".", 1)
        expect = _sso_b64u(_hmac.new(secret.encode(), seg.encode(), _hashlib.sha256).digest())
        if not _hmac.compare_digest(sig, expect):
            return None
        payload = _json.loads(_sso_b64u_dec(seg.split(".", 1)[1]))
        if payload.get("exp") and float(payload["exp"]) < utc_now().timestamp():
            return None
        return payload
    except Exception:
        return None


def _clrl_fernet():
    try:
        from cryptography.fernet import Fernet
    except Exception:
        return None
    key = CLAUDE_RL_KEY
    if not key:
        keyfile = Path(DB_PATH).parent / "claude_rl.key"
        try:
            if keyfile.exists():
                key = keyfile.read_text().strip()
            else:
                key = Fernet.generate_key().decode()
                keyfile.write_text(key)
                try:
                    os.chmod(keyfile, 0o600)
                except Exception:
                    pass
        except Exception:
            return None
    try:
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception:
        return None


def _clrl_encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    f = _clrl_fernet()
    if f is None:                       # fallback (ไม่ปลอดภัยเท่า — มี cryptography แล้วจะไม่เข้าเส้นนี้)
        import base64
        return "b64:" + base64.b64encode(plaintext.encode()).decode()
    return "fe:" + f.encrypt(plaintext.encode()).decode()


def _clrl_decrypt(stored: str) -> str:
    if not stored:
        return ""
    if stored.startswith("fe:"):
        f = _clrl_fernet()
        if f is None:
            return ""
        try:
            return f.decrypt(stored[3:].encode()).decode()
        except Exception:
            return ""
    if stored.startswith("b64:"):
        import base64
        try:
            return base64.b64decode(stored[4:]).decode()
        except Exception:
            return ""
    return ""


class WazzupLoginIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=200)


def _wazzup_auth(username: str, password: str) -> dict[str, Any]:
    """POST /api/User/Authentication → returns Wazzup session dict (raises HTTPException on fail)"""
    body = _json.dumps({
        "authenticationName": username,
        "authenticationPassword": password,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{WAZZUP_BASE_URL}/api/User/Authentication",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise HTTPException(status_code=401, detail="username หรือ password ไม่ถูกต้อง")
        raise HTTPException(status_code=502, detail=f"Wazzup login failed (HTTP {e.code})")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เชื่อมต่อ Wazzup ไม่สำเร็จ: {e}")
    try:
        data = _json.loads(raw)
    except Exception:
        raise HTTPException(status_code=502, detail="Wazzup response ไม่ใช่ JSON")
    if not data.get("access_token"):
        raise HTTPException(status_code=401, detail="username หรือ password ไม่ถูกต้อง")
    return data


@app.post("/api/auth/wazzup-login")
def auth_wazzup_login(payload: WazzupLoginIn, response: Response) -> dict[str, Any]:
    """v1.9.83 — proxy Wazzup login → upsert FCT member (by email) → set FCT session + return Wazzup token"""
    waz = _wazzup_auth(payload.username, payload.password)
    email = (waz.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=502, detail="Wazzup ไม่ได้ส่ง email กลับมา — บัญชีนี้ใช้กับระบบนี้ไม่ได้")
    display_name = (waz.get("nickName") or waz.get("empThaiName") or waz.get("empEngName") or "").strip() or None
    waz_profile_url = (waz.get("profileURL") or "").strip() or None  # v1.9.92
    # v1.9.93 — extract empCode: ลอง field 'id' ก่อน, ถ้าไม่ได้ extract จาก profileURL pattern /upload/profile/<code>_profile.<ext>
    waz_emp_code = (waz.get("id") or "").strip() or None
    if not waz_emp_code and waz_profile_url:
        import re as _re
        m = _re.search(r"/upload/profile/([^/_?#]+)_profile\.", waz_profile_url, _re.IGNORECASE)
        if m:
            waz_emp_code = m.group(1)
    now = utc_now().isoformat()
    # upsert member by email
    placeholder = f"email:{email}"
    with db_conn() as conn:
        existing = conn.execute(
            "SELECT id, phone, firebase_uid, enabled FROM members WHERE LOWER(email) = ?",
            (email,),
        ).fetchone()
        # v1.9.85 — fallback: หาใน member_aliases (กรณีบัญชีนี้ถูก merge ไปแล้ว)
        if not existing:
            existing = conn.execute(
                "SELECT m.id, m.phone, m.firebase_uid, m.enabled "
                "FROM member_aliases a JOIN members m ON m.id = a.member_id "
                "WHERE a.kind = 'email' AND a.value = ?",
                (email,),
            ).fetchone()
        if existing and _is_member_disabled(existing):
            raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
        if existing:
            conn.execute(
                "UPDATE members SET display_name = COALESCE(?, display_name), "
                "last_login_at = ?, wazzup_profile_url = COALESCE(?, wazzup_profile_url), "
                "wazzup_emp_code = COALESCE(?, wazzup_emp_code) WHERE id = ?",
                (display_name, now, waz_profile_url, waz_emp_code, existing["id"]),
            )
            member_id = existing["id"]
            phone = existing["phone"]
            is_new = False
        else:
            cur = conn.execute(
                "INSERT INTO members(phone, firebase_uid, email, display_name, created_at, last_login_at, wazzup_profile_url, wazzup_emp_code) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (placeholder, placeholder, email, display_name, now, now, waz_profile_url, waz_emp_code),
            )
            member_id = cur.lastrowid
            phone = placeholder
            is_new = True
    token = _set_member_cookie(response, member_id, phone)
    return {
        "ok": True,
        "role": "member",
        "member_id": member_id,
        "token": token,
        "label": display_name or email,
        "is_new": is_new,
        "wazzup": {
            "access_token": waz.get("access_token"),
            "expiration": waz.get("expiration"),
            "email": waz.get("email"),
            "empThaiName": waz.get("empThaiName"),
            "empEngName": waz.get("empEngName"),
            "nickName": waz.get("nickName"),
            "positionName": waz.get("positionName"),
            "departmentName": waz.get("departmentName"),
            "profileURL": waz.get("profileURL"),
            "subdepartmentName": waz.get("subdepartmentName"),
            "companyId": waz.get("companyId"),
        },
    }


# v1.9.393 — IAMService SSO (Fareast Fameline central identity provider) — Flow B redirect
# Beat validate token โดยเรียก GET /api/User/Profile (server-to-server) — ไม่ต้องมี shared secret
IAM_BASE_URL = os.environ.get("IAM_BASE_URL", "https://iam.fareastfamelineddb.com").rstrip("/")


class IamSsoIn(BaseModel):
    access_token: str = Field(..., min_length=1, max_length=8000)


def _iam_fetch_profile(token: str) -> dict[str, Any]:
    """GET /api/User/Profile ด้วย Bearer token → ถ้า 200 = token ถูกต้อง (IAM validate ให้เอง) คืน {profile, userRole}"""
    req = urllib.request.Request(
        f"{IAM_BASE_URL}/api/User/Profile",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise HTTPException(status_code=401, detail="SSO token ไม่ถูกต้องหรือหมดอายุ — ลองเข้าสู่ระบบใหม่")
        raise HTTPException(status_code=502, detail=f"IAM Profile error HTTP {e.code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เชื่อมต่อ IAM ไม่สำเร็จ: {e}")
    try:
        return _json.loads(raw)
    except Exception:
        raise HTTPException(status_code=502, detail="IAM response ไม่ใช่ JSON")


@app.post("/api/auth/iam-sso")
def auth_iam_sso(payload: IamSsoIn, response: Response) -> dict[str, Any]:
    """v1.9.393 — รับ access_token จาก IAM SSO callback → validate ผ่าน Profile → เข้าเฉพาะ member ที่มีอยู่แล้ว"""
    token = (payload.access_token or "").strip()
    data = _iam_fetch_profile(token)
    prof = data.get("profile") or {}
    email = (prof.get("email") or prof.get("aspNetUsersEmail") or "").strip().lower()
    emp_code = (prof.get("empCode") or "").strip() or None
    display_name = (prof.get("nickName") or prof.get("empThaiName") or prof.get("empEngName") or "").strip() or None
    now = utc_now().isoformat()
    with db_conn() as conn:
        row = None
        if email:
            row = conn.execute("SELECT id, phone, enabled FROM members WHERE LOWER(email) = ?", (email,)).fetchone()
            if not row:
                row = conn.execute(
                    "SELECT m.id, m.phone, m.enabled FROM member_aliases a JOIN members m ON m.id = a.member_id "
                    "WHERE a.kind='email' AND a.value=?", (email,)).fetchone()
        if not row and emp_code:
            row = conn.execute(
                "SELECT id, phone, enabled FROM members WHERE wazzup_emp_code = ? OR hr_employee_id = ? LIMIT 1",
                (emp_code, emp_code)).fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="ยังไม่มีบัญชีในระบบ Beat — ติดต่อผู้ดูแลเพื่อเพิ่มบัญชีก่อน (SSO เข้าได้เฉพาะบัญชีที่มีอยู่แล้ว)")
        if _is_member_disabled(row):
            raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")
        conn.execute(
            "UPDATE members SET last_login_at=?, display_name=COALESCE(display_name,?), "
            "wazzup_emp_code=COALESCE(wazzup_emp_code,?), hr_employee_id=COALESCE(hr_employee_id,?) WHERE id=?",
            (now, display_name, emp_code, emp_code, row["id"]))
        member_id = row["id"]
        phone = row["phone"]
    tok = _set_member_cookie(response, member_id, phone)
    return {"ok": True, "role": "member", "member_id": member_id, "token": tok,
            "label": display_name or email or ("member " + str(member_id))}


class WazzupPhotoIn(BaseModel):
    photo_url: str = Field(..., min_length=1, max_length=2000)


def _fetch_wazzup_image_as_data_url(raw_url: str, bearer_token: str | None = None) -> dict[str, Any]:
    """v1.9.92 — Shared helper: resolve + URL-encode + GET image จาก Wazzup → return {data_url, bytes}.
    bearer_token เป็น optional (Wazzup รูปประจำตัวเข้าถึงได้สาธารณะ — แต่ส่ง token ไปด้วยเพื่อ future-proof)"""
    raw = (raw_url or "").strip().lstrip("﻿").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="photo_url ว่าง")
    from urllib.parse import urljoin as _urljoin, urlsplit as _urlsplit, urlunsplit as _urlunsplit, quote as _quote
    base = WAZZUP_BASE_URL.rstrip("/") + "/"
    resolved = _urljoin(base, raw)
    if not (resolved.startswith("http://") or resolved.startswith("https://")):
        raise HTTPException(status_code=400, detail=f"photo_url รูปแบบไม่ถูกต้อง (raw={raw!r}, resolved={resolved!r})")
    try:
        sp = _urlsplit(resolved)
    except Exception:
        raise HTTPException(status_code=400, detail="photo_url parse ไม่ได้")
    # v1.9.141 — อนุญาตทุก subdomain ของ fareastfamelineddb.com (Wazzup ย้าย host รูปเป็น datafirst.fareastfamelineddb.com)
    host_only = (sp.netloc or "").lower().split("@")[-1].split(":")[0]
    suffix = WAZZUP_PHOTO_HOST_SUFFIX.lower().lstrip(".")
    if sp.netloc and not (host_only == suffix or host_only.endswith("." + suffix)):
        raise HTTPException(status_code=400, detail=f"photo_url ไม่ใช่ Wazzup host — ปฏิเสธ ({sp.netloc})")
    safe_path = _quote(sp.path, safe="/%")
    safe_query = _quote(sp.query, safe="=&%")
    url = _urlunsplit((sp.scheme, sp.netloc, safe_path, safe_query, ""))
    headers = {"Accept": "image/*"}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
            ct = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise HTTPException(status_code=401, detail="Wazzup token หมดอายุ — login ใหม่")
        if e.code == 404:
            raise HTTPException(status_code=404, detail=f"Wazzup ไม่มีรูปประจำตัวสำหรับบัญชีนี้ ({url})")
        raise HTTPException(status_code=502, detail=f"โหลดรูปจาก Wazzup ไม่สำเร็จ (HTTP {e.code}) URL={url}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เชื่อมต่อ Wazzup ไม่สำเร็จ: {e} (URL={url})")
    if not ct.startswith("image/"):
        raise HTTPException(status_code=502, detail=f"Wazzup ส่ง content-type ที่ไม่ใช่รูป: {ct}")
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="รูปจาก Wazzup ใหญ่เกิน 8MB")
    b64 = _b64.b64encode(data).decode("ascii")
    return {"data_url": f"data:{ct};base64,{b64}", "bytes": len(data)}


@app.post("/api/auth/wazzup-photo")
def auth_wazzup_photo(payload: WazzupPhotoIn, request: Request) -> dict[str, Any]:
    """v1.9.89 — proxy ดึงรูปจาก Wazzup (member เอารูปตัวเอง — ใช้ Bearer token จาก sessionStorage)"""
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="ต้องมี Wazzup Bearer token ใน Authorization header")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Wazzup token ว่าง")
    result = _fetch_wazzup_image_as_data_url(payload.photo_url, bearer_token=token)
    return {"ok": True, **result}


class AdminAvatarFromWazzupIn(BaseModel):
    emp_code: str | None = Field(None, max_length=50)  # v1.9.93 — admin ป้อน empCode → construct URL


# v1.9.92/93 — admin ดึงรูป Wazzup ของ member อื่น
# - ถ้าส่ง emp_code มา: construct URL '/upload/profile/<empCode>_profile.png' + save empCode
# - ถ้าไม่ส่ง: ใช้ stored wazzup_profile_url (member ที่เคย login Wazzup เอง)
@app.post("/api/admin/members/{member_id}/avatar-from-wazzup")
def admin_member_avatar_from_wazzup(
    member_id: int,
    payload: AdminAvatarFromWazzupIn,
    request: Request,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, display_name, wazzup_profile_url, wazzup_emp_code FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="ไม่พบ member")
    # v1.9.93 — เลือก URL: empCode (ใหม่จาก payload หรือ stored) → construct, fallback ไป stored profileURL
    emp_code = (payload.emp_code or "").strip() or row["wazzup_emp_code"]
    if emp_code:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", emp_code):
            raise HTTPException(status_code=400, detail="empCode ต้องเป็น A-Z 0-9 _ - เท่านั้น")
        photo_url = f"/upload/profile/{emp_code}_profile.png"
    elif row["wazzup_profile_url"]:
        photo_url = row["wazzup_profile_url"]
    else:
        raise HTTPException(status_code=400, detail="ต้องระบุ Wazzup empCode (หรือให้ member login Wazzup ก่อน)")
    auth = request.headers.get("Authorization", "")
    token = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else None
    result = _fetch_wazzup_image_as_data_url(photo_url, bearer_token=token)
    # save empCode ถ้า admin ป้อนใหม่ + fetch สำเร็จ
    if payload.emp_code and payload.emp_code.strip() != (row["wazzup_emp_code"] or ""):
        with db_conn() as conn:
            conn.execute(
                "UPDATE members SET wazzup_emp_code = ? WHERE id = ?",
                (payload.emp_code.strip(), member_id),
            )
    return {"ok": True, "member_id": member_id, "display_name": row["display_name"], "emp_code_used": emp_code, **result}


class AdminMemberAvatarIn(BaseModel):
    avatar_data: str | None = Field(None, max_length=4_000_000)  # base64 data URL หรือ '' เพื่อลบ


# v1.9.92 — admin set/clear avatar ของ member อื่น
@app.patch("/api/admin/members/{member_id}/avatar")
def admin_member_set_avatar(
    member_id: int,
    payload: AdminMemberAvatarIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    new_avatar = (payload.avatar_data or "").strip() or None
    if new_avatar and not new_avatar.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="avatar_data ต้องเป็น data URL (data:image/...)")
    with db_conn() as conn:
        cur = conn.execute(
            "UPDATE members SET avatar_data = ? WHERE id = ?",
            (new_avatar, member_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="ไม่พบ member")
    return {"ok": True, "member_id": member_id, "has_avatar": bool(new_avatar)}


@app.post("/api/member/signup-email")
def member_signup_email(payload: MemberSignupEmailIn, response: Response) -> dict[str, Any]:
    """v1.9.82 — สมัครด้วยอีเมล + รหัสผ่าน (ไม่ต้องผ่าน Firebase phone OTP)"""
    email = payload.email.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(status_code=400, detail="รูปแบบอีเมลไม่ถูกต้อง")
    display_name = (payload.display_name or "").strip() or None
    pw_hash, pw_salt = hash_password(payload.password)
    now = utc_now().isoformat()
    # placeholder phone + firebase_uid (UNIQUE NOT NULL constraint) — frontend จะ strip 'email:' prefix
    placeholder = f"email:{email}"
    try:
        with db_conn() as conn:
            existing = conn.execute(
                "SELECT id FROM members WHERE LOWER(email) = ?", (email,)
            ).fetchone()
            if existing:
                raise HTTPException(status_code=409, detail="อีเมลนี้ถูกใช้แล้ว")
            cur = conn.execute(
                "INSERT INTO members(phone, firebase_uid, email, display_name, "
                "                    pw_hash, pw_salt, created_at, last_login_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (placeholder, placeholder, email, display_name, pw_hash, pw_salt, now, now),
            )
            member_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="อีเมลนี้ถูกใช้แล้ว")
    token = _set_member_cookie(response, member_id, placeholder)
    return {
        "ok": True, "role": "member", "member_id": member_id,
        "token": token, "label": display_name or email, "is_new": True,
    }


@app.post("/api/member/login")
def member_login(payload: MemberLoginIn, response: Response) -> dict[str, Any]:
    """Login ด้วย email + password (เลือกใช้แทน OTP สำหรับคนที่ตั้งรหัสไว้แล้ว)"""
    email = payload.email.strip().lower()
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, phone, email, pw_hash, pw_salt, enabled FROM members WHERE LOWER(email) = ?",
            (email,),
        ).fetchone()
        # v1.9.85 — fallback: หาใน member_aliases
        if not row:
            row = conn.execute(
                "SELECT m.id, m.phone, m.email, m.pw_hash, m.pw_salt, m.enabled "
                "FROM member_aliases a JOIN members m ON m.id = a.member_id "
                "WHERE a.kind = 'email' AND a.value = ?",
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


# v1.9.95 — Add login methods (member-side): email+pw, phone OTP, Wazzup → all link to same profile
class AddEmailPasswordIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=4, max_length=200)


class AddPhoneIn(BaseModel):
    id_token: str = Field(..., min_length=10, max_length=4000)


class AddWazzupIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=200)
    password: str = Field(..., min_length=1, max_length=200)


def _check_identity_taken(conn, kind: str, value: str, exclude_member_id: int) -> bool:
    """True ถ้า value นี้ถูกใช้โดย member อื่น (ใน members table หรือ aliases)"""
    if kind == "email":
        row = conn.execute(
            "SELECT id FROM members WHERE LOWER(email) = ? AND id != ?",
            (value.lower(), exclude_member_id),
        ).fetchone()
    elif kind == "phone":
        row = conn.execute(
            "SELECT id FROM members WHERE phone = ? AND id != ?",
            (value, exclude_member_id),
        ).fetchone()
    elif kind == "firebase_uid":
        row = conn.execute(
            "SELECT id FROM members WHERE firebase_uid = ? AND id != ?",
            (value, exclude_member_id),
        ).fetchone()
    else:
        return False
    if row:
        return True
    # v1.9.113 — JOIN members เพื่อไม่ให้ orphaned alias (member ถูกลบไปแล้ว) block การใช้ value ซ้ำ
    row = conn.execute(
        "SELECT a.member_id FROM member_aliases a JOIN members m ON m.id = a.member_id "
        "WHERE a.kind = ? AND a.value = ? AND a.member_id != ?",
        (kind, value.lower() if kind == "email" else value, exclude_member_id),
    ).fetchone()
    return bool(row)


def _add_alias(conn, member_id: int, kind: str, value: str):
    """Insert alias — IGNORE ถ้าซ้ำ"""
    conn.execute(
        "INSERT OR IGNORE INTO member_aliases(member_id, kind, value, source, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (member_id, kind, value, "add-method", utc_now().isoformat()),
    )


@app.post("/api/member/add-email-password")
def member_add_email_password(
    payload: AddEmailPasswordIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """v1.9.95 — เพิ่มวิธี login ด้วย email + password เข้ากับ member ปัจจุบัน"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    email = payload.email.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(status_code=400, detail="รูปแบบอีเมลไม่ถูกต้อง")
    pw_hash, pw_salt = hash_password(payload.password)
    with db_conn() as conn:
        cur_row = conn.execute(
            "SELECT email, pw_hash FROM members WHERE id = ?", (member_id,)
        ).fetchone()
        if not cur_row:
            raise HTTPException(status_code=404, detail="member ไม่พบ")
        if _check_identity_taken(conn, "email", email, member_id):
            raise HTTPException(status_code=409, detail="email นี้ถูกใช้โดย account อื่นแล้ว")
        cur_email = (cur_row["email"] or "").lower()
        if cur_email == email and cur_row["pw_hash"]:
            raise HTTPException(status_code=400, detail="คุณมี email + password นี้อยู่แล้ว")
        if not cur_row["email"]:
            conn.execute(
                "UPDATE members SET email = ?, pw_hash = ?, pw_salt = ? WHERE id = ?",
                (email, pw_hash, pw_salt, member_id),
            )
        else:
            # มี email อยู่แล้ว → email ใหม่กลายเป็น alias, set pw (ถ้ายังไม่มี)
            if cur_email != email:
                _add_alias(conn, member_id, "email", email)
            if not cur_row["pw_hash"]:
                conn.execute(
                    "UPDATE members SET pw_hash = ?, pw_salt = ? WHERE id = ?",
                    (pw_hash, pw_salt, member_id),
                )
    return {"ok": True, "added": "email_pw", "email": email}


@app.post("/api/member/add-phone")
def member_add_phone(
    payload: AddPhoneIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """v1.9.95 — เพิ่มวิธี login ด้วยเบอร์มือถือ (Firebase OTP) เข้ากับ member ปัจจุบัน"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    try:
        user = verify_firebase_id_token(payload.id_token)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    new_phone = user["phoneNumber"]
    new_uid = user["localId"]
    with db_conn() as conn:
        cur_row = conn.execute(
            "SELECT phone, firebase_uid FROM members WHERE id = ?", (member_id,)
        ).fetchone()
        if not cur_row:
            raise HTTPException(status_code=404, detail="member ไม่พบ")
        if _check_identity_taken(conn, "phone", new_phone, member_id):
            raise HTTPException(status_code=409, detail="เบอร์นี้ถูกใช้โดย account อื่นแล้ว")
        if _check_identity_taken(conn, "firebase_uid", new_uid, member_id):
            raise HTTPException(status_code=409, detail="Firebase UID นี้ถูกใช้โดย account อื่นแล้ว")
        cur_phone = cur_row["phone"]
        cur_uid = cur_row["firebase_uid"]
        if cur_phone == new_phone and cur_uid == new_uid:
            raise HTTPException(status_code=400, detail="คุณมีเบอร์นี้อยู่แล้ว")
        if _is_placeholder_phone(cur_phone) or not cur_phone:
            # phone slot ว่าง → set เป็น primary
            conn.execute(
                "UPDATE members SET phone = ?, firebase_uid = ? WHERE id = ?",
                (new_phone, new_uid, member_id),
            )
        else:
            # มี phone อยู่แล้ว → ใหม่เป็น alias
            _add_alias(conn, member_id, "phone", new_phone)
            _add_alias(conn, member_id, "firebase_uid", new_uid)
    return {"ok": True, "added": "phone", "phone": new_phone}


@app.post("/api/member/avatar-from-wazzup")
def member_avatar_from_wazzup(
    request: Request,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """v1.9.105 — member ดึงรูปประจำตัวของตัวเองจาก Wazzup (ใช้ URL ที่เก็บไว้ใน DB — ไม่ต้องมี session สด)"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    with db_conn() as conn:
        row = conn.execute(
            "SELECT wazzup_profile_url FROM members WHERE id = ?", (member_id,)
        ).fetchone()
    if not row or not row["wazzup_profile_url"]:
        raise HTTPException(status_code=400, detail="ยังไม่มีรูป Wazzup เก็บไว้ — กรุณา login ด้วย Wazzup ก่อน")
    # Bearer token optional (รูปประจำตัว Wazzup เข้าถึงได้สาธารณะ)
    auth = request.headers.get("Authorization", "")
    token = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else None
    result = _fetch_wazzup_image_as_data_url(row["wazzup_profile_url"], bearer_token=token)
    return {"ok": True, **result}


# v1.9.116 — Beacon device: ดึงตำแหน่ง check-in (proxy หนี CORS)
def _beacon_request(emp_code: str, token: str, timeout: int = 12) -> dict[str, Any]:
    """เรียก Beacon API → return parsed dict. Raise urllib.error.HTTPError ถ้า non-2xx"""
    from urllib.parse import quote as _quote
    url = f"{BEACON_BASE_URL.rstrip('/')}/v1/emp/location/{_quote(emp_code, safe='')}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/plain, */*",
        "Origin": BEACON_ORIGIN,
        "Referer": BEACON_ORIGIN + "/",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = _json.loads(resp.read().decode("utf-8", errors="replace"))
    return data if isinstance(data, dict) else {}


@app.get("/api/member/beacon-location")
def member_beacon_location(
    request: Request,
    username: Optional[str] = None,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="ต้องมี Wazzup Bearer token (login Wazzup ก่อน)")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Wazzup token ว่าง")
    # username (empCode) — ใช้จาก query ถ้าส่งมา ไม่งั้นดึงจาก member ที่เก็บไว้
    uname = (username or "").strip()
    if not uname:
        with db_conn() as conn:
            row = conn.execute(
                "SELECT wazzup_emp_code FROM members WHERE id = ?", (member_id,)
            ).fetchone()
        uname = (row["wazzup_emp_code"] if row and row["wazzup_emp_code"] else "").strip()
    if not uname:
        raise HTTPException(status_code=400, detail="ยังไม่มี Wazzup empCode — กรุณา login/ผูก Wazzup ก่อน")
    try:
        data = _beacon_request(uname, token, timeout=15)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise HTTPException(status_code=401, detail="Wazzup token หมดอายุ — login ใหม่")
        if e.code == 403:
            raise HTTPException(status_code=403, detail="ไม่มีสิทธิ์อ่านข้อมูล check-in ของ user นี้")
        if e.code == 404:
            raise HTTPException(status_code=404, detail="ไม่พบ username นี้ในระบบ Beacon")
        raise HTTPException(status_code=502, detail=f"โหลดข้อมูล Beacon ไม่สำเร็จ (HTTP {e.code})")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เชื่อมต่อ Beacon ไม่สำเร็จ: {e}")
    return {
        "ok": True,
        "username": uname,
        "checkInToday": data.get("checkInToday"),
        "checkInLastTime": data.get("checkInLastTime"),
    }


# v1.9.117 — admin: ลองอ่าน check-in ของ member ทุกคน (ใช้ admin's Wazzup token)
@app.get("/api/admin/beacon-all")
def admin_beacon_all(
    request: Request,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="ต้องมี Wazzup Bearer token (admin login Wazzup ก่อน)")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Wazzup token ว่าง")
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, display_name, email, avatar_data, wazzup_emp_code "
            "FROM members WHERE wazzup_emp_code IS NOT NULL AND wazzup_emp_code != '' "
            "ORDER BY display_name COLLATE NOCASE LIMIT 200"
        ).fetchall()
    members = [dict(r) for r in rows]

    def _fetch_one(m: dict) -> dict[str, Any]:
        base = {
            "member_id": m["id"],
            "display_name": m["display_name"],
            "email": m["email"],
            "avatar_data": m["avatar_data"],
            "emp_code": m["wazzup_emp_code"],
        }
        try:
            data = _beacon_request(m["wazzup_emp_code"], token, timeout=10)
            return {**base, "status": "ok",
                    "checkInToday": data.get("checkInToday"),
                    "checkInLastTime": data.get("checkInLastTime")}
        except urllib.error.HTTPError as e:
            st = {401: "unauthorized", 403: "forbidden", 404: "notfound"}.get(e.code, f"http_{e.code}")
            return {**base, "status": st}
        except Exception as e:
            return {**base, "status": "error", "error": str(e)[:120]}

    from concurrent.futures import ThreadPoolExecutor
    if members:
        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(_fetch_one, members))
    else:
        results = []
    summary = {}
    for r in results:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    return {"ok": True, "count": len(results), "summary": summary, "results": results}


@app.post("/api/member/add-wazzup")
def member_add_wazzup(
    payload: AddWazzupIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """v1.9.95 — เพิ่มวิธี login ด้วย Wazzup เข้ากับ member ปัจจุบัน"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    waz = _wazzup_auth(payload.username, payload.password)
    waz_email = (waz.get("email") or "").strip().lower()
    if not waz_email:
        raise HTTPException(status_code=502, detail="Wazzup ไม่ได้ส่ง email กลับมา")
    waz_profile_url = (waz.get("profileURL") or "").strip() or None
    waz_emp_code = (waz.get("id") or "").strip() or None
    if not waz_emp_code and waz_profile_url:
        m = re.search(r"/upload/profile/([^/_?#]+)_profile\.", waz_profile_url, re.IGNORECASE)
        if m:
            waz_emp_code = m.group(1)
    with db_conn() as conn:
        cur_row = conn.execute(
            "SELECT email, wazzup_profile_url, wazzup_emp_code FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if not cur_row:
            raise HTTPException(status_code=404, detail="member ไม่พบ")
        if _check_identity_taken(conn, "email", waz_email, member_id):
            raise HTTPException(status_code=409, detail=f"Wazzup email ({waz_email}) ถูกใช้โดย account อื่นแล้ว")
        cur_email = (cur_row["email"] or "").lower()
        updates = {}
        if not cur_row["email"]:
            updates["email"] = waz_email
        elif cur_email != waz_email:
            _add_alias(conn, member_id, "email", waz_email)
        if waz_profile_url:
            updates["wazzup_profile_url"] = waz_profile_url
        if waz_emp_code:
            updates["wazzup_emp_code"] = waz_emp_code
        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [member_id]
            conn.execute(f"UPDATE members SET {set_clause} WHERE id = ?", values)
    return {
        "ok": True, "added": "wazzup", "email": waz_email,
        "wazzup": {
            "access_token": waz.get("access_token"),
            "expiration": waz.get("expiration"),
            "email": waz.get("email"),
            "empThaiName": waz.get("empThaiName"),
            "empEngName": waz.get("empEngName"),
            "nickName": waz.get("nickName"),
            "profileURL": waz.get("profileURL"),
        },
    }


# v1.9.96 — ลบวิธี login (ต้องมี ≥1 วิธีเหลือเสมอ)
class RemoveLoginMethodIn(BaseModel):
    kind: str = Field(..., min_length=1, max_length=20)  # 'phone' | 'email_pw' | 'wazzup' | 'alias'
    alias_kind: Optional[str] = None    # for kind='alias': 'phone'|'email'|'firebase_uid'
    value: Optional[str] = None         # for kind='alias': the value to delete


@app.post("/api/member/remove-login-method")
def member_remove_login_method(
    payload: RemoveLoginMethodIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    kind = payload.kind
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="member ไม่พบ")
        alias_rows = conn.execute(
            "SELECT id, kind, value FROM member_aliases WHERE member_id = ?", (member_id,)
        ).fetchall()
        aliases_full = [{"id": a["id"], "kind": a["kind"], "value": a["value"]} for a in alias_rows]

        # ---- simulate post-remove state เพื่อเช็คว่าเหลือ ≥1 method ----
        sim_phone = row["phone"]
        sim_firebase_uid = row["firebase_uid"]
        sim_email = row["email"]
        sim_pw = row["pw_hash"]
        sim_wazzup_url = row["wazzup_profile_url"] if "wazzup_profile_url" in row.keys() else None
        sim_aliases = [{"kind": a["kind"], "value": a["value"]} for a in aliases_full]

        if kind == "phone":
            sim_phone = f"removed:{member_id}:{utc_now().timestamp()}"
            sim_firebase_uid = sim_phone
            sim_aliases = [a for a in sim_aliases if a["kind"] not in ("phone", "firebase_uid")]
        elif kind == "email_pw":
            sim_pw = None
        elif kind == "wazzup":
            sim_wazzup_url = None
        elif kind == "alias":
            if not payload.alias_kind or not payload.value:
                raise HTTPException(status_code=400, detail="ต้องระบุ alias_kind + value")
            sim_aliases = [a for a in sim_aliases if not (a["kind"] == payload.alias_kind and a["value"] == payload.value)]
        else:
            raise HTTPException(status_code=400, detail="kind ไม่ถูกต้อง (phone|email_pw|wazzup|alias)")

        # ทำ wazzup label check ตาม logic เดิม: wazzup method มีถ้า email (own หรือ alias)
        sim_has_password = bool(sim_pw)
        sim_methods = _build_login_methods(
            firebase_uid=sim_firebase_uid,
            phone=sim_phone,
            email=sim_email,
            has_password=sim_has_password,
            aliases=sim_aliases,
        )
        if len(sim_methods) == 0:
            raise HTTPException(status_code=400, detail="ลบไม่ได้ — ต้องเหลืออย่างน้อย 1 วิธี login (ไม่งั้นเข้าระบบไม่ได้)")

        # ---- apply removal ----
        if kind == "phone":
            placeholder = f"removed:{member_id}:{int(utc_now().timestamp())}"
            conn.execute(
                "UPDATE members SET phone = ?, firebase_uid = ? WHERE id = ?",
                (placeholder, placeholder, member_id),
            )
            conn.execute(
                "DELETE FROM member_aliases WHERE member_id = ? AND kind IN ('phone','firebase_uid')",
                (member_id,),
            )
        elif kind == "email_pw":
            conn.execute(
                "UPDATE members SET pw_hash = NULL, pw_salt = NULL WHERE id = ?",
                (member_id,),
            )
        elif kind == "wazzup":
            conn.execute(
                "UPDATE members SET wazzup_profile_url = NULL, wazzup_emp_code = NULL WHERE id = ?",
                (member_id,),
            )
        elif kind == "alias":
            conn.execute(
                "DELETE FROM member_aliases WHERE member_id = ? AND kind = ? AND value = ?",
                (member_id, payload.alias_kind, payload.value),
            )
    return {"ok": True, "removed": kind}


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
    # v1.9.74 — phone (เบอร์มือถือ): unique constraint ใน DB — ถ้าซ้ำ → 409
    if payload.phone is not None:
        v = payload.phone.strip()
        if v:
            # validate basic: ตัวเลข + อาจมี + - space ได้
            if not re.fullmatch(r"[\d+\-\s()]{4,40}", v):
                raise HTTPException(status_code=400, detail="รูปแบบเบอร์มือถือไม่ถูกต้อง")
            updates["phone"] = v
        # ถ้าส่ง empty string → ไม่ update (phone ห้ามว่าง — เป็น UNIQUE NOT NULL)
    # v1.9.74 — shirt_size: '' = clear, non-empty = set
    if payload.shirt_size is not None:
        v = payload.shirt_size.strip()
        updates["shirt_size"] = v or None
    # v1.9.75 — birthdate: '' = clear; expects YYYY-MM-DD
    if payload.birthdate is not None:
        v = payload.birthdate.strip()
        if v:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                raise HTTPException(status_code=400, detail="วันเกิดต้องเป็นรูปแบบ YYYY-MM-DD")
            updates["birthdate"] = v
        else:
            updates["birthdate"] = None
    # v1.9.147 — privacy share flags
    if payload.share_birthdate is not None:
        updates["share_birthdate"] = 1 if payload.share_birthdate else 0
    if payload.share_shirt_size is not None:
        updates["share_shirt_size"] = 1 if payload.share_shirt_size else 0
    if payload.share_phone is not None:
        updates["share_phone"] = 1 if payload.share_phone else 0

    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [member_id]
    try:
        with db_conn() as conn:
            conn.execute(f"UPDATE members SET {set_clause} WHERE id = ?", values)
            row = conn.execute(
                "SELECT id, phone, email, display_name, pw_hash, is_admin, avatar_data, "
                "       shirt_size, birthdate, share_birthdate, share_shirt_size, share_phone, "
                "       created_at, last_login_at "
                "FROM members WHERE id = ?",
                (member_id,),
            ).fetchone()
            member_profile = _member_row_to_profile(row)
            # v1.9.88 — แนบ login_methods + aliases
            member_profile.update(_fetch_member_login_meta(conn, member_id))
    except sqlite3.IntegrityError as e:
        # email/phone ซ้ำ — บอกแบบ generic แต่ระบุ context จาก updates
        if "phone" in updates:
            raise HTTPException(status_code=409, detail="เบอร์มือถือนี้ถูกใช้แล้ว") from e
        raise HTTPException(status_code=409, detail="อีเมลนี้ถูกใช้แล้ว") from e

    return {"ok": True, "member": member_profile}


@app.post("/api/member/logout")
def member_logout(
    response: Response,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    if fct_member_session:
        destroy_member_session(fct_member_session)
    response.delete_cookie(MEMBER_COOKIE, path="/")
    return {"ok": True}


# ===========================================================================
# Domain name tracking (v1.18)
# ===========================================================================

class DomainIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    register_date: Optional[str] = Field(None, max_length=40)
    expire_date: Optional[str] = Field(None, max_length=40)
    provider: Optional[str] = Field(None, max_length=120)
    notes: Optional[str] = Field(None, max_length=2000)
    logo_data: Optional[str] = Field(None, max_length=700_000)   # base64 data URL (cropped 256x256)
    customer_status: Optional[str] = Field(None, max_length=20)   # v1.9.272 'current' | 'former'
    # WHOIS sync flags — frontend sends:
    #   True  = "this date is fresh from WHOIS" (set timestamp = now)
    #   False = "user manually edited this date" (clear timestamp)
    #   None  = "untouched" (don't change timestamp)
    register_from_whois: Optional[bool] = None
    expire_from_whois: Optional[bool] = None


class DomainPatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    register_date: Optional[str] = Field(None, max_length=40)
    expire_date: Optional[str] = Field(None, max_length=40)
    provider: Optional[str] = Field(None, max_length=120)
    notes: Optional[str] = Field(None, max_length=2000)
    logo_data: Optional[str] = Field(None, max_length=700_000)   # '' = clear, NULL = unchanged
    customer_status: Optional[str] = Field(None, max_length=20)   # v1.9.272 'current' | 'former'
    register_from_whois: Optional[bool] = None
    expire_from_whois: Optional[bool] = None


class DomainRenewalIn(BaseModel):
    new_expire_date: str = Field(..., max_length=40)   # ISO YYYY-MM-DD (required)
    receipt_data: Optional[str] = Field(None, max_length=3_500_000)   # ~2.5 MB base64
    receipt_name: Optional[str] = Field(None, max_length=200)
    receipt_type: Optional[str] = Field(None, max_length=120)
    cost_amount: Optional[float] = Field(None, ge=0)
    cost_currency: Optional[str] = Field(None, max_length=10)
    note: Optional[str] = Field(None, max_length=2000)


@app.get("/api/domains")
def list_domains_public(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """รายการ domains — เปิดให้ทุก logged-in user (สำหรับ Domain Name page ฝั่ง member)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, register_date, expire_date, provider, notes, created_at, "
            "       register_whois_synced_at, expire_whois_synced_at, logo_data "
            "FROM domains ORDER BY expire_date ASC NULLS LAST, name COLLATE NOCASE ASC"
        ).fetchall()
    return {"domains": [dict(r) for r in rows]}


@app.get("/api/admin/domains")
def admin_list_domains(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    """รายการ domains พร้อม renewal count"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT d.*, "
            "  (SELECT COUNT(*) FROM domain_renewals r WHERE r.domain_id = d.id) AS renewal_count, "
            "  (SELECT MAX(renewed_at) FROM domain_renewals r WHERE r.domain_id = d.id) AS last_renewed_at "
            "FROM domains d ORDER BY d.expire_date ASC NULLS LAST, d.name COLLATE NOCASE ASC"
        ).fetchall()
    return {"domains": [dict(r) for r in rows]}


def _resolve_whois_sync_ts(flag: Optional[bool], now_iso: str) -> tuple[bool, Optional[str]]:
    """Translate frontend flag → (should_update, value).
       True  → ('update', now)   = WHOIS-applied just now
       False → ('update', None)  = manually edited, clear timestamp
       None  → ('skip',  None)   = leave existing timestamp alone
    """
    if flag is True:
        return True, now_iso
    if flag is False:
        return True, None
    return False, None


@app.post("/api/admin/domains")
def admin_create_domain(payload: DomainIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    name = (payload.name or "").strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="ชื่อ domain ต้องไม่ว่าง")
    now_iso = utc_now().isoformat()
    # Translate WHOIS flags to timestamp values (default NULL on create)
    reg_ts: Optional[str] = now_iso if payload.register_from_whois is True else None
    exp_ts: Optional[str] = now_iso if payload.expire_from_whois is True else None
    with db_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO domains(name, register_date, expire_date, provider, notes, created_at, "
                "                    register_whois_synced_at, expire_whois_synced_at, logo_data, customer_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (name, payload.register_date or None, payload.expire_date or None,
                 payload.provider or None, payload.notes or None, now_iso,
                 reg_ts, exp_ts, payload.logo_data or None,
                 'former' if (payload.customer_status == 'former') else 'current'),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail=f"domain '{name}' มีอยู่แล้ว")
    return {"ok": True, "id": cur.lastrowid}


@app.patch("/api/admin/domains/{domain_id}")
def admin_update_domain(
    domain_id: int,
    payload: DomainPatchIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if payload.name is not None:
        v = payload.name.strip().lower()
        if not v:
            raise HTTPException(status_code=400, detail="ชื่อ domain ต้องไม่ว่าง")
        updates["name"] = v
    if payload.register_date is not None:
        updates["register_date"] = payload.register_date or None
    if payload.expire_date is not None:
        updates["expire_date"] = payload.expire_date or None
    if payload.provider is not None:
        updates["provider"] = payload.provider or None
    if payload.notes is not None:
        updates["notes"] = payload.notes or None
    if payload.logo_data is not None:
        # '' = clear, non-empty = set new image
        updates["logo_data"] = payload.logo_data or None
    if payload.customer_status is not None:
        updates["customer_status"] = 'former' if (payload.customer_status == 'former') else 'current'
    # WHOIS sync timestamps
    now_iso = utc_now().isoformat()
    reg_should, reg_val = _resolve_whois_sync_ts(payload.register_from_whois, now_iso)
    exp_should, exp_val = _resolve_whois_sync_ts(payload.expire_from_whois, now_iso)
    if reg_should:
        updates["register_whois_synced_at"] = reg_val
    if exp_should:
        updates["expire_whois_synced_at"] = exp_val
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [domain_id]
    with db_conn() as conn:
        try:
            cur = conn.execute(f"UPDATE domains SET {set_clause} WHERE id = ?", values)
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="ชื่อ domain ซ้ำ")
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="domain not found")
    return {"ok": True}


@app.delete("/api/admin/domains/{domain_id}")
def admin_delete_domain(domain_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM domains WHERE id = ?", (domain_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="domain not found")
    return {"ok": True}


@app.get("/api/admin/domains/{domain_id}/renewals")
def admin_list_renewals(
    domain_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ประวัติการ renew ของ domain นี้ — ไม่ส่ง receipt_data เพื่อประหยัด bandwidth"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, domain_id, renewed_at, new_expire_date, old_expire_date, "
            "       receipt_name, receipt_type, "
            "       (receipt_data IS NOT NULL) AS has_receipt, "
            "       cost_amount, cost_currency, note "
            "FROM domain_renewals WHERE domain_id = ? "
            "ORDER BY renewed_at DESC",
            (domain_id,),
        ).fetchall()
    return {"renewals": [dict(r) for r in rows]}


@app.get("/api/admin/domains/renewals/{renewal_id}/receipt")
def admin_get_renewal_receipt(
    renewal_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ส่ง receipt_data ของ renewal เฉพาะตอนคลิกดู (lazy load)"""
    with db_conn() as conn:
        row = conn.execute(
            "SELECT receipt_data, receipt_name, receipt_type FROM domain_renewals WHERE id = ?",
            (renewal_id,),
        ).fetchone()
    if not row or not row["receipt_data"]:
        raise HTTPException(status_code=404, detail="receipt not found")
    return {
        "receipt_data": row["receipt_data"],
        "receipt_name": row["receipt_name"],
        "receipt_type": row["receipt_type"],
    }


@app.post("/api/admin/domains/{domain_id}/renew")
def admin_renew_domain(
    domain_id: int,
    payload: DomainRenewalIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """Renew domain — บันทึก renewal record + อัพเดท expire_date ใน domain"""
    now = utc_now().isoformat()
    with db_conn() as conn:
        domain = conn.execute(
            "SELECT id, expire_date FROM domains WHERE id = ?", (domain_id,)
        ).fetchone()
        if not domain:
            raise HTTPException(status_code=404, detail="domain not found")
        old_expire = domain["expire_date"]
        # Insert renewal record
        cur = conn.execute(
            "INSERT INTO domain_renewals("
            "  domain_id, renewed_at, new_expire_date, old_expire_date,"
            "  receipt_data, receipt_name, receipt_type,"
            "  cost_amount, cost_currency, note"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (domain_id, now, payload.new_expire_date, old_expire,
             payload.receipt_data or None, payload.receipt_name or None,
             payload.receipt_type or None,
             payload.cost_amount, payload.cost_currency or None, payload.note or None),
        )
        # Update domain's expire_date — and clear WHOIS sync timestamp
        # (this date now comes from a renewal record, not from WHOIS)
        conn.execute(
            "UPDATE domains SET expire_date = ?, expire_whois_synced_at = NULL WHERE id = ?",
            (payload.new_expire_date, domain_id),
        )
    return {"ok": True, "id": cur.lastrowid, "new_expire_date": payload.new_expire_date}


@app.delete("/api/admin/domains/renewals/{renewal_id}")
def admin_delete_renewal(
    renewal_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ลบ renewal record (ไม่ rollback expire_date — admin ต้องไปแก้เอง)"""
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM domain_renewals WHERE id = ?", (renewal_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="renewal not found")
    return {"ok": True}


# =============================================================================
# Services (hosting / ssl / others) + Websites (domain ↔ services pairing)
# =============================================================================

_VALID_SERVICE_TYPES = {"hosting", "ssl", "others"}
_VALID_HW_TYPES = {"pc", "device", "network"}


# =============================================================================
# Hardware (PC / Device / Network) + assignment history
# =============================================================================


class HardwareIn(BaseModel):
    hw_type: str = Field(..., min_length=1, max_length=20)
    name: str = Field(..., min_length=1, max_length=200)
    asset_number: Optional[str] = Field(None, max_length=80)
    purchased_at: Optional[str] = Field(None, max_length=40)   # ISO YYYY-MM-DD or YYYY-MM
    notes: Optional[str] = Field(None, max_length=2000)
    # PC — basic spec
    os: Optional[str] = Field(None, max_length=80)
    cpu: Optional[str] = Field(None, max_length=200)
    ram: Optional[str] = Field(None, max_length=120)
    storage: Optional[str] = Field(None, max_length=200)
    # PC — extended (v1.9.38)
    serial_number: Optional[str] = Field(None, max_length=120)
    display: Optional[str] = Field(None, max_length=200)
    department: Optional[str] = Field(None, max_length=120)
    location: Optional[str] = Field(None, max_length=200)
    os_version: Optional[str] = Field(None, max_length=120)
    model: Optional[str] = Field(None, max_length=200)
    mainboard: Optional[str] = Field(None, max_length=200)
    gpu: Optional[str] = Field(None, max_length=200)
    battery: Optional[str] = Field(None, max_length=200)
    ups: Optional[str] = Field(None, max_length=200)
    status: Optional[str] = Field(None, max_length=80)
    quotation: Optional[str] = Field(None, max_length=200)
    # Device
    device_subtype: Optional[str] = Field(None, max_length=120)
    capacity: Optional[str] = Field(None, max_length=120)
    # Owner
    current_member_id: Optional[int] = None
    # Photo (base64 data URL — JPEG ~640x480)
    photo_data: Optional[str] = Field(None, max_length=1_500_000)
    # v1.9.50 — รูปภาพหมายเลข asset (close-up sticker/tag)
    asset_photo_data: Optional[str] = Field(None, max_length=1_500_000)
    # v1.9.65 — สำหรับเครื่องที่ยังไม่มี owner: ระบุทีม/แผนกที่สังกัด + ตำแหน่งเก็บ
    unassigned_team_id: Optional[int] = None
    storage_location: Optional[str] = Field(None, max_length=200)
    # v1.9.245 — หมวดหมายเหตุ
    note_category: Optional[str] = Field(None, max_length=30)  # v1.9.292
    # v1.9.252 — เครื่องเป็นของพนักงานเอง (BYOD)
    is_personal_owned: bool = False
    for_new_position: bool = False        # v1.9.289
    is_handed_down: bool = False          # v1.9.290
    # v1.9.329 — สถานะคอมเก่าเมื่อได้รับเครื่องนี้
    old_pc_bought_by_employee: bool = False
    old_pc_broken: bool = False
    old_pc_donated_sold: bool = False

    @field_validator("hw_type")
    @classmethod
    def _check_type(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in _VALID_HW_TYPES:
            raise ValueError(f"hw_type ต้องเป็น {sorted(_VALID_HW_TYPES)}")
        return v


class HardwarePatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    asset_number: Optional[str] = Field(None, max_length=80)
    purchased_at: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=2000)
    os: Optional[str] = Field(None, max_length=80)
    cpu: Optional[str] = Field(None, max_length=200)
    ram: Optional[str] = Field(None, max_length=120)
    storage: Optional[str] = Field(None, max_length=200)
    # Extended PC fields (v1.9.38)
    serial_number: Optional[str] = Field(None, max_length=120)
    display: Optional[str] = Field(None, max_length=200)
    department: Optional[str] = Field(None, max_length=120)
    location: Optional[str] = Field(None, max_length=200)
    os_version: Optional[str] = Field(None, max_length=120)
    model: Optional[str] = Field(None, max_length=200)
    mainboard: Optional[str] = Field(None, max_length=200)
    gpu: Optional[str] = Field(None, max_length=200)
    battery: Optional[str] = Field(None, max_length=200)
    ups: Optional[str] = Field(None, max_length=200)
    status: Optional[str] = Field(None, max_length=80)
    quotation: Optional[str] = Field(None, max_length=200)
    device_subtype: Optional[str] = Field(None, max_length=120)
    capacity: Optional[str] = Field(None, max_length=120)
    # Owner change — `null` = clear owner, undefined (omitted) = no change
    current_member_id: Optional[int] = None
    # Photo: '' = clear, non-empty = set; omitted = unchanged
    photo_data: Optional[str] = Field(None, max_length=1_500_000)
    # v1.9.50 — รูปภาพหมายเลข asset: '' = clear, non-empty = set, omitted = unchanged
    asset_photo_data: Optional[str] = Field(None, max_length=1_500_000)
    # v1.9.65 — unlinked fields: null = clear, int/string = set, omitted = no change
    unassigned_team_id: Optional[int] = None
    storage_location: Optional[str] = Field(None, max_length=200)
    # v1.9.245 — หมวดหมายเหตุ
    note_category: Optional[str] = Field(None, max_length=30)  # v1.9.292
    # v1.9.252 — เครื่องเป็นของพนักงานเอง (BYOD): null = no change
    is_personal_owned: Optional[bool] = None
    for_new_position: Optional[bool] = None        # v1.9.289
    is_handed_down: Optional[bool] = None           # v1.9.290
    # v1.9.329 — สถานะคอมเก่า
    old_pc_bought_by_employee: Optional[bool] = None
    old_pc_broken: Optional[bool] = None
    old_pc_donated_sold: Optional[bool] = None
    _set_owner: bool = False    # internal flag (not used yet)


def _hardware_row_to_dict(r: sqlite3.Row, member_lookup: dict[int, dict] = None) -> dict:
    out = dict(r)
    if member_lookup is not None and r["current_member_id"]:
        m = member_lookup.get(r["current_member_id"])
        if m:
            out["current_member_label"] = m.get("display_name") or m.get("email")
            out["current_member_username"] = m.get("email")
    return out


# v1.9.291 — ประวัติสถานะคอมฯ
_HW_STATUS_FIELDS = ("note_category", "notes", "is_personal_owned", "for_new_position", "is_handed_down")


def _hw_actor_name(conn: sqlite3.Connection, sess: dict) -> str:
    """ชื่อผู้กรอก: member → display_name/email, super admin → username"""
    mid = sess.get("member_id")
    if mid:
        r = conn.execute("SELECT display_name, email FROM members WHERE id = ?", (mid,)).fetchone()
        if r and (r["display_name"] or r["email"]):
            return r["display_name"] or r["email"]
    return sess.get("username") or "ผู้ดูแลระบบ"


def _hw_log_status(conn: sqlite3.Connection, hw_id: int, snap: dict, actor: str) -> None:
    conn.execute(
        "INSERT INTO hardware_status_log(hardware_id, note_category, notes, is_personal_owned, "
        "for_new_position, is_handed_down, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (hw_id, snap.get("note_category"), snap.get("notes"),
         1 if snap.get("is_personal_owned") else 0, 1 if snap.get("for_new_position") else 0,
         1 if snap.get("is_handed_down") else 0, actor, utc_now().isoformat()),
    )


def _change_hardware_owner(conn: sqlite3.Connection, hw_id: int, new_member_id: Optional[int]) -> None:
    """ปิด assignment เก่า + เปิดใหม่ + อัพเดท current_member_id"""
    now = utc_now().isoformat()
    # ปิด active assignment เก่า (ที่ unassigned_at = NULL)
    conn.execute(
        "UPDATE hardware_assignments SET unassigned_at = ? "
        "WHERE hardware_id = ? AND unassigned_at IS NULL",
        (now, hw_id),
    )
    # เปิด assignment ใหม่ (ถ้ามี new owner)
    if new_member_id:
        m = conn.execute(
            "SELECT display_name, email FROM members WHERE id = ?",
            (new_member_id,),
        ).fetchone()
        member_label = (m["display_name"] or m["email"]) if m else None
        conn.execute(
            "INSERT INTO hardware_assignments(hardware_id, member_id, member_label, assigned_at) "
            "VALUES (?, ?, ?, ?)",
            (hw_id, new_member_id, member_label, now),
        )
    # อัพเดท current_member_id ใน hardware
    conn.execute(
        "UPDATE hardware SET current_member_id = ? WHERE id = ?",
        (new_member_id, hw_id),
    )


@app.get("/api/admin/hardware")
def admin_list_hardware(
    type: Optional[str] = None,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """รายการ hardware (filter ตาม type ได้)"""
    sql = "SELECT * FROM hardware"
    params: list[Any] = []
    if type:
        t = type.strip().lower()
        if t not in _VALID_HW_TYPES:
            raise HTTPException(status_code=400, detail=f"invalid type: {type}")
        sql += " WHERE hw_type = ?"
        params.append(t)
    sql += " ORDER BY name COLLATE NOCASE ASC"
    with db_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        members = conn.execute(
            "SELECT id, email, display_name FROM members"
        ).fetchall()
    member_lookup = {m["id"]: dict(m) for m in members}
    return {"hardware": [_hardware_row_to_dict(r, member_lookup) for r in rows]}


@app.post("/api/admin/hardware")
def admin_create_hardware(
    payload: HardwareIn,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    now = utc_now().isoformat()
    s = lambda v: (v.strip() if isinstance(v, str) else v) or None
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO hardware(hw_type, name, asset_number, purchased_at, notes, created_at, "
            "                     os, cpu, ram, storage, "
            "                     serial_number, display, department, location, os_version, model, "
            "                     mainboard, gpu, battery, ups, status, quotation, "
            "                     device_subtype, capacity, current_member_id, photo_data, asset_photo_data, "
            "                     unassigned_team_id, storage_location, note_category, is_personal_owned, for_new_position, is_handed_down, "
            "                     old_pc_bought_by_employee, old_pc_broken, old_pc_donated_sold) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                payload.hw_type,
                payload.name.strip(),
                s(payload.asset_number),
                payload.purchased_at or None,
                s(payload.notes),
                now,
                s(payload.os),
                s(payload.cpu),
                s(payload.ram),
                s(payload.storage),
                s(payload.serial_number),
                s(payload.display),
                s(payload.department),
                s(payload.location),
                s(payload.os_version),
                s(payload.model),
                s(payload.mainboard),
                s(payload.gpu),
                s(payload.battery),
                s(payload.ups),
                s(payload.status),
                s(payload.quotation),
                s(payload.device_subtype),
                s(payload.capacity),
                payload.current_member_id,
                payload.photo_data or None,
                payload.asset_photo_data or None,
                payload.unassigned_team_id,
                s(payload.storage_location),
                s(payload.note_category),
                1 if payload.is_personal_owned else 0,
                1 if payload.for_new_position else 0,
                1 if payload.is_handed_down else 0,
                1 if payload.old_pc_bought_by_employee else 0,
                1 if payload.old_pc_broken else 0,
                1 if payload.old_pc_donated_sold else 0,
            ),
        )
        hw_id = cur.lastrowid
        # ถ้ามี current_member_id → สร้าง initial assignment
        if payload.current_member_id:
            m = conn.execute(
                "SELECT display_name, email FROM members WHERE id = ?",
                (payload.current_member_id,),
            ).fetchone()
            member_label = (m["display_name"] or m["email"]) if m else None
            conn.execute(
                "INSERT INTO hardware_assignments(hardware_id, member_id, member_label, assigned_at) "
                "VALUES (?, ?, ?, ?)",
                (hw_id, payload.current_member_id, member_label, now),
            )
        # v1.9.291 — log baseline สถานะ (ถ้ามีหมายเหตุ/checkbox ตั้งแต่สร้าง)
        if payload.note_category or payload.notes or payload.is_personal_owned or payload.for_new_position or payload.is_handed_down:
            _hw_log_status(conn, hw_id, {
                "note_category": s(payload.note_category), "notes": s(payload.notes),
                "is_personal_owned": payload.is_personal_owned, "for_new_position": payload.for_new_position,
                "is_handed_down": payload.is_handed_down,
            }, _hw_actor_name(conn, _sess))
    return {"ok": True, "id": hw_id}


@app.patch("/api/admin/hardware/{hw_id}")
def admin_update_hardware(
    hw_id: int,
    payload: HardwarePatchIn,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """Update fields. ถ้า current_member_id เปลี่ยน → end old assignment + start new."""
    raw_body = payload.model_dump(exclude_unset=True)
    updates: dict[str, Any] = {}
    for f in ("name", "asset_number", "purchased_at", "notes", "os", "cpu", "ram",
              "storage", "device_subtype", "capacity",
              "serial_number", "display", "department", "location", "os_version",
              "model", "mainboard", "gpu", "battery", "ups", "status", "quotation",
              # v1.9.65 / v1.9.245
              "storage_location", "note_category"):
        if f in raw_body:
            v = raw_body[f]
            updates[f] = (v.strip() if isinstance(v, str) else v) or None
    # photo_data: '' = clear, non-empty = set, omitted = unchanged
    if "photo_data" in raw_body:
        v = raw_body["photo_data"]
        updates["photo_data"] = v if v else None
    # v1.9.50 — asset_photo_data: '' = clear, non-empty = set, omitted = unchanged
    if "asset_photo_data" in raw_body:
        v = raw_body["asset_photo_data"]
        updates["asset_photo_data"] = v if v else None
    # v1.9.65 — unassigned_team_id: null = clear, int = set, omitted = unchanged
    if "unassigned_team_id" in raw_body:
        updates["unassigned_team_id"] = raw_body["unassigned_team_id"]
    # v1.9.252 — is_personal_owned: bool → 0/1, omitted = unchanged
    if "is_personal_owned" in raw_body:
        updates["is_personal_owned"] = 1 if raw_body["is_personal_owned"] else 0
    # v1.9.289 — for_new_position
    if "for_new_position" in raw_body:
        updates["for_new_position"] = 1 if raw_body["for_new_position"] else 0
    # v1.9.290 — is_handed_down
    if "is_handed_down" in raw_body:
        updates["is_handed_down"] = 1 if raw_body["is_handed_down"] else 0
    # v1.9.329 — สถานะคอมเก่า
    for _fk in ("old_pc_bought_by_employee", "old_pc_broken", "old_pc_donated_sold"):
        if _fk in raw_body:
            updates[_fk] = 1 if raw_body[_fk] else 0

    with db_conn() as conn:
        existing = conn.execute("SELECT * FROM hardware WHERE id = ?", (hw_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="hardware not found")
        # Update fields
        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE hardware SET {set_clause} WHERE id = ?",
                list(updates.values()) + [hw_id],
            )
        # Owner change?
        if "current_member_id" in raw_body:
            new_owner = raw_body["current_member_id"]
            if new_owner != existing["current_member_id"]:
                _change_hardware_owner(conn, hw_id, new_owner)
        # v1.9.291 — บันทึกประวัติสถานะ (หมายเหตุ/checkbox) ถ้ามีการเปลี่ยน
        if any(f in raw_body for f in _HW_STATUS_FIELDS):
            eff = {f: updates.get(f, existing[f]) for f in _HW_STATUS_FIELDS}
            if any(eff[f] != existing[f] for f in _HW_STATUS_FIELDS):
                _hw_log_status(conn, hw_id, eff, _hw_actor_name(conn, _sess))
    return {"ok": True}


@app.get("/api/admin/hardware/{hw_id}/status-log")
def admin_hardware_status_log(hw_id: int, _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    """v1.9.291 — ประวัติสถานะ (หมายเหตุ + checkbox) ใหม่บนสุด · ถ้ายังไม่มี log → สังเคราะห์สถานะปัจจุบัน"""
    with db_conn() as conn:
        hw = conn.execute("SELECT * FROM hardware WHERE id = ?", (hw_id,)).fetchone()
        if not hw:
            raise HTTPException(status_code=404, detail="hardware not found")
        rows = conn.execute(
            "SELECT * FROM hardware_status_log WHERE hardware_id = ? ORDER BY id DESC", (hw_id,)
        ).fetchall()
        log = [dict(r) for r in rows]
        if not log:
            log = [{
                "id": None, "hardware_id": hw_id,
                "note_category": hw["note_category"], "notes": hw["notes"],
                "is_personal_owned": hw["is_personal_owned"], "for_new_position": hw["for_new_position"],
                "is_handed_down": hw["is_handed_down"],
                "created_by": None, "created_at": hw["created_at"], "synthetic": True,
            }]
    return {"log": log}


@app.delete("/api/admin/hardware/{hw_id}")
def admin_delete_hardware(
    hw_id: int,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM hardware WHERE id = ?", (hw_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="hardware not found")
    return {"ok": True}


@app.get("/api/admin/hardware/unassigned-pcs")
def admin_unassigned_pcs(_sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    """v1.9.68 — รายการ PC ทั้งหมดที่ไม่มี owner (คอมส่วนกลาง) — JOIN teams เพื่อ snapshot ชื่อ"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT h.*, t.name AS unassigned_team_name "
            "FROM hardware h "
            "LEFT JOIN teams t ON t.id = h.unassigned_team_id "
            "WHERE h.hw_type = 'pc' AND h.current_member_id IS NULL "
            "ORDER BY h.name COLLATE NOCASE ASC"
        ).fetchall()
    return {"hardware": [dict(r) for r in rows]}


# v1.9.312 — รายงานคอมที่ซื้อใหม่/เปลี่ยน: ตามวันสั่งซื้อ (purchased_at) — ตรงกับ dashboard ปฏิทินการซื้อ
@app.get("/api/admin/hardware/pc-replacement-report")
def admin_hardware_pc_replacement_report(
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """รายงาน PC ที่ซื้อใหม่ — 1 แถว ต่อ 1 PC (filter โดย purchased_at IS NOT NULL)

    total = จำนวน PC ที่มี purchased_at = ตรงกับ ปฏิทินการซื้อ ใน dashboard
    สำหรับแต่ละ PC จะแสดงคอมเดิมของเจ้าของปัจจุบัน — คือ PC อื่นที่คนคนนี้เคยได้รับ
    ก่อนหน้านี้ (assigned_at เก่ากว่าตอนได้รับ PC นี้) สูงสุด 3 เครื่อง"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT h.id, h.name, h.purchased_at, h.current_member_id, "
            "       m.display_name, m.email, m.avatar_data, m.temp_department, "
            "       m.replaces_member_id, "
            "       rm.display_name AS replaces_display_name, rm.email AS replaces_email "
            "FROM hardware h "
            "LEFT JOIN members m ON m.id = h.current_member_id "
            "LEFT JOIN members rm ON rm.id = m.replaces_member_id "
            "WHERE h.hw_type = 'pc' AND h.purchased_at IS NOT NULL "
            "  AND TRIM(h.purchased_at) != '' "
            "ORDER BY h.purchased_at DESC"
        ).fetchall()
        # (member, pc) → วันที่ assigned + unassigned + ชื่อ PC + เจ้าของปัจจุบัน
        asg_rows = conn.execute(
            "SELECT a.member_id, a.hardware_id, MIN(a.assigned_at) AS first_at, "
            "       MAX(a.unassigned_at) AS last_unassigned_at, "
            "       h.name AS hw_name, h.current_member_id "
            "FROM hardware_assignments a JOIN hardware h ON h.id = a.hardware_id "
            "WHERE h.hw_type = 'pc' AND a.member_id IS NOT NULL "
            "  AND a.assigned_at IS NOT NULL AND a.assigned_at != '' "
            "GROUP BY a.member_id, a.hardware_id"
        ).fetchall()
        # v1.9.315 — team (แผนก) ของ member ที่อยู่ในรายงาน
        team_rows = conn.execute(
            "SELECT tm.member_id, t.name "
            "FROM team_members tm JOIN teams t ON t.id = tm.team_id "
            "ORDER BY t.name COLLATE NOCASE"
        ).fetchall()

    member_pcs: dict[int, list[dict[str, Any]]] = {}
    for r in asg_rows:
        member_pcs.setdefault(r["member_id"], []).append({
            "hardware_id": r["hardware_id"],
            "first_at": r["first_at"] or "",
            "last_unassigned_at": r["last_unassigned_at"] or "",
            "hw_name": r["hw_name"] or "",
            "current_member_id": r["current_member_id"],
        })
    # เรียงตาม "เพิ่งสูญเสีย" → "ได้มาเร็วสุด" (เหมือน slide-out device-history)
    for mid in member_pcs:
        member_pcs[mid].sort(key=lambda x: (x["last_unassigned_at"], x["first_at"]), reverse=True)

    member_teams: dict[int, list[str]] = {}
    for r in team_rows:
        member_teams.setdefault(r["member_id"], []).append(r["name"])

    out: list[dict[str, Any]] = []
    years: set[int] = set()
    for r in rows:
        at = r["purchased_at"] or ""
        try:
            year = int(at[0:4])
            month = int(at[5:7])
        except (ValueError, TypeError):
            continue
        years.add(year)
        member_name = ""
        avatar = None
        teams_list: list[str] = []
        prev_pcs_list: list[dict[str, Any]] = []
        if r["current_member_id"]:
            member_name = r["display_name"] or r["email"] or ""
            avatar = r["avatar_data"]
            teams_list = member_teams.get(r["current_member_id"], [])
            if not teams_list and r["temp_department"]:
                teams_list = [r["temp_department"]]
            # v1.9.319 — "คอมเดิม" = PC ที่เคยถือ + ตอนนี้ไม่ใช่ของเขาแล้ว (align กับ slide-out)
            pcs = member_pcs.get(r["current_member_id"], [])
            for p in pcs:
                if p["hardware_id"] == r["id"]:
                    continue
                # ข้าม PC ที่ปัจจุบันยัง member คนเดียวกันถืออยู่ (parallel current)
                if p["current_member_id"] == r["current_member_id"]:
                    continue
                prev_pcs_list.append({"id": p["hardware_id"], "name": p["hw_name"]})
                if len(prev_pcs_list) >= 3:
                    break
        out.append({
            "year": year,
            "month": month,
            "purchased_at": at,
            "hardware_id": r["id"],
            "new_pc": r["name"] or "",
            "member_id": r["current_member_id"],
            "member_name": member_name,
            "member_email": r["email"] or "",
            "member_avatar": avatar,
            "member_teams": teams_list,
            "prev_pcs": prev_pcs_list,
            # v1.9.332 — พนักงานคนก่อน (alumni ที่ member นี้มาแทน)
            "replaces_member_id": r["replaces_member_id"],
            "replaces_member_name": r["replaces_display_name"] or r["replaces_email"] or None,
        })
    return {"events": out, "years": sorted(years, reverse=True)}


@app.get("/api/admin/hardware/{hw_id}/history")
def admin_hardware_history(
    hw_id: int,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """ประวัติการครอบครอง — เรียง assigned_at DESC"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, member_id, member_label, assigned_at, unassigned_at, note "
            "FROM hardware_assignments WHERE hardware_id = ? ORDER BY assigned_at DESC",
            (hw_id,),
        ).fetchall()
    return {"history": [dict(r) for r in rows]}


# v1.9.247 — เพิ่มประวัติการครอบครองเอง (manual) ว่าใครเคยถือเครื่องนี้
class HardwareAssignmentAddIn(BaseModel):
    member_id: int
    assigned_at: str = Field(..., max_length=40)
    unassigned_at: Optional[str] = Field(None, max_length=40)
    note: Optional[str] = Field(None, max_length=500)


@app.post("/api/admin/hardware/{hw_id}/history")
def admin_add_hardware_history(hw_id: int, payload: HardwareAssignmentAddIn,
                               _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM hardware WHERE id=?", (hw_id,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบอุปกรณ์")
        m = conn.execute("SELECT display_name, email FROM members WHERE id=?", (payload.member_id,)).fetchone()
        if not m:
            raise HTTPException(status_code=400, detail="member ไม่มีอยู่จริง")
        if not (payload.assigned_at or "").strip():
            raise HTTPException(status_code=400, detail="ต้องระบุวันที่เริ่มครอบครอง")
        conn.execute(
            "INSERT INTO hardware_assignments(hardware_id, member_id, member_label, assigned_at, unassigned_at, note) "
            "VALUES (?,?,?,?,?,?)",
            (hw_id, payload.member_id, m["display_name"] or m["email"],
             _normalize_assignment_ts(payload.assigned_at),
             _normalize_assignment_ts(payload.unassigned_at) if (payload.unassigned_at or "").strip() else None,
             (payload.note or "").strip() or None))
    return {"ok": True}


@app.get("/api/admin/members/{mid}/device-history")
def admin_member_device_history(mid: int, _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    """อุปกรณ์ที่ member นี้เคยถือแต่ปัจจุบันไม่ใช่ owner แล้ว + อยู่ที่ไหนตอนนี้"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT a.hardware_id, MAX(a.assigned_at) AS assigned_at, MAX(a.unassigned_at) AS unassigned_at, "
            "       h.name, h.model, h.hw_type, h.status, h.current_member_id, h.unassigned_team_id, h.storage_location, "
            "       cm.display_name AS cur_name, cm.email AS cur_email "
            "FROM hardware_assignments a JOIN hardware h ON h.id = a.hardware_id "
            "LEFT JOIN members cm ON cm.id = h.current_member_id "
            "WHERE a.member_id = ? AND a.unassigned_at IS NOT NULL "
            "  AND (h.current_member_id IS NULL OR h.current_member_id != ?) "
            "GROUP BY a.hardware_id ORDER BY MAX(a.unassigned_at) DESC",
            (mid, mid)).fetchall()
    prev = []
    for r in rows:
        if r["current_member_id"]:
            where = "อยู่กับ " + (r["cur_name"] or r["cur_email"] or "ผู้ใช้อื่น")
        elif r["status"] == "retired":
            where = "สำรอง"
        elif r["status"] == "decommissioned":
            where = "ปลดระวาง"
        else:
            where = "คอมส่วนกลาง" + (" · " + r["storage_location"] if r["storage_location"] else "")
        prev.append({
            "hardware_id": r["hardware_id"], "name": r["name"], "model": r["model"], "hw_type": r["hw_type"],
            "assigned_at": r["assigned_at"], "unassigned_at": r["unassigned_at"], "where_now": where,
            "current_member_id": r["current_member_id"], "status": r["status"],
        })
    return {"previous": prev}


# v1.9.261 — ใช้คอมพิวเตอร์ของตนเอง (member-level) สำหรับคนที่ไม่มีเครื่องบริษัท
class MemberOwnComputerIn(BaseModel):
    uses_own_computer: bool
    own_computer_info: Optional[str] = Field(None, max_length=300)


@app.get("/api/admin/members/{mid}/own-computer")
def admin_get_member_own_computer(mid: int, _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS))) -> dict[str, Any]:
    """v1.9.263 — รวม flag ส่วนตัว: own-computer + alumni (panel โหลดครั้งเดียว)
    v1.9.328 — เพิ่ม replaces_member_id + alumni list สำหรับ dropdown 'มาแทน'"""
    with db_conn() as conn:
        r = conn.execute(
            "SELECT uses_own_computer, own_computer_info, is_alumni, last_working_day, replaces_member_id "
            "FROM members WHERE id = ?", (mid,)
        ).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="member not found")
        alumni_rows = conn.execute(
            "SELECT id, display_name, email, avatar_data, last_working_day "
            "FROM members WHERE is_alumni = 1 AND id != ? "
            "ORDER BY (last_working_day IS NULL), last_working_day DESC, display_name COLLATE NOCASE ASC",
            (mid,),
        ).fetchall()
    return {
        "uses_own_computer": bool(r["uses_own_computer"]),
        "own_computer_info": r["own_computer_info"],
        "is_alumni": bool(r["is_alumni"]),
        "last_working_day": r["last_working_day"],
        "replaces_member_id": r["replaces_member_id"],
        "alumni_options": [
            {
                "id": a["id"],
                "display_name": a["display_name"] or a["email"] or f"member#{a['id']}",
                "avatar_data": a["avatar_data"],
                "last_working_day": a["last_working_day"],
            } for a in alumni_rows
        ],
    }


@app.patch("/api/admin/members/{mid}/own-computer")
def admin_set_member_own_computer(mid: int, payload: MemberOwnComputerIn,
                                  _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    info = (payload.own_computer_info or "").strip() or None
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        conn.execute(
            "UPDATE members SET uses_own_computer = ?, own_computer_info = ? WHERE id = ?",
            (1 if payload.uses_own_computer else 0, info, mid))
    return {"ok": True}


# v1.9.263 — Alumni (อดีตพนักงาน) + วันทำงานวันสุดท้าย
class MemberAlumniIn(BaseModel):
    is_alumni: bool
    last_working_day: Optional[str] = Field(None, max_length=20)   # ISO YYYY-MM-DD


@app.patch("/api/admin/members/{mid}/alumni")
def admin_set_member_alumni(mid: int, payload: MemberAlumniIn,
                            _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    lwd = (payload.last_working_day or "").strip() or None
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        conn.execute(
            "UPDATE members SET is_alumni = ?, last_working_day = ? WHERE id = ?",
            (1 if payload.is_alumni else 0, lwd, mid))
    return {"ok": True}


# v1.9.328 — บันทึกว่า member นี้มาแทนใคร (replace alumni)
class MemberReplacesIn(BaseModel):
    replaces_member_id: Optional[int] = None


# v1.9.332 — สร้าง alumni ใหม่ (temp staff + is_alumni=1) + ตั้ง replaces_member_id ให้ member นี้
class CreateReplacesAlumniIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    department: Optional[str] = Field(None, max_length=120)
    team_ids: Optional[list[int]] = None


@app.patch("/api/admin/members/{mid}/replaces")
def admin_set_member_replaces(mid: int, payload: MemberReplacesIn,
                              _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    rmid = payload.replaces_member_id
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        if rmid is not None:
            if rmid == mid:
                raise HTTPException(status_code=400, detail="cannot replace self")
            r = conn.execute("SELECT is_alumni FROM members WHERE id = ?", (rmid,)).fetchone()
            if not r:
                raise HTTPException(status_code=404, detail="target member not found")
            if not r["is_alumni"]:
                raise HTTPException(status_code=400, detail="target must be alumni")
        conn.execute("UPDATE members SET replaces_member_id = ? WHERE id = ?", (rmid, mid))
    return {"ok": True}


# v1.9.332 — สร้าง alumni ใหม่ (temp staff + is_alumni=1) ทันทีในการเลือกจาก dropdown 'มาแทน'
@app.post("/api/admin/members/{mid}/create-replaces")
def admin_create_replaces_alumni(mid: int, payload: CreateReplacesAlumniIn,
                                 _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    """สร้าง alumni ใหม่ (temp staff + is_alumni=1) และตั้งเป็น 'มาแทน' ของ member {mid} ในการเรียกครั้งเดียว"""
    now = utc_now().isoformat()
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="ต้องระบุชื่อ")
    dept = (payload.department or "").strip() or None
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
            raise HTTPException(status_code=404, detail="member not found")
        # 1) สร้าง temp-staff member (no phone)
        placeholder_phone = "nophone:" + secrets.token_hex(8)
        fake_uid = "temp:" + secrets.token_hex(12)
        cur = conn.execute(
            "INSERT INTO members(phone, firebase_uid, display_name, is_temp, temp_department, "
            "                    is_alumni, last_working_day, created_at) "
            "VALUES (?, ?, ?, 1, ?, 1, NULL, ?)",
            (placeholder_phone, fake_uid, name, dept, now),
        )
        new_id = cur.lastrowid
        # 2) เชื่อมกับทีม (ถ้าระบุ team_ids)
        team_ids = payload.team_ids or []
        for tid in team_ids:
            if isinstance(tid, int) and conn.execute("SELECT 1 FROM teams WHERE id = ?", (tid,)).fetchone():
                conn.execute(
                    "INSERT OR IGNORE INTO team_members(team_id, member_id, added_at) VALUES (?, ?, ?)",
                    (tid, new_id, now),
                )
        # 3) ตั้ง replaces_member_id ของ member {mid} = new_id
        conn.execute("UPDATE members SET replaces_member_id = ? WHERE id = ?", (new_id, mid))
    return {"ok": True, "id": new_id, "display_name": name}


# =============================================================================
# v1.9.278 — Workflow builder (n8n-style)
# =============================================================================
class WorkflowCreateIn(BaseModel):
    name: str = Field("Workflow ใหม่", max_length=200)
    department: Optional[str] = Field(None, max_length=120)


class WorkflowPatchIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    department: Optional[str] = Field(None, max_length=120)
    data: Optional[dict] = None                # {nodes:[], edges:[]}
    is_active: Optional[bool] = None


class WorkflowCollabIn(BaseModel):
    member_id: int


def _wf_actor(sess: dict) -> tuple[Optional[int], bool]:
    """คืน (member_id|None, is_admin)"""
    return sess.get("member_id"), (sess.get("role") == "admin")


def _wf_can_edit(conn, wf, member_id: Optional[int], is_admin: bool) -> bool:
    if is_admin:
        return True
    if member_id is None:
        return False
    if wf["creator_member_id"] == member_id:
        return True
    return bool(conn.execute(
        "SELECT 1 FROM workflow_collaborators WHERE workflow_id = ? AND member_id = ?",
        (wf["id"], member_id)).fetchone())


def _wf_member_brief(conn, mid: Optional[int]) -> Optional[dict]:
    if not mid:
        return None
    r = conn.execute("SELECT id, display_name, email, avatar_data FROM members WHERE id = ?", (mid,)).fetchone()
    if not r:
        return None
    tn = conn.execute(
        "SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.member_id = ? ORDER BY t.name LIMIT 1",
        (mid,)).fetchone()
    return {"id": r["id"], "name": r["display_name"] or r["email"] or ("member#" + str(mid)),
            "avatar": r["avatar_data"], "position": tn["name"] if tn else None}


def _wf_note_dict(conn, r) -> dict:
    author = _wf_member_brief(conn, r["member_id"]) if r["member_id"] else None
    return {"id": r["id"], "body": r["body"], "created_at": r["created_at"],
            "author": author, "author_name": author["name"] if author else "ผู้ดูแลระบบ"}


@app.get("/api/workflows")
def list_workflows(sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, is_admin = _wf_actor(sess)
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM workflows ORDER BY updated_at DESC").fetchall()
        out = []
        for w in rows:
            try:
                nc = len((_json.loads(w["data"] or "{}").get("nodes") or []))
            except Exception:
                nc = 0
            out.append({
                "id": w["id"], "name": w["name"], "department": w["department"],
                "is_active": bool(w["is_active"]), "updated_at": w["updated_at"], "node_count": nc,
                "creator": _wf_member_brief(conn, w["creator_member_id"]),
                "can_edit": _wf_can_edit(conn, w, member_id, is_admin),
            })
    return {"workflows": out}


@app.get("/api/my-workflows")
def my_workflows(sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    """workflow ที่เกี่ยวข้องกับ member นี้ — ผู้สร้าง / collaborator / ผู้รับผิดชอบใน task"""
    member_id, is_admin = _wf_actor(sess)
    if member_id is None:
        return {"workflows": []}
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM workflows ORDER BY updated_at DESC").fetchall()
        collab_wf = {r["workflow_id"] for r in conn.execute(
            "SELECT workflow_id FROM workflow_collaborators WHERE member_id = ?", (member_id,)).fetchall()}
        out = []
        for w in rows:
            rels = []
            if w["creator_member_id"] == member_id:
                rels.append("creator")
            if w["id"] in collab_wf:
                rels.append("collaborator")
            try:
                nodes = _json.loads(w["data"] or "{}").get("nodes") or []
                if any(isinstance(n, dict) and n.get("type") == "task" and n.get("assignee_id") == member_id for n in nodes):
                    rels.append("assignee")
                nc = len(nodes)
            except Exception:
                nc = 0
            if not rels:
                continue
            out.append({
                "id": w["id"], "name": w["name"], "department": w["department"],
                "is_active": bool(w["is_active"]), "updated_at": w["updated_at"], "node_count": nc,
                "relations": rels, "creator": _wf_member_brief(conn, w["creator_member_id"]),
                "can_edit": _wf_can_edit(conn, w, member_id, is_admin),
            })
    return {"workflows": out}


@app.post("/api/workflows")
def create_workflow(payload: WorkflowCreateIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, _ = _wf_actor(sess)
    now = utc_now().isoformat()
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO workflows(name, department, creator_member_id, data, created_at, updated_at) "
            "VALUES (?, ?, ?, '{\"nodes\":[],\"edges\":[]}', ?, ?)",
            ((payload.name or "Workflow ใหม่").strip(), (payload.department or "").strip() or None, member_id, now, now))
    return {"ok": True, "id": cur.lastrowid}


@app.get("/api/workflows/{wf_id}")
def get_workflow(wf_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, is_admin = _wf_actor(sess)
    with db_conn() as conn:
        w = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        if not w:
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        try:
            data = _json.loads(w["data"] or "{}")
        except Exception:
            data = {"nodes": [], "edges": []}
        collabs = [_wf_member_brief(conn, r["member_id"]) for r in conn.execute(
            "SELECT member_id FROM workflow_collaborators WHERE workflow_id = ?", (wf_id,)).fetchall()]
        latest = conn.execute(
            "SELECT * FROM workflow_notes WHERE workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", (wf_id,)).fetchone()
        notes_count = conn.execute("SELECT COUNT(*) AS n FROM workflow_notes WHERE workflow_id = ?", (wf_id,)).fetchone()["n"]
        return {
            "id": w["id"], "name": w["name"], "department": w["department"],
            "is_active": bool(w["is_active"]), "data": data,
            "creator": _wf_member_brief(conn, w["creator_member_id"]),
            "creator_member_id": w["creator_member_id"],
            "collaborators": [c for c in collabs if c],
            "can_edit": _wf_can_edit(conn, w, member_id, is_admin),
            "is_creator": is_admin or (member_id is not None and w["creator_member_id"] == member_id),
            "notes_latest": _wf_note_dict(conn, latest) if latest else None,
            "notes_count": notes_count,
        }


@app.patch("/api/workflows/{wf_id}")
def update_workflow(wf_id: int, payload: WorkflowPatchIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, is_admin = _wf_actor(sess)
    with db_conn() as conn:
        w = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        if not w:
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        if not _wf_can_edit(conn, w, member_id, is_admin):
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์แก้ไข workflow นี้")
        sets, vals = [], []
        if payload.name is not None:
            sets.append("name = ?"); vals.append((payload.name or "").strip() or "Workflow")
        if payload.department is not None:
            sets.append("department = ?"); vals.append((payload.department or "").strip() or None)
        if payload.is_active is not None:
            sets.append("is_active = ?"); vals.append(1 if payload.is_active else 0)
        if payload.data is not None:
            sets.append("data = ?"); vals.append(_json.dumps(payload.data, ensure_ascii=False))
        if sets:
            sets.append("updated_at = ?"); vals.append(utc_now().isoformat())
            conn.execute(f"UPDATE workflows SET {', '.join(sets)} WHERE id = ?", vals + [wf_id])
    return {"ok": True}


@app.delete("/api/workflows/{wf_id}")
def delete_workflow(wf_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, is_admin = _wf_actor(sess)
    with db_conn() as conn:
        w = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        if not w:
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        # เฉพาะผู้สร้าง (หรือ admin) ลบได้
        if not (is_admin or (member_id is not None and w["creator_member_id"] == member_id)):
            raise HTTPException(status_code=403, detail="เฉพาะผู้สร้างเท่านั้นที่ลบได้")
        conn.execute("DELETE FROM workflows WHERE id = ?", (wf_id,))
    return {"ok": True}


@app.post("/api/workflows/{wf_id}/collaborators")
def add_workflow_collaborator(wf_id: int, payload: WorkflowCollabIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, is_admin = _wf_actor(sess)
    with db_conn() as conn:
        w = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        if not w:
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        if not (is_admin or (member_id is not None and w["creator_member_id"] == member_id)):
            raise HTTPException(status_code=403, detail="เฉพาะผู้สร้างเท่านั้นที่เพิ่ม collaborator ได้")
        if not conn.execute("SELECT 1 FROM members WHERE id = ?", (payload.member_id,)).fetchone():
            raise HTTPException(status_code=400, detail="member ไม่มีอยู่จริง")
        conn.execute("INSERT OR IGNORE INTO workflow_collaborators(workflow_id, member_id, added_at) VALUES (?, ?, ?)",
                     (wf_id, payload.member_id, utc_now().isoformat()))
    return {"ok": True}


@app.delete("/api/workflows/{wf_id}/collaborators/{mid}")
def remove_workflow_collaborator(wf_id: int, mid: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, is_admin = _wf_actor(sess)
    with db_conn() as conn:
        w = conn.execute("SELECT * FROM workflows WHERE id = ?", (wf_id,)).fetchone()
        if not w:
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        if not (is_admin or (member_id is not None and w["creator_member_id"] == member_id)):
            raise HTTPException(status_code=403, detail="เฉพาะผู้สร้างเท่านั้นที่ลบ collaborator ได้")
        conn.execute("DELETE FROM workflow_collaborators WHERE workflow_id = ? AND member_id = ?", (wf_id, mid))
    return {"ok": True}


class WorkflowNoteIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=2000)


@app.get("/api/workflows/{wf_id}/notes")
def list_workflow_notes(wf_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM workflows WHERE id = ?", (wf_id,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        rows = conn.execute(
            "SELECT * FROM workflow_notes WHERE workflow_id = ? ORDER BY created_at DESC, id DESC", (wf_id,)).fetchall()
        return {"notes": [_wf_note_dict(conn, r) for r in rows]}


@app.post("/api/workflows/{wf_id}/notes")
def add_workflow_note(wf_id: int, payload: WorkflowNoteIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    member_id, _ = _wf_actor(sess)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="หมายเหตุห้ามว่าง")
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM workflows WHERE id = ?", (wf_id,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบ workflow")
        conn.execute("INSERT INTO workflow_notes(workflow_id, member_id, body, created_at) VALUES (?, ?, ?, ?)",
                     (wf_id, member_id, body, utc_now().isoformat()))
    return {"ok": True}


@app.get("/api/workflow-members")
def workflow_members(sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    """รายชื่อ member สำหรับเลือกผู้รับผิดชอบ / collaborator (id, name, avatar, position)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, display_name, email, avatar_data FROM members "
            "WHERE is_alumni = 0 ORDER BY display_name COLLATE NOCASE").fetchall()
        team_by_member = {}
        for r in conn.execute(
            "SELECT tm.member_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id ORDER BY t.name").fetchall():
            team_by_member.setdefault(r["member_id"], r["name"])
    return {"members": [{
        "id": r["id"], "name": r["display_name"] or r["email"] or ("member#" + str(r["id"])),
        "avatar": r["avatar_data"], "position": team_by_member.get(r["id"]),
    } for r in rows]}


# v1.9.64 — admin แก้ไข/ลบ record ประวัติการครอบครองได้
class HardwareAssignmentPatchIn(BaseModel):
    member_id: Optional[int] = None         # null = clear; omitted = no change
    member_label: Optional[str] = Field(None, max_length=200)
    assigned_at: Optional[str] = Field(None, max_length=40)    # ISO string หรือ YYYY-MM
    unassigned_at: Optional[str] = Field(None, max_length=40)  # '' = clear (= ปัจจุบัน)
    note: Optional[str] = Field(None, max_length=500)


@app.patch("/api/admin/hardware-assignments/{aid}")
def admin_update_hardware_assignment(
    aid: int,
    payload: HardwareAssignmentPatchIn,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """แก้ไขประวัติการครอบครอง — admin ปรับวันที่/หมายเหตุ/member ได้"""
    raw = payload.model_dump(exclude_unset=True)
    updates: dict[str, Any] = {}
    with db_conn() as conn:
        existing = conn.execute(
            "SELECT * FROM hardware_assignments WHERE id = ?", (aid,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="assignment not found")
        # member_id: null = clear; int = ตั้งใหม่ → re-snapshot member_label
        if "member_id" in raw:
            new_mid = raw["member_id"]
            updates["member_id"] = new_mid
            if new_mid is not None:
                m = conn.execute(
                    "SELECT display_name, email FROM members WHERE id = ?", (new_mid,)
                ).fetchone()
                if not m:
                    raise HTTPException(status_code=400, detail="member ไม่มีอยู่จริง")
                updates["member_label"] = m["display_name"] or m["email"]
            else:
                updates["member_label"] = None
        # member_label: ถ้าส่งมาเอง override (อาจ rare)
        if "member_label" in raw and "member_id" not in raw:
            updates["member_label"] = raw["member_label"]
        # assigned_at: ต้องไม่ว่าง (timestamp = required)
        if "assigned_at" in raw:
            v = raw["assigned_at"]
            if not v:
                raise HTTPException(status_code=400, detail="assigned_at ห้ามว่าง")
            updates["assigned_at"] = _normalize_assignment_ts(v)
        # unassigned_at: '' หรือ null = clear (= ปัจจุบัน), non-empty = ตั้งใหม่
        if "unassigned_at" in raw:
            v = raw["unassigned_at"]
            updates["unassigned_at"] = _normalize_assignment_ts(v) if v else None
        if "note" in raw:
            n = raw["note"]
            updates["note"] = (n.strip() if isinstance(n, str) else n) or None
        if not updates:
            raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE hardware_assignments SET {set_clause} WHERE id = ?",
            list(updates.values()) + [aid],
        )
    return {"ok": True}


def _normalize_assignment_ts(v: str) -> str:
    """รับ 'YYYY-MM' หรือ 'YYYY-MM-DD' หรือ ISO timestamp → คืน ISO format
    (วันที่ 1 ของเดือนถ้าให้มาแค่เดือน)"""
    s = str(v).strip()
    if not s:
        return s
    # 'YYYY-MM' → 'YYYY-MM-01T00:00:00+00:00'
    if len(s) == 7 and s[4] == "-":
        return f"{s}-01T00:00:00+00:00"
    # 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00+00:00'
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return f"{s}T00:00:00+00:00"
    return s


@app.delete("/api/admin/hardware-assignments/{aid}")
def admin_delete_hardware_assignment(
    aid: int,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """ลบ record ประวัติการครอบครอง — ไม่กระทบ hardware.current_member_id"""
    with db_conn() as conn:
        cur = conn.execute(
            "DELETE FROM hardware_assignments WHERE id = ?", (aid,)
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="assignment not found")
    return {"ok": True}


@app.get("/api/admin/members/{member_id}/hardware")
def admin_member_hardware(
    member_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """รายการ hardware ที่ member นี้ครอบครองอยู่ (current)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM hardware WHERE current_member_id = ? "
            "ORDER BY hw_type ASC, name COLLATE NOCASE ASC",
            (member_id,),
        ).fetchall()
    return {"hardware": [dict(r) for r in rows]}


# ----- Member-side: My Device -----
# v1.9.42 — สำหรับผู้ใช้ทั่วไปดูอุปกรณ์ของตัวเอง + อัพโหลดรูปได้
class MyHardwarePhotoIn(BaseModel):
    # photo_data: '' = clear, non-empty data URL = set
    photo_data: Optional[str] = Field(None, max_length=1_500_000)


@app.get("/api/my-hardware")
def my_hardware(
    sess: dict = Depends(require_admin_or_member),
) -> dict[str, Any]:
    """อุปกรณ์ทั้งหมดที่ผูกกับ current member — super admin (ไม่มี member_id) → list ว่าง"""
    member_id = sess.get("member_id")
    if not member_id:
        return {"hardware": []}
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM hardware WHERE current_member_id = ? "
            "ORDER BY hw_type ASC, name COLLATE NOCASE ASC",
            (member_id,),
        ).fetchall()
    return {"hardware": [dict(r) for r in rows]}


@app.patch("/api/my-hardware/{hw_id}/photo")
def my_hardware_update_photo(
    hw_id: int,
    payload: MyHardwarePhotoIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """Member อัพโหลด/ลบรูปอุปกรณ์ของตัวเอง — verify ownership ก่อน"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    with db_conn() as conn:
        existing = conn.execute(
            "SELECT current_member_id FROM hardware WHERE id = ?", (hw_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="hardware not found")
        if existing["current_member_id"] != member_id:
            raise HTTPException(status_code=403, detail="อุปกรณ์นี้ไม่ได้ผูกกับคุณ")
        new_photo = payload.photo_data if payload.photo_data else None
        conn.execute(
            "UPDATE hardware SET photo_data = ? WHERE id = ?",
            (new_photo, hw_id),
        )
    return {"ok": True}


# v1.9.252 — Member ระบุว่าเครื่องของตัวเองเป็น "คอมพิวเตอร์ของตนเอง" (BYOD)
class MyHardwarePersonalIn(BaseModel):
    is_personal_owned: bool


@app.patch("/api/my-hardware/{hw_id}/personal")
def my_hardware_set_personal(
    hw_id: int,
    payload: MyHardwarePersonalIn,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    """Member ติ๊ก/ยกเลิก 'คอมพิวเตอร์ของตนเอง' บนอุปกรณ์ของตัวเอง — verify ownership ก่อน"""
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    with db_conn() as conn:
        existing = conn.execute(
            "SELECT current_member_id FROM hardware WHERE id = ?", (hw_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="hardware not found")
        if existing["current_member_id"] != member_id:
            raise HTTPException(status_code=403, detail="อุปกรณ์นี้ไม่ได้ผูกกับคุณ")
        conn.execute(
            "UPDATE hardware SET is_personal_owned = ? WHERE id = ?",
            (1 if payload.is_personal_owned else 0, hw_id),
        )
    return {"ok": True}


# =============================================================================
# v1.9.76 — Financial Documents (เอกสารการสั่งซื้อ) + หลายหน้าต่อชุด
# =============================================================================

class FinDocIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=300)
    doc_date: Optional[str] = Field(None, max_length=20)  # ISO YYYY-MM-DD
    amount: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, max_length=10)
    vendor: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=2000)


class FinDocPatchIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=300)
    doc_date: Optional[str] = Field(None, max_length=20)
    amount: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, max_length=10)
    vendor: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=2000)
    tags: Optional[str] = Field(None, max_length=500)        # v1.9.301 — comma-separated


class FinDocPageIn(BaseModel):
    # v1.9.80 — เก็บภาพต้นฉบับ (no recompress); thumb_data แยกสำหรับ grid display
    image_data: str = Field(..., max_length=15_000_000)    # ภาพต้นฉบับ (~10MB binary = ~14M base64)
    thumb_data: Optional[str] = Field(None, max_length=400_000)  # thumb ~300px (~200-300KB binary)
    ocr_text: Optional[str] = Field(None, max_length=20000)


def _findoc_row(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "name": r["name"],
        "doc_date": r["doc_date"],
        "amount": r["amount"],
        "currency": r["currency"],
        "vendor": r["vendor"],
        "notes": r["notes"],
        "tags": (r["tags"] if "tags" in r.keys() else None) or "",
        "created_at": r["created_at"],
    }


@app.get("/api/admin/financial-documents")
def admin_list_findocs(_sess: dict = Depends(require_admin_or_modules("hw-findoc"))) -> dict[str, Any]:
    """List financial documents — รวม page_count + first_page_image (ใช้ thumb_data ถ้ามี ถอย fallback image_data)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT d.id, d.name, d.doc_date, d.amount, d.currency, d.vendor, d.notes, d.tags, "
            "  d.created_at, "
            "  (SELECT COUNT(*) FROM financial_document_pages WHERE document_id = d.id) AS page_count, "
            "  (SELECT COALESCE(thumb_data, image_data) FROM financial_document_pages WHERE document_id = d.id "
            "    ORDER BY page_order ASC, id ASC LIMIT 1) AS first_page_image "
            "FROM financial_documents d "
            "ORDER BY COALESCE(d.doc_date, d.created_at) DESC, d.id DESC"
        ).fetchall()
    return {"documents": [dict(r) for r in rows]}


@app.post("/api/admin/financial-documents")
def admin_create_findoc(
    payload: FinDocIn,
    _sess: dict = Depends(require_admin_or_modules("hw-findoc")),
) -> dict[str, Any]:
    now = utc_now().isoformat()
    s = lambda v: (v.strip() if isinstance(v, str) else v) or None
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO financial_documents(name, doc_date, amount, currency, vendor, notes, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                payload.name.strip(),
                s(payload.doc_date),
                payload.amount,
                s(payload.currency) or "THB",
                s(payload.vendor),
                s(payload.notes),
                now,
            ),
        )
    return {"ok": True, "id": cur.lastrowid}


@app.get("/api/admin/financial-documents/{doc_id}")
def admin_get_findoc(
    doc_id: int,
    _sess: dict = Depends(require_admin_or_modules("hw-findoc")),
) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            "SELECT * FROM financial_documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="document not found")
        pages = conn.execute(
            "SELECT id, page_order, image_data, thumb_data, ocr_text, created_at "
            "FROM financial_document_pages WHERE document_id = ? "
            "ORDER BY page_order ASC, id ASC",
            (doc_id,),
        ).fetchall()
    return {
        "document": _findoc_row(row),
        "pages": [dict(p) for p in pages],
    }


@app.patch("/api/admin/financial-documents/{doc_id}")
def admin_update_findoc(
    doc_id: int,
    payload: FinDocPatchIn,
    _sess: dict = Depends(require_admin_or_modules("hw-findoc")),
) -> dict[str, Any]:
    raw = payload.model_dump(exclude_unset=True)
    updates: dict[str, Any] = {}
    for f in ("name", "doc_date", "currency", "vendor", "notes"):
        if f in raw:
            v = raw[f]
            updates[f] = (v.strip() if isinstance(v, str) else v) or None
    # v1.9.301 — tags: normalize (trim/dedupe, comma-separated), '' = clear
    if "tags" in raw:
        parts = [t.strip() for t in (raw["tags"] or "").split(",")]
        seen, clean = set(), []
        for t in parts:
            if t and t.lower() not in seen:
                seen.add(t.lower()); clean.append(t)
        updates["tags"] = ",".join(clean) or None
    if "amount" in raw:
        updates["amount"] = raw["amount"]
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with db_conn() as conn:
        cur = conn.execute(
            f"UPDATE financial_documents SET {set_clause} WHERE id = ?",
            list(updates.values()) + [doc_id],
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="document not found")
    return {"ok": True}


@app.delete("/api/admin/financial-documents/{doc_id}")
def admin_delete_findoc(
    doc_id: int,
    _sess: dict = Depends(require_admin_or_modules("hw-findoc")),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM financial_documents WHERE id = ?", (doc_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="document not found")
    return {"ok": True}


@app.post("/api/admin/financial-documents/{doc_id}/pages")
def admin_add_findoc_page(
    doc_id: int,
    payload: FinDocPageIn,
    _sess: dict = Depends(require_admin_or_modules("hw-findoc")),
) -> dict[str, Any]:
    """เพิ่มหน้าใหม่ — page_order = max + 1 (auto)"""
    now = utc_now().isoformat()
    with db_conn() as conn:
        exists = conn.execute(
            "SELECT id FROM financial_documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="document not found")
        next_order_row = conn.execute(
            "SELECT COALESCE(MAX(page_order), -1) + 1 AS next_order "
            "FROM financial_document_pages WHERE document_id = ?",
            (doc_id,),
        ).fetchone()
        next_order = next_order_row["next_order"] if next_order_row else 0
        cur = conn.execute(
            "INSERT INTO financial_document_pages(document_id, page_order, image_data, thumb_data, ocr_text, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (doc_id, next_order, payload.image_data, payload.thumb_data, payload.ocr_text, now),
        )
    return {"ok": True, "id": cur.lastrowid, "page_order": next_order}


@app.delete("/api/admin/financial-document-pages/{page_id}")
def admin_delete_findoc_page(
    page_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute(
            "DELETE FROM financial_document_pages WHERE id = ?", (page_id,)
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="page not found")
    return {"ok": True}


# v1.9.82 — Hardware ↔ Financial Documents (M:N link)
class HwFinDocLinkIn(BaseModel):
    document_id: int


@app.get("/api/admin/hardware/{hw_id}/financial-documents")
def admin_list_hw_findocs(
    hw_id: int,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """Documents ที่ผูกกับ hardware นี้ (รวม thumb หน้าแรก + page_count)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT d.id, d.name, d.doc_date, d.amount, d.currency, d.vendor, "
            "  d.created_at, "
            "  (SELECT COUNT(*) FROM financial_document_pages WHERE document_id = d.id) AS page_count, "
            "  (SELECT COALESCE(thumb_data, image_data) FROM financial_document_pages WHERE document_id = d.id "
            "    ORDER BY page_order ASC, id ASC LIMIT 1) AS first_page_image "
            "FROM hardware_financial_documents hfd "
            "JOIN financial_documents d ON d.id = hfd.financial_document_id "
            "WHERE hfd.hardware_id = ? "
            "ORDER BY COALESCE(d.doc_date, d.created_at) DESC, d.id DESC",
            (hw_id,),
        ).fetchall()
    return {"documents": [dict(r) for r in rows]}


@app.post("/api/admin/hardware/{hw_id}/financial-documents")
def admin_link_hw_findoc(
    hw_id: int,
    payload: HwFinDocLinkIn,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    """ผูก financial document กับ hardware (M:N)"""
    now = utc_now().isoformat()
    with db_conn() as conn:
        # ตรวจ hardware + document มีจริง
        if not conn.execute("SELECT id FROM hardware WHERE id = ?", (hw_id,)).fetchone():
            raise HTTPException(status_code=404, detail="hardware not found")
        if not conn.execute(
            "SELECT id FROM financial_documents WHERE id = ?", (payload.document_id,)
        ).fetchone():
            raise HTTPException(status_code=404, detail="document not found")
        try:
            conn.execute(
                "INSERT INTO hardware_financial_documents(hardware_id, financial_document_id, created_at) "
                "VALUES (?, ?, ?)",
                (hw_id, payload.document_id, now),
            )
        except sqlite3.IntegrityError:
            # link มีอยู่แล้ว — ignore (idempotent)
            return {"ok": True, "already_linked": True}
    return {"ok": True}


@app.delete("/api/admin/hardware/{hw_id}/financial-documents/{doc_id}")
def admin_unlink_hw_findoc(
    hw_id: int,
    doc_id: int,
    _sess: dict = Depends(require_admin_or_modules(*_HW_MODULE_KEYS)),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute(
            "DELETE FROM hardware_financial_documents "
            "WHERE hardware_id = ? AND financial_document_id = ?",
            (hw_id, doc_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="link not found")
    return {"ok": True}


class ServiceIn(BaseModel):
    service_type: str = Field(..., min_length=1, max_length=20)
    name: str = Field(..., min_length=1, max_length=200)
    provider: Optional[str] = Field(None, max_length=120)
    price: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, max_length=10)
    expire_date: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=2000)

    @field_validator("service_type")
    @classmethod
    def _check_type(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in _VALID_SERVICE_TYPES:
            raise ValueError(f"service_type ต้องเป็น {sorted(_VALID_SERVICE_TYPES)}")
        return v


class ServicePatchIn(BaseModel):
    service_type: Optional[str] = Field(None, min_length=1, max_length=20)
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    provider: Optional[str] = Field(None, max_length=120)
    price: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, max_length=10)
    expire_date: Optional[str] = Field(None, max_length=40)
    notes: Optional[str] = Field(None, max_length=2000)

    @field_validator("service_type")
    @classmethod
    def _check_type(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = (v or "").strip().lower()
        if v not in _VALID_SERVICE_TYPES:
            raise ValueError(f"service_type ต้องเป็น {sorted(_VALID_SERVICE_TYPES)}")
        return v


@app.get("/api/admin/services")
def admin_list_services(
    type: Optional[str] = None,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """รายการ services (filter ตาม type ได้)"""
    sql = (
        "SELECT s.*, "
        "  (SELECT COUNT(*) FROM domain_services ds WHERE ds.service_id = s.id) AS linked_domains "
        "FROM services s"
    )
    params: list[Any] = []
    if type:
        type_norm = type.strip().lower()
        if type_norm not in _VALID_SERVICE_TYPES:
            raise HTTPException(status_code=400, detail=f"invalid type: {type}")
        sql += " WHERE service_type = ?"
        params.append(type_norm)
    sql += " ORDER BY expire_date ASC NULLS LAST, name COLLATE NOCASE ASC"
    with db_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {"services": [dict(r) for r in rows]}


@app.get("/api/admin/services/{service_id}/domains")
def admin_service_domains(service_id: int, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    """v1.9.269 — รายชื่อ domain ที่ผูกกับ service นี้"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT d.id, d.name, d.expire_date, d.provider "
            "FROM domain_services ds JOIN domains d ON d.id = ds.domain_id "
            "WHERE ds.service_id = ? ORDER BY d.name COLLATE NOCASE", (service_id,),
        ).fetchall()
    return {"domains": [dict(r) for r in rows]}


@app.post("/api/admin/services")
def admin_create_service(
    payload: ServiceIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO services(service_type, name, provider, price, currency, "
            "                     expire_date, notes, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                payload.service_type,
                payload.name.strip(),
                (payload.provider or "").strip() or None,
                payload.price,
                (payload.currency or "").strip() or None,
                payload.expire_date or None,
                (payload.notes or "").strip() or None,
                utc_now().isoformat(),
            ),
        )
    return {"ok": True, "id": cur.lastrowid}


@app.patch("/api/admin/services/{service_id}")
def admin_update_service(
    service_id: int,
    payload: ServicePatchIn,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if payload.service_type is not None: updates["service_type"] = payload.service_type
    if payload.name is not None:         updates["name"] = payload.name.strip()
    if payload.provider is not None:     updates["provider"] = payload.provider.strip() or None
    if payload.price is not None:        updates["price"] = payload.price
    if payload.currency is not None:     updates["currency"] = payload.currency.strip() or None
    if payload.expire_date is not None:  updates["expire_date"] = payload.expire_date or None
    if payload.notes is not None:        updates["notes"] = payload.notes.strip() or None
    if not updates:
        raise HTTPException(status_code=400, detail="ไม่มีอะไรให้บันทึก")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [service_id]
    with db_conn() as conn:
        cur = conn.execute(f"UPDATE services SET {set_clause} WHERE id = ?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="service not found")
    return {"ok": True}


@app.delete("/api/admin/services/{service_id}")
def admin_delete_service(
    service_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM services WHERE id = ?", (service_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="service not found")
    return {"ok": True}


# ---- Domain ↔ Service pairing (Website) ----

@app.post("/api/admin/domains/{domain_id}/services/{service_id}")
def admin_link_service(
    domain_id: int,
    service_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ผูก service กับ domain"""
    with db_conn() as conn:
        d = conn.execute("SELECT 1 FROM domains WHERE id = ?", (domain_id,)).fetchone()
        if not d:
            raise HTTPException(status_code=404, detail="domain not found")
        s = conn.execute("SELECT 1 FROM services WHERE id = ?", (service_id,)).fetchone()
        if not s:
            raise HTTPException(status_code=404, detail="service not found")
        try:
            conn.execute(
                "INSERT INTO domain_services(domain_id, service_id, created_at) VALUES (?, ?, ?)",
                (domain_id, service_id, utc_now().isoformat()),
            )
        except sqlite3.IntegrityError:
            # ผูกไว้แล้ว
            return {"ok": True, "already_linked": True}
    return {"ok": True}


@app.delete("/api/admin/domains/{domain_id}/services/{service_id}")
def admin_unlink_service(
    domain_id: int,
    service_id: int,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ยกเลิกการผูก service จาก domain"""
    with db_conn() as conn:
        cur = conn.execute(
            "DELETE FROM domain_services WHERE domain_id = ? AND service_id = ?",
            (domain_id, service_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="link not found")
    return {"ok": True}


def _websites_data(conn: sqlite3.Connection, admin: bool) -> list[dict[str, Any]]:
    """รวม domain + linked services เป็น 'website' entity"""
    domain_rows = conn.execute(
        "SELECT id, name, register_date, expire_date, provider, notes, logo_data "
        "FROM domains ORDER BY name COLLATE NOCASE ASC"
    ).fetchall()
    # Pre-load mappings
    link_rows = conn.execute("SELECT domain_id, service_id FROM domain_services").fetchall()
    services_by_id = {
        r["id"]: dict(r) for r in conn.execute(
            "SELECT * FROM services"
        ).fetchall()
    }
    links_by_domain: dict[int, list[int]] = {}
    for row in link_rows:
        links_by_domain.setdefault(row["domain_id"], []).append(row["service_id"])

    out: list[dict[str, Any]] = []
    for d in domain_rows:
        svc_ids = links_by_domain.get(d["id"], [])
        services = [services_by_id[sid] for sid in svc_ids if sid in services_by_id]
        # Group by type for convenient frontend rendering
        grouped: dict[str, list[dict[str, Any]]] = {"hosting": [], "ssl": [], "others": []}
        for s in services:
            t = s.get("service_type") or "others"
            grouped.setdefault(t, []).append(s)
        out.append({
            "domain": dict(d),
            "services": services,
            "by_type": grouped,
            "service_count": len(services),
        })
    return out


@app.get("/api/admin/websites")
def admin_list_websites(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    """รายการ websites = domain + services ที่ผูกอยู่"""
    with db_conn() as conn:
        websites = _websites_data(conn, admin=True)
    return {"websites": websites}


@app.get("/api/websites")
def list_websites_public(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """รายการ websites — เปิดให้ทุก logged-in user"""
    with db_conn() as conn:
        websites = _websites_data(conn, admin=False)
    return {"websites": websites}


# =============================================================================
# Domain lookup tools — nslookup / DNS records (admin only)
# =============================================================================

_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)"
    r"([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)+$"
)


def _sanitize_domain(name: str) -> str:
    """Strip protocol/port/path/'www.' prefix and validate as a domain name.

    Note: WHOIS/RDAP only resolve REGISTERED domains, not subdomains. We strip
    common 'www.' prefix automatically since users often paste full URLs.
    Other subdomains (mail., app., etc.) are kept — caller's responsibility.
    """
    n = (name or "").strip().lower()
    for prefix in ("https://", "http://"):
        if n.startswith(prefix):
            n = n[len(prefix):]
    n = n.split("/", 1)[0]
    n = n.split(":", 1)[0]
    n = n.rstrip(".")
    # Auto-strip leading "www." — common user mistake when typing full URLs
    while n.startswith("www."):
        n = n[4:]
    if not n or not _DOMAIN_RE.match(n):
        raise HTTPException(status_code=400, detail="invalid domain name")
    return n


# Try to import dnspython once at module load — pure-Python DNS, no external binary
try:
    import dns.resolver as _dns_resolver  # type: ignore
    import dns.reversename as _dns_reverse  # type: ignore
    import dns.exception as _dns_exc  # type: ignore
    _HAS_DNSPYTHON = True
except Exception:
    _HAS_DNSPYTHON = False

# python-whois — for WHOIS lookups
try:
    import whois as _whois  # type: ignore
    _HAS_WHOIS = True
except Exception:
    _HAS_WHOIS = False

# certifi — guarantees a working CA bundle for HTTPS RDAP requests
import ssl as _ssl
try:
    import certifi as _certifi  # type: ignore
    _SSL_CTX = _ssl.create_default_context(cafile=_certifi.where())
except Exception:
    _SSL_CTX = _ssl.create_default_context()


def _format_dnspython_record(rdata, record_type: str) -> str:
    """Format an rdata object the same way `dig +short` would print it."""
    s = rdata.to_text()
    # `to_text()` already gives canonical form for most types
    return s


def _query_dns_python(name: str, record_type: str) -> dict[str, Any]:
    """Use dnspython for a single record-type query."""
    try:
        resolver = _dns_resolver.Resolver()
        resolver.lifetime = 5.0
        resolver.timeout = 3.0
        answers = resolver.resolve(name, record_type, raise_on_no_answer=False)
        records = [_format_dnspython_record(r, record_type) for r in answers]
        return {"records": records, "raw": "\n".join(records), "error": None}
    except _dns_resolver.NXDOMAIN:
        return {"records": [], "raw": "", "error": "NXDOMAIN (domain ไม่มีอยู่)"}
    except _dns_resolver.NoAnswer:
        return {"records": [], "raw": "", "error": None}
    except _dns_resolver.NoNameservers:
        return {"records": [], "raw": "", "error": "no nameservers responded"}
    except _dns_exc.Timeout:
        return {"records": [], "raw": "", "error": "timeout"}
    except Exception as e:
        return {"records": [], "raw": "", "error": str(e)}


def _run_dig(name: str, record_type: str, *, extra_args: Optional[list[str]] = None) -> dict[str, Any]:
    """Resolve a single record type. Tries dnspython first → falls back to `dig` binary."""
    # Path 1: dnspython (preferred — no external binary needed)
    if _HAS_DNSPYTHON:
        return _query_dns_python(name, record_type)
    # Path 2: dig binary fallback
    dig = shutil.which("dig")
    if dig:
        args = [dig, "+short", "+timeout=3", "+tries=2"]
        if extra_args:
            args.extend(extra_args)
        args.extend([record_type, name])
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=8)
            raw = result.stdout
            records = [ln.strip() for ln in raw.strip().split("\n") if ln.strip()]
            err = result.stderr.strip() if result.returncode != 0 else None
            return {"records": records, "raw": raw, "error": err}
        except subprocess.TimeoutExpired:
            return {"records": [], "raw": "", "error": "timeout"}
        except Exception as e:
            return {"records": [], "raw": "", "error": str(e)}
    # Path 3: nothing available
    return {
        "records": [],
        "raw": "",
        "error": "DNS lookup unavailable — pip install dnspython (หรือลง dig บน server)",
    }


def _reverse_dns(ip: str) -> Optional[str]:
    """Reverse DNS lookup. Tries dnspython first → falls back to `dig -x`."""
    # Path 1: dnspython
    if _HAS_DNSPYTHON:
        try:
            ptr_name = _dns_reverse.from_address(ip)
            resolver = _dns_resolver.Resolver()
            resolver.lifetime = 3.0
            resolver.timeout = 2.0
            answers = resolver.resolve(ptr_name, "PTR")
            for r in answers:
                txt = r.to_text().rstrip(".")
                if txt:
                    return txt
        except Exception:
            return None
        return None
    # Path 2: dig binary fallback
    dig = shutil.which("dig")
    if not dig:
        return None
    try:
        result = subprocess.run(
            [dig, "+short", "+timeout=2", "+tries=1", "-x", ip],
            capture_output=True, text=True, timeout=5,
        )
        for ln in result.stdout.strip().split("\n"):
            ln = ln.strip().rstrip(".")
            if ln:
                return ln
    except Exception:
        return None
    return None


@app.get("/api/admin/domains/lookup/nslookup")
def admin_domain_nslookup(
    name: str,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """nslookup-style: resolve hostname → IPs + reverse DNS"""
    domain = _sanitize_domain(name)
    out: dict[str, Any] = {
        "domain": domain,
        "hostname": None,
        "aliases": [],
        "ips": [],
        "ipv6": [],
        "reverse": [],
        "error": None,
    }
    # IPv4 via socket.gethostbyname_ex (cross-platform, fast)
    try:
        hostname, aliases, ips = socket.gethostbyname_ex(domain)
        out["hostname"] = hostname
        out["aliases"] = aliases
        out["ips"] = ips
    except socket.gaierror as e:
        out["error"] = f"DNS resolution failed: {e}"
    except Exception as e:
        out["error"] = str(e)
    # IPv6 via getaddrinfo
    try:
        infos = socket.getaddrinfo(domain, None, socket.AF_INET6)
        seen = set()
        for info in infos:
            ip6 = info[4][0]
            if ip6 not in seen:
                seen.add(ip6)
                out["ipv6"].append(ip6)
    except Exception:
        pass
    # Reverse DNS for first few IPs (uses dig with timeout)
    for ip in out["ips"][:5]:
        out["reverse"].append({"ip": ip, "ptr": _reverse_dns(ip)})
    return out


@app.get("/api/admin/domains/lookup/dns")
def admin_domain_dns(
    name: str,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """ดึง DNS records (A, AAAA, CNAME, MX, NS, TXT, SOA)"""
    domain = _sanitize_domain(name)
    record_types = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA"]
    records: dict[str, Any] = {}
    for rt in record_types:
        records[rt] = _run_dig(domain, rt)
    return {"domain": domain, "records": records}


def _normalize_whois_value(v: Any) -> Any:
    """Convert WHOIS field values (datetime, list, str) to JSON-safe types."""
    if v is None:
        return None
    if isinstance(v, list):
        # Deduplicate while preserving order
        seen: set[str] = set()
        out: list[Any] = []
        for item in v:
            normalized = _normalize_whois_value(item)
            key = str(normalized)
            if key not in seen:
                seen.add(key)
                out.append(normalized)
        return out
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


# ---------------------------------------------------------------------------
# WHOIS / RDAP fallback helpers
#
# python-whois works for popular gTLDs (.com, .net, .org, .io, ...) but fails on:
#   - .co.th / .ac.th / etc. — THNIC's WHOIS uses non-standard keys ("Created date:" / "Exp date:")
#                              python-whois receives the raw text but its parser doesn't extract dates
#   - .mobi (and other newer TLDs) — registry has decommissioned port-43 WHOIS, only RDAP available
#
# Strategy:
#   1. Try python-whois (fast for ICANN-format gTLDs)
#   2. If raw_text exists but dates missing → re-parse with our pattern matcher (handles THNIC format)
#   3. If still no dates → try RDAP via rdap.org (works for most TLDs incl. .mobi + .co.th)
# ---------------------------------------------------------------------------

# Date-key patterns observed across registries (case-insensitive, exact prefix match)
_WHOIS_DATE_KEYS: dict[str, list[str]] = {
    "creation_date": [
        "created date", "creation date", "created on", "registered on",
        "registration date", "registered", "created", "registry creation date",
    ],
    "expiration_date": [
        "exp date", "expiration date", "expires", "expire date",
        "registry expiry date", "registrar registration expiration date",
        "registry expiration date", "expires on", "paid-till",
    ],
    "updated_date": [
        "updated date", "updated", "last modified", "last updated", "changed",
        "last update", "modified",
    ],
}

# Date format strings tried (in order)
_WHOIS_DATE_FORMATS: list[str] = [
    "%Y-%m-%dT%H:%M:%S%z",       # 2026-05-15T04:00:00+00:00
    "%Y-%m-%dT%H:%M:%SZ",        # 2026-05-15T04:00:00Z
    "%Y-%m-%dT%H:%M:%S",         # 2026-05-15T04:00:00
    "%Y-%m-%d %H:%M:%S",         # 2026-05-15 04:00:00
    "%Y-%m-%d",                  # 2026-05-15
    "%d %b %Y",                  # 17 Jan 1999  ← THNIC format
    "%d %B %Y",                  # 17 January 1999
    "%d-%b-%Y",                  # 17-Jan-1999
    "%d/%m/%Y",                  # 17/01/1999
    "%Y/%m/%d",                  # 1999/01/17
    "%Y.%m.%d",                  # 1999.01.17
]


def _parse_whois_loose_date(s: str) -> Optional[datetime]:
    """Try multiple date formats. Returns None if no format matches."""
    if not s:
        return None
    s = s.strip()
    # Cut off trailing notes/tz-words ("16 Jan 2035" or "16 Jan 2035 (UTC)")
    s = re.sub(r"\s+\([^)]*\)\s*$", "", s).strip()
    # Truncate at "  " (multiple spaces commonly separate value from comments)
    if "  " in s:
        s = s.split("  ", 1)[0].strip()
    for fmt in _WHOIS_DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _parse_whois_text(text: str) -> dict[str, Any]:
    """Re-parse raw WHOIS text — handles THNIC + other non-ICANN formats.
    Only fills fields not already set; extracts dates, registrar, name_servers."""
    out: dict[str, Any] = {}
    if not text:
        return out
    name_servers: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if not value:
            continue
        # Date fields
        for canonical, aliases in _WHOIS_DATE_KEYS.items():
            if canonical in out:
                continue
            if key in aliases:
                parsed = _parse_whois_loose_date(value)
                if parsed:
                    out[canonical] = parsed.isoformat()
                break
        # Registrar
        if "registrar" not in out and key in ("registrar", "sponsoring registrar"):
            out["registrar"] = value
        # Name servers (collect all, dedupe at the end)
        if key in ("name server", "nameserver", "nserver", "nservers"):
            ns = value.split()[0].lower().rstrip(".")
            if ns and ns not in name_servers:
                name_servers.append(ns)
    if name_servers:
        out["name_servers"] = name_servers
    return out


# Hardcoded TLD → WHOIS server map (faster than IANA roundtrip; covers TLDs
# where python-whois has known issues). Used by _whois_socket_query path.
_TLD_WHOIS_SERVERS: dict[str, str] = {
    "th":      "whois.thnic.co.th",
    "co.th":   "whois.thnic.co.th",
    "ac.th":   "whois.thnic.co.th",
    "or.th":   "whois.thnic.co.th",
    "in.th":   "whois.thnic.co.th",
    "go.th":   "whois.thnic.co.th",
    "net.th":  "whois.thnic.co.th",
    "id":      "whois.id",
    "co.id":   "whois.id",
    "ac.id":   "whois.id",
    "or.id":   "whois.id",
    "web.id":  "whois.id",
    "biz.id":  "whois.id",
    "my.id":   "whois.id",
    "vn":      "whois.vnnic.vn",
    "sg":      "whois.sgnic.sg",
    "com.sg":  "whois.sgnic.sg",
}
_TLD_WHOIS_CACHE: dict[str, Optional[str]] = {}


def _whois_socket_query(server: str, query: str, *, timeout: float = 10.0) -> str:
    """Direct WHOIS protocol (RFC 3912) — TCP port 43."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    chunks: list[bytes] = []
    try:
        sock.connect((server, 43))
        sock.sendall((query + "\r\n").encode())
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        try:
            sock.close()
        except Exception:
            pass
    return b"".join(chunks).decode("utf-8", errors="replace")


def _whois_server_for_domain(domain: str) -> Optional[str]:
    """Determine WHOIS port-43 server for a domain, using hardcoded map then IANA."""
    parts = domain.split(".")
    # Try longest TLD suffix first (e.g., "co.th" before "th")
    for i in range(len(parts) - 1):
        suffix = ".".join(parts[i + 1:])
        if suffix in _TLD_WHOIS_SERVERS:
            return _TLD_WHOIS_SERVERS[suffix]
        if suffix in _TLD_WHOIS_CACHE:
            return _TLD_WHOIS_CACHE[suffix]
    tld = parts[-1]
    if tld in _TLD_WHOIS_CACHE:
        return _TLD_WHOIS_CACHE[tld]
    # Ask IANA — match only same-line value (don't span newlines), and only if non-empty
    try:
        iana = _whois_socket_query("whois.iana.org", tld, timeout=5.0)
        server: Optional[str] = None
        for line in iana.splitlines():
            ml = re.match(r"(?i)^\s*whois:[ \t]*(\S+)[ \t]*$", line)
            if ml:
                server = ml.group(1)
                break
        _TLD_WHOIS_CACHE[tld] = server
        return server
    except Exception:
        _TLD_WHOIS_CACHE[tld] = None
        return None


_RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
_rdap_bootstrap_cache: Optional[dict[str, str]] = None   # tld(lower) → base URL


def _load_rdap_bootstrap() -> dict[str, str]:
    """Load + cache IANA's authoritative RDAP bootstrap (TLD → RDAP base URL).
    Caches forever after first success. Returns empty dict on failure."""
    global _rdap_bootstrap_cache
    if _rdap_bootstrap_cache is not None:
        return _rdap_bootstrap_cache
    try:
        req = urllib.request.Request(_RDAP_BOOTSTRAP_URL, headers={
            "User-Agent": "Mozilla/5.0 (compatible; fefl-beat WHOIS lookup)",
        })
        with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
        mapping: dict[str, str] = {}
        for service in data.get("services") or []:
            if not isinstance(service, list) or len(service) < 2:
                continue
            tlds = service[0] or []
            urls = service[1] or []
            if not urls or not tlds:
                continue
            base = str(urls[0]).rstrip("/")
            for tld in tlds:
                mapping[str(tld).lower()] = base
        _rdap_bootstrap_cache = mapping
        return mapping
    except Exception:
        _rdap_bootstrap_cache = {}    # cache the failure so we don't keep retrying within session
        return {}


def _parse_rdap_payload(payload: dict) -> dict[str, Any]:
    """Extract WHOIS-shaped fields from an RDAP JSON payload."""
    out: dict[str, Any] = {}
    # Events
    for event in payload.get("events") or []:
        action = (event.get("eventAction") or "").lower()
        date = event.get("eventDate")
        if not date:
            continue
        if action == "registration" and "creation_date" not in out:
            out["creation_date"] = date
        elif action == "expiration" and "expiration_date" not in out:
            out["expiration_date"] = date
        elif action in ("last changed", "last update") and "updated_date" not in out:
            out["updated_date"] = date
    # Registrar
    for ent in payload.get("entities") or []:
        if "registrar" not in (ent.get("roles") or []):
            continue
        vcard = ent.get("vcardArray")
        if isinstance(vcard, list) and len(vcard) >= 2 and isinstance(vcard[1], list):
            for item in vcard[1]:
                if isinstance(item, list) and len(item) >= 4 and item[0] == "fn" and item[3]:
                    out["registrar"] = item[3]
                    break
        if "registrar" in out:
            break
    # Nameservers
    nss: list[str] = []
    for ns in payload.get("nameservers") or []:
        ldh = ns.get("ldhName")
        if ldh:
            nss.append(ldh.lower())
    if nss:
        out["name_servers"] = nss
    # Status
    if payload.get("status"):
        out["status"] = payload["status"]
    return out


def _rdap_request(url: str, *, timeout: float = 10.0) -> tuple[Optional[dict], Optional[str]]:
    """HTTP GET to an RDAP endpoint. Returns (payload, error)."""
    req = urllib.request.Request(url, headers={
        "Accept": "application/rdap+json, application/json",
        "User-Agent": "Mozilla/5.0 (compatible; fefl-beat WHOIS lookup)",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            return _json.loads(resp.read().decode("utf-8", errors="replace")), None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, "404 (NXDOMAIN)"
        return None, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return None, f"network: {e.reason}"
    except Exception as e:
        return None, str(e)


def _rdap_lookup(domain: str, *, timeout: float = 10.0) -> dict[str, Any]:
    """Query RDAP for a domain. Tries TLD-authoritative server (from IANA bootstrap)
    first, then falls back to rdap.org aggregator. HTTPS only — works through firewalls
    that block port 43."""
    tld = domain.rsplit(".", 1)[-1].lower()
    bootstrap = _load_rdap_bootstrap()
    candidates: list[str] = []
    if tld in bootstrap:
        candidates.append(f"{bootstrap[tld]}/domain/{domain}")
    candidates.append(f"https://rdap.org/domain/{domain}")
    errors: list[str] = []
    for url in candidates:
        payload, err = _rdap_request(url, timeout=timeout)
        if err:
            errors.append(f"{url} → {err}")
            continue
        if not payload:
            continue
        parsed = _parse_rdap_payload(payload)
        if parsed.get("creation_date") or parsed.get("expiration_date") or parsed.get("registrar"):
            parsed["_source"] = "rdap"
            parsed["_url"] = url
            return parsed
        errors.append(f"{url} → empty payload")
    return {"_error": "RDAP: " + " | ".join(errors) if errors else "RDAP: ไม่พบ data"}


@app.get("/api/admin/domains/lookup/whois")
def admin_domain_whois(
    name: str,
    _sess: dict = Depends(require_admin),
) -> dict[str, Any]:
    """WHOIS lookup with multi-source fallback:
       1) python-whois  → 2) re-parse raw text  → 3) RDAP via rdap.org"""
    domain = _sanitize_domain(name)

    # Step 1: python-whois
    py_data: dict[str, Any] = {}
    raw_text: str = ""
    py_error: Optional[str] = None
    if _HAS_WHOIS:
        try:
            w = _whois.whois(domain)
            if w:
                raw_text = getattr(w, "text", "") or ""
                for k in ("domain_name", "registrar", "registrar_url", "referral_url",
                          "whois_server", "creation_date", "expiration_date",
                          "updated_date", "name_servers", "status", "emails",
                          "dnssec", "org", "country"):
                    val = w.get(k)
                    if val:
                        py_data[k] = val
        except Exception as e:
            py_error = str(e)

    # Step 2: re-parse raw_text for missing date fields (THNIC etc.)
    sources_used = ["python-whois"] if py_data or raw_text else []
    if raw_text:
        if not py_data.get("creation_date") or not py_data.get("expiration_date"):
            patched = _parse_whois_text(raw_text)
            for k, v in patched.items():
                if not py_data.get(k):
                    py_data[k] = v
            if patched:
                sources_used.append("raw-parser")

    # Step 3: direct socket WHOIS (port 43) fallback — for TLDs where
    # python-whois fails to resolve the WHOIS server (e.g., .id) or its CLI
    # shell-out can't connect. We do the connection ourselves using IANA bootstrap.
    socket_error: Optional[str] = None
    if not py_data.get("creation_date") or not py_data.get("expiration_date"):
        server = _whois_server_for_domain(domain)
        if server:
            try:
                socket_text = _whois_socket_query(server, domain, timeout=10.0)
                if socket_text and len(socket_text) > 50:   # got something substantive
                    if not raw_text:
                        raw_text = socket_text
                    else:
                        raw_text = raw_text + "\n\n--- (socket fallback from " + server + ") ---\n" + socket_text
                    patched = _parse_whois_text(socket_text)
                    added = False
                    for k, v in patched.items():
                        if not py_data.get(k):
                            py_data[k] = v
                            added = True
                    if added:
                        sources_used.append(f"socket-whois({server})")
            except Exception as e:
                socket_error = f"socket WHOIS to {server} failed: {e}"

    # Step 4: RDAP fallback if dates still missing
    rdap_error: Optional[str] = None
    if not py_data.get("creation_date") or not py_data.get("expiration_date"):
        rdap = _rdap_lookup(domain)
        if "_error" in rdap:
            rdap_error = rdap["_error"]
        else:
            for k, v in rdap.items():
                if k.startswith("_"):
                    continue
                if not py_data.get(k):
                    py_data[k] = v
            sources_used.append("rdap")

    # If all 4 paths produced nothing usable
    if not (py_data.get("registrar") or py_data.get("creation_date")
            or py_data.get("expiration_date") or py_data.get("name_servers")):
        details = []
        if py_error:     details.append(f"python-whois: {py_error}")
        if socket_error: details.append(socket_error)
        if rdap_error:   details.append(rdap_error)
        # Heuristic: 404/NXDOMAIN + 3+ parts → likely a subdomain.
        # Suggest the parent (registrable) domain as a candidate.
        all_404 = (
            ("404" in (rdap_error or "") or "NXDOMAIN" in (rdap_error or ""))
        ) and len(domain.split(".")) >= 3
        suggested = None
        if all_404:
            parts = domain.split(".")
            # Common ccTLDs use 2-label TLD ("co.th"); fall back to last 2 then last 3
            for n_keep in (2, 3):
                if len(parts) > n_keep:
                    suggested = ".".join(parts[-n_keep:])
                    break
        return {
            "domain": domain,
            "error": (
                "ไม่พบข้อมูล WHOIS หรือ RDAP สำหรับ domain นี้"
                + (f" — {' / '.join(details)}" if details else "")
                + (
                    f"\n\n💡 อาจเป็น subdomain — ลองใช้ \"{suggested}\" แทน"
                    if suggested else ""
                )
            ),
            "suggested_domain": suggested,
            "raw": (raw_text or "")[:5000] or None,
        }

    return {
        "domain": domain,
        "domain_name": _normalize_whois_value(py_data.get("domain_name")),
        "registrar": _normalize_whois_value(py_data.get("registrar")),
        "registrar_url": _normalize_whois_value(py_data.get("registrar_url") or py_data.get("referral_url")),
        "whois_server": _normalize_whois_value(py_data.get("whois_server")),
        "creation_date": _normalize_whois_value(py_data.get("creation_date")),
        "expiration_date": _normalize_whois_value(py_data.get("expiration_date")),
        "updated_date": _normalize_whois_value(py_data.get("updated_date")),
        "name_servers": _normalize_whois_value(py_data.get("name_servers")),
        "status": _normalize_whois_value(py_data.get("status")),
        "emails": _normalize_whois_value(py_data.get("emails")),
        "dnssec": _normalize_whois_value(py_data.get("dnssec")),
        "org": _normalize_whois_value(py_data.get("org")),
        "country": _normalize_whois_value(py_data.get("country")),
        "raw": raw_text[:5000] or None,
        "sources": sources_used,    # for debugging — UI can show ["python-whois","rdap"]
        "error": None,
    }


@app.get("/api/teams-overview")
def teams_overview(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """รายชื่อทีม + site_ids ที่แต่ละทีมเข้าถึงได้ — ใช้ใน Platforms page (spotlight)
    เปิดให้ทุก authenticated user เพื่อให้ member เห็นภาพรวมแผนกได้
    """
    with db_conn() as conn:
        teams = conn.execute(
            "SELECT id, name, description, "
            "  (SELECT COUNT(*) FROM team_members tm JOIN members m ON m.id = tm.member_id WHERE tm.team_id = t.id AND m.is_alumni = 0) AS member_count "
            "FROM teams t ORDER BY display_order ASC, name COLLATE NOCASE ASC"
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


@app.get("/api/hardware/pc-stats")
def hardware_pc_stats(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """v1.9.108 — สรุปจำนวน PC: total + แบ่งตาม ผูก/ไม่ผูก + แบ่งตาม OS (Windows/Mac/อื่นๆ)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT os, current_member_id, unassigned_team_id, storage_location, status "
            "FROM hardware WHERE hw_type = 'pc'"
        ).fetchall()
    total = len(rows)
    assigned = central = 0
    win = mac = other = 0
    for r in rows:
        if r["current_member_id"] is not None:
            assigned += 1
        elif (r["unassigned_team_id"] is not None
              or (r["storage_location"] and str(r["storage_location"]).strip() != "")
              or r["status"] == "stock"):
            central += 1                          # v1.9.233 — คอมส่วนกลาง (ระบุแล้ว แต่ยังไม่ผูก owner)
        os_v = (r["os"] or "").lower()
        if "win" in os_v:
            win += 1
        elif "mac" in os_v or "osx" in os_v or "os x" in os_v:
            mac += 1
        else:
            other += 1
    return {
        "total": total,
        # unassigned = ยังไม่ผูกจริง ๆ (ไม่รวมส่วนกลาง)
        "by_assignment": {"assigned": assigned, "central": central, "unassigned": total - assigned - central},
        "by_os": {"windows": win, "mac": mac, "other": other},
    }


@app.get("/api/members/registrations-by-date")
def members_registrations_by_date(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    """v1.9.106 — สรุปจำนวนสมาชิกทั้งหมด + จำนวนที่ลงทะเบียนรายวัน (กราฟเส้น dashboard)
    date group ตามเวลาไทย (+7 ชม.)"""
    with db_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM members").fetchone()[0]
        rows = conn.execute(
            "SELECT date(created_at, '+7 hours') AS d, COUNT(*) AS n "
            "FROM members WHERE created_at IS NOT NULL "
            "GROUP BY d ORDER BY d"
        ).fetchall()
    daily = [{"date": r["d"], "count": r["n"]} for r in rows if r["d"]]
    return {"total": total, "daily": daily}


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
            "       shirt_size, birthdate, wazzup_profile_url, "
            "       share_birthdate, share_shirt_size, share_phone, created_at, last_login_at "
            "FROM members WHERE id = ?",
            (sess["member_id"],),
        ).fetchone()
        if not row:
            return {"logged_in": False}
        member_profile = _member_row_to_profile(row)
        # v1.9.88 — แนบ login_methods + aliases เพื่อแสดง chips ใน 'บัญชีของฉัน'
        member_profile.update(_fetch_member_login_meta(conn, row["id"]))
        # v1.9.126 — จำนวนทีมที่ supervise (ใช้แสดง/ซ่อนเมนู Supervise)
        sup = conn.execute(
            "SELECT COUNT(*) AS n FROM member_supervised_teams WHERE member_id = ?",
            (row["id"],),
        ).fetchone()
        member_profile["supervised_count"] = sup["n"] if sup else 0
        # v1.9.162 — module ที่เข้าถึงได้ (สำหรับกรอง nav)
        member_profile["modules"] = _member_accessible_modules(conn, row["id"], bool(member_profile.get("is_admin")))
    return {"logged_in": True, "member": member_profile}


# v1.9.126 — Supervise (member-facing): ข้อมูลทีมที่ member นี้ดูแล
@app.get("/api/member/supervised")
def member_supervised(fct_member_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    with db_conn() as conn:
        team_ids = [r["team_id"] for r in conn.execute(
            "SELECT team_id FROM member_supervised_teams WHERE member_id = ?", (member_id,)
        ).fetchall()]
        if not team_ids:
            return {"teams": []}
        pl = ",".join("?" * len(team_ids))
        teams = conn.execute(
            f"SELECT id, name, description FROM teams WHERE id IN ({pl}) ORDER BY name COLLATE NOCASE",
            team_ids,
        ).fetchall()
        mem_rows = conn.execute(
            f"SELECT tm.team_id, m.id, m.display_name, m.email, m.phone, m.avatar_data, "
            f"       m.share_phone, m.birthdate, m.share_birthdate, m.is_alumni, m.last_working_day, "
            f"       m.uses_own_computer, m.own_computer_info, m.hr_employee_id "
            f"FROM team_members tm JOIN members m ON m.id = tm.member_id "
            f"WHERE tm.team_id IN ({pl}) ORDER BY m.display_name COLLATE NOCASE",
            team_ids,
        ).fetchall()
        site_rows = conn.execute(
            f"SELECT ts.team_id, s.id, s.name, s.url_pattern, s.logo_data "
            f"FROM team_sites ts JOIN sites s ON s.id = ts.site_id "
            f"WHERE ts.team_id IN ({pl}) ORDER BY s.name COLLATE NOCASE",
            team_ids,
        ).fetchall()
        # v1.9.156 — credential ที่ supervisor (member_id) เข้าถึงได้ แยกตาม site_id
        cred_rows = conn.execute(
            """
            SELECT DISTINCT c.site_id, c.username FROM credentials c
            JOIN (
                SELECT DISTINCT credential_id FROM (
                    SELECT c2.id AS credential_id
                    FROM team_sites ts JOIN team_members tm ON tm.team_id = ts.team_id
                    JOIN credentials c2 ON c2.site_id = ts.site_id
                    WHERE tm.member_id = ?
                    UNION
                    SELECT cm.credential_id FROM credential_members cm WHERE cm.member_id = ?
                )
            ) acc ON acc.credential_id = c.id
            WHERE c.site_id IS NOT NULL
            ORDER BY c.username COLLATE NOCASE
            """,
            (member_id, member_id),
        ).fetchall()
        creds_by_site: dict[int, list] = {}
        for cr in cred_rows:
            if cr["username"]:
                creds_by_site.setdefault(cr["site_id"], []).append(cr["username"])
        # v1.9.241 — คอมฯที่ผูกกับทีม: PC ของสมาชิก + คอมส่วนกลางของทีม
        _pc_cols = ("h.id, h.name, h.model, h.os, h.os_version, h.cpu, h.ram, h.storage, h.display, "
                    "h.purchased_at, h.status, h.is_personal_owned")
        pc_owned = conn.execute(
            f"SELECT tm.team_id, {_pc_cols}, h.current_member_id, m.display_name AS owner_name "
            f"FROM hardware h JOIN team_members tm ON tm.member_id = h.current_member_id "
            f"LEFT JOIN members m ON m.id = h.current_member_id "
            f"WHERE h.hw_type = 'pc' AND tm.team_id IN ({pl})",
            team_ids,
        ).fetchall()
        pc_central = conn.execute(
            f"SELECT h.unassigned_team_id AS team_id, {_pc_cols}, h.current_member_id, NULL AS owner_name "
            f"FROM hardware h "
            f"WHERE h.hw_type = 'pc' AND h.current_member_id IS NULL AND h.unassigned_team_id IN ({pl})",
            team_ids,
        ).fetchall()
    pcs_by_team: dict[int, list] = {}
    _seen_pc: set = set()
    for r in list(pc_owned) + list(pc_central):
        key = (r["team_id"], r["id"])
        if key in _seen_pc:
            continue
        _seen_pc.add(key)
        pcs_by_team.setdefault(r["team_id"], []).append({
            "id": r["id"], "name": r["name"], "model": r["model"], "os": r["os"], "os_version": r["os_version"],
            "cpu": r["cpu"], "ram": r["ram"], "storage": r["storage"], "display": r["display"],
            "purchased_at": r["purchased_at"], "status": r["status"],
            "is_personal_owned": r["is_personal_owned"],
            "current_member_id": r["current_member_id"], "owner_name": r["owner_name"],
        })
    mem_by_team: dict[int, list] = {}
    for r in mem_rows:
        ph = r["phone"]
        # v1.9.147 — ซ่อนเบอร์ถ้าเจ้าของตั้งเป็นส่วนตัว
        ph_out = None if (ph and (str(ph).startswith("email:") or str(ph).startswith("nophone:"))) else ph
        if _row_share(r, "share_phone") == 0:
            ph_out = None
        # v1.9.151 — birthdate (สำหรับ badge วันเกิด) — เคารพ privacy
        bday = r["birthdate"] if _row_share(r, "share_birthdate") == 1 else None
        mem_by_team.setdefault(r["team_id"], []).append({
            "id": r["id"], "display_name": r["display_name"], "email": r["email"],
            "phone": ph_out,
            "avatar_data": r["avatar_data"],
            "birthdate": bday,
            "is_alumni": bool(r["is_alumni"]),
            "last_working_day": r["last_working_day"],
            "uses_own_computer": bool(r["uses_own_computer"]),
            "own_computer_info": r["own_computer_info"],
            "hr_employee_id": r["hr_employee_id"],
        })
    site_by_team: dict[int, list] = {}
    for r in site_rows:
        site_by_team.setdefault(r["team_id"], []).append({
            "id": r["id"], "name": r["name"], "url_pattern": r["url_pattern"], "logo_data": r["logo_data"],
            "credentials": creds_by_site.get(r["id"], []),  # v1.9.156 — email ที่ใช้ login ได้
        })
    return {
        "teams": [
            {"id": t["id"], "name": t["name"], "description": t["description"],
             "members": mem_by_team.get(t["id"], []), "sites": site_by_team.get(t["id"], []),
             "pcs": pcs_by_team.get(t["id"], [])}
            for t in teams
        ]
    }


# v1.9.129 — Supervise: รายละเอียด member ที่ดูแล (Profile + Device) — เช็คสิทธิ์ว่าอยู่ในทีมที่ supervise
@app.get("/api/member/supervised/{target_id}")
def member_supervised_detail(
    target_id: int,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = _require_member_session(fct_member_session)
    member_id = sess["member_id"]
    with db_conn() as conn:
        sup_teams = {r["team_id"] for r in conn.execute(
            "SELECT team_id FROM member_supervised_teams WHERE member_id = ?", (member_id,)
        ).fetchall()}
        if not sup_teams:
            raise HTTPException(status_code=403, detail="คุณไม่ได้ดูแลทีมใด")
        target_teams_rows = conn.execute(
            "SELECT tm.team_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id "
            "WHERE tm.member_id = ?", (target_id,),
        ).fetchall()
        target_team_ids = {r["team_id"] for r in target_teams_rows}
        if not (sup_teams & target_team_ids):
            raise HTTPException(status_code=403, detail="คนนี้ไม่ได้อยู่ในทีมที่คุณดูแล")
        row = conn.execute(
            "SELECT id, phone, email, display_name, avatar_data, shirt_size, birthdate, "
            "       wazzup_emp_code, hr_name, hr_employee_id, "
            "       share_birthdate, share_shirt_size, share_phone, "
            "       created_at, last_login_at "
            "FROM members WHERE id = ?", (target_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ member")
        hw_rows = conn.execute(
            "SELECT id, hw_type, name, os, cpu, ram, storage, device_subtype, capacity, "
            "       model, serial_number, asset_number, photo_data "
            "FROM hardware WHERE current_member_id = ? "
            "ORDER BY hw_type ASC, name COLLATE NOCASE ASC", (target_id,),
        ).fetchall()
        # v1.9.265 — Previous Device: เครื่องที่เคยถือแต่ตอนนี้ไม่ใช่ของเขาแล้ว (member-side ไม่เผยชื่อเจ้าของใหม่)
        prev_rows = conn.execute(
            "SELECT a.hardware_id, MAX(a.assigned_at) AS assigned_at, MAX(a.unassigned_at) AS unassigned_at, "
            "       h.name, h.model, h.hw_type, h.status, h.current_member_id "
            "FROM hardware_assignments a JOIN hardware h ON h.id = a.hardware_id "
            "WHERE a.member_id = ? AND a.unassigned_at IS NOT NULL "
            "  AND (h.current_member_id IS NULL OR h.current_member_id != ?) "
            "GROUP BY a.hardware_id ORDER BY MAX(a.unassigned_at) DESC", (target_id, target_id),
        ).fetchall()
    ph = row["phone"]
    # v1.9.147 — เคารพ privacy: ผู้ดูแลเห็นเฉพาะข้อมูลที่เจ้าของยอมแชร์
    phone_val = None if (ph and str(ph).startswith("email:")) else ph
    if _row_share(row, "share_phone") == 0:
        phone_val = None
    shirt_val = row["shirt_size"] if _row_share(row, "share_shirt_size") == 1 else None
    birth_val = row["birthdate"] if _row_share(row, "share_birthdate") == 1 else None
    # เฉพาะทีมที่ผู้ขอ supervise ได้ (ไม่เปิดเผยทีมอื่น)
    visible_teams = [{"id": r["team_id"], "name": r["name"]} for r in target_teams_rows if r["team_id"] in sup_teams]
    prev_devices = []
    for r in prev_rows:
        if r["current_member_id"]:
            where = "ใช้งานโดยคนอื่นแล้ว"
        elif r["status"] == "retired":
            where = "สำรอง"
        elif r["status"] == "decommissioned":
            where = "ปลดระวาง"
        else:
            where = "คอมส่วนกลาง"
        prev_devices.append({
            "name": r["name"], "model": r["model"], "hw_type": r["hw_type"],
            "assigned_at": r["assigned_at"], "unassigned_at": r["unassigned_at"], "where_now": where,
        })
    return {
        "profile": {
            "id": row["id"],
            "display_name": row["display_name"],
            "phone": phone_val,
            "email": row["email"],
            "avatar_data": row["avatar_data"],
            "shirt_size": shirt_val,
            "birthdate": birth_val,
            "created_at": row["created_at"],
            "last_login_at": row["last_login_at"],
            "teams": visible_teams,
            "hr_name": row["hr_name"],
            "hr_employee_id": row["hr_employee_id"],
        },
        "devices": [dict(r) for r in hw_rows],
        "previous_devices": prev_devices,
    }


# v1.9.385 — admin แก้ไข ชื่อ/รหัสพนักงาน ตามระบบ HR ของ member
class HrInfoIn(BaseModel):
    hr_name: Optional[str] = Field(None, max_length=200)
    hr_employee_id: Optional[str] = Field(None, max_length=60)


@app.patch("/api/member/{target_id}/hr")
def member_update_hr(target_id: int, payload: HrInfoIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    hr_name = (payload.hr_name or "").strip() or None
    hr_emp = (payload.hr_employee_id or "").strip() or None
    with db_conn() as conn:
        row = conn.execute("SELECT id FROM members WHERE id = ?", (target_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ member")
        conn.execute(
            "UPDATE members SET hr_name = ?, hr_employee_id = ? WHERE id = ?",
            (hr_name, hr_emp, target_id),
        )
    return {"ok": True, "hr_name": hr_name, "hr_employee_id": hr_emp}


def _assert_supervises(conn, supervisor_id: int, target_id: int) -> None:
    """raise 403 ถ้า supervisor_id ไม่ได้ดูแลทีมที่ target_id อยู่"""
    sup_teams = {r["team_id"] for r in conn.execute(
        "SELECT team_id FROM member_supervised_teams WHERE member_id = ?", (supervisor_id,)
    ).fetchall()}
    if not sup_teams:
        raise HTTPException(status_code=403, detail="คุณไม่ได้ดูแลทีมใด")
    target_teams = {r["team_id"] for r in conn.execute(
        "SELECT team_id FROM team_members WHERE member_id = ?", (target_id,)
    ).fetchall()}
    if not (sup_teams & target_teams):
        raise HTTPException(status_code=403, detail="คนนี้ไม่ได้อยู่ในทีมที่คุณดูแล")


# v1.9.130 — Supervise: platform usage stats ของคนที่ดูแล
@app.get("/api/member/supervised/{target_id}/stats")
def member_supervised_stats(
    target_id: int,
    days: int = 30,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = _require_member_session(fct_member_session)
    days = max(1, min(365, days))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()
    with db_conn() as conn:
        _assert_supervises(conn, sess["member_id"], target_id)
        rows = conn.execute(
            """
            SELECT COALESCE(s.name, ul.site_name) AS site_name, s.url_pattern,
                   COUNT(ul.id) AS click_count, MAX(ul.timestamp) AS last_used_at
            FROM usage_logs ul LEFT JOIN sites s ON s.id = ul.site_id
            WHERE ul.member_id = ? AND ul.timestamp >= ?
            GROUP BY ul.site_id ORDER BY click_count DESC
            """,
            (target_id, cutoff),
        ).fetchall()
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM usage_logs WHERE member_id = ? AND timestamp >= ?",
            (target_id, cutoff),
        ).fetchone()
    return {
        "days": days,
        "total_clicks": total["n"] if total else 0,
        "platforms": [
            {"site_name": r["site_name"] or "(ลบแล้ว)", "url_pattern": r["url_pattern"],
             "click_count": r["click_count"], "last_used_at": r["last_used_at"]}
            for r in rows
        ],
    }


# v1.9.130 — Supervise: beacon check-in ของคนที่ดูแล (ใช้ Wazzup token ของผู้ดูแล)
@app.get("/api/member/supervised/{target_id}/beacon")
def member_supervised_beacon(
    target_id: int,
    request: Request,
    fct_member_session: Optional[str] = Cookie(default=None),
) -> dict[str, Any]:
    sess = _require_member_session(fct_member_session)
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="ต้องมี Wazzup Bearer token (login Wazzup ก่อน)")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Wazzup token ว่าง")
    with db_conn() as conn:
        _assert_supervises(conn, sess["member_id"], target_id)
        row = conn.execute("SELECT wazzup_emp_code FROM members WHERE id = ?", (target_id,)).fetchone()
    emp = (row["wazzup_emp_code"] if row and row["wazzup_emp_code"] else "").strip()
    if not emp:
        raise HTTPException(status_code=400, detail="คนนี้ยังไม่มี Wazzup empCode")
    try:
        data = _beacon_request(emp, token, timeout=12)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise HTTPException(status_code=401, detail="Wazzup token หมดอายุ — login ใหม่")
        if e.code == 403:
            raise HTTPException(status_code=403, detail="token ของคุณไม่มีสิทธิ์อ่าน check-in ของคนนี้")
        if e.code == 404:
            raise HTTPException(status_code=404, detail="ไม่พบใน Beacon")
        raise HTTPException(status_code=502, detail=f"โหลด Beacon ไม่สำเร็จ (HTTP {e.code})")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เชื่อมต่อ Beacon ไม่สำเร็จ: {e}")
    return {"ok": True, "checkInToday": data.get("checkInToday"), "checkInLastTime": data.get("checkInLastTime")}


# ===========================================================================
# v1.9.132 — Skill Marketplace
# ===========================================================================
class SkillIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=4000)
    category: str = Field("development", max_length=50)
    content: Optional[str] = Field(None, max_length=400_000)
    tags: Optional[str] = Field(None, max_length=500)
    file_name: Optional[str] = Field(None, max_length=300)
    file_data: Optional[str] = Field(None, max_length=12_000_000)
    file_mime: Optional[str] = Field(None, max_length=120)
    owner_member_id: Optional[int] = None
    uploader_member_id: Optional[int] = None   # v1.9.134 — เลือกผู้อัพโหลดได้


class SkillPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=4000)
    category: Optional[str] = Field(None, max_length=50)
    content: Optional[str] = Field(None, max_length=400_000)
    tags: Optional[str] = Field(None, max_length=500)
    owner_member_id: Optional[int] = None      # เปลี่ยนเจ้าของ
    uploader_member_id: Optional[int] = None   # v1.9.134 — เปลี่ยนผู้อัพโหลด


def _member_name_of(conn, mid: Optional[int]) -> Optional[str]:
    if mid is None:
        return None
    r = conn.execute("SELECT display_name, email, phone FROM members WHERE id = ?", (mid,)).fetchone()
    if not r:
        return None
    ph = r["phone"]
    return r["display_name"] or r["email"] or (None if (ph and str(ph).startswith("email:")) else ph) or f"member#{mid}"


def _skill_actor(conn, sess) -> tuple:
    """return (member_id|None, name, is_admin)"""
    if sess.get("role") == "admin":
        return (None, "Admin", True)
    mid = sess.get("member_id")
    row = conn.execute(
        "SELECT display_name, email, phone, is_admin FROM members WHERE id = ?", (mid,)
    ).fetchone()
    if not row:
        return (mid, f"member#{mid}", False)
    name = row["display_name"] or row["email"] or (None if (row["phone"] and str(row["phone"]).startswith("email:")) else row["phone"]) or f"member#{mid}"
    return (mid, name, bool(row["is_admin"]))


def _skill_can_edit(skill_row, actor_mid, is_admin) -> bool:
    if is_admin:
        return True
    return actor_mid is not None and skill_row["owner_member_id"] == actor_mid


@app.get("/api/skills")
def list_skills(category: Optional[str] = None, _auth: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    where, params = "", []
    if category:
        where = "WHERE category = ?"
        params.append(category)
    with db_conn() as conn:
        rows = conn.execute(
            f"SELECT id, name, description, category, tags, owner_name, uploader_name, "
            f"       download_count, (file_data IS NOT NULL) AS has_file, "
            f"       (SELECT avatar_data FROM members WHERE id = COALESCE(skills.owner_member_id, skills.uploader_member_id)) AS owner_avatar, "
            f"       (SELECT COUNT(*) FROM skill_examples e WHERE e.skill_id = skills.id) AS example_count, "
            f"       created_at, updated_at "
            f"FROM skills {where} ORDER BY created_at DESC",
            params,
        ).fetchall()
        cat_counts = {r["category"]: r["n"] for r in conn.execute(
            "SELECT category, COUNT(*) AS n FROM skills GROUP BY category"
        ).fetchall()}
        total = conn.execute("SELECT COUNT(*) AS n FROM skills").fetchone()["n"]
    return {
        "skills": [{**dict(r), "has_file": bool(r["has_file"])} for r in rows],
        "category_counts": cat_counts,
        "total": total,
    }


@app.get("/api/skills/{skill_id}")
def get_skill(skill_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ skill")
        actor_mid, _name, is_admin = _skill_actor(conn, sess)
    d = dict(row)
    d.pop("file_data", None)   # ไม่ส่ง base64 ใหญ่ใน detail (โหลดผ่าน /download)
    d["has_file"] = bool(row["file_data"])
    d["can_edit"] = _skill_can_edit(row, actor_mid, is_admin)
    return d


@app.post("/api/skills")
def create_skill(payload: SkillIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    now = utc_now().isoformat()
    with db_conn() as conn:
        actor_mid, actor_name, _is_admin = _skill_actor(conn, sess)
        # v1.9.134 — uploader/owner เลือกได้ (default = ผู้ทำรายการ)
        uploader_mid = payload.uploader_member_id if payload.uploader_member_id is not None else actor_mid
        uploader_name = _member_name_of(conn, payload.uploader_member_id) if payload.uploader_member_id is not None else actor_name
        owner_mid = payload.owner_member_id if payload.owner_member_id is not None else uploader_mid
        owner_name = _member_name_of(conn, payload.owner_member_id) if payload.owner_member_id is not None else uploader_name
        cur = conn.execute(
            "INSERT INTO skills(name, description, category, content, tags, file_name, file_data, file_mime, "
            " owner_member_id, owner_name, uploader_member_id, uploader_name, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (payload.name.strip(), (payload.description or "").strip() or None, payload.category,
             payload.content, (payload.tags or "").strip() or None,
             payload.file_name, payload.file_data, payload.file_mime,
             owner_mid, owner_name, uploader_mid, uploader_name, now, now),
        )
    return {"ok": True, "id": cur.lastrowid}


@app.patch("/api/skills/{skill_id}")
def update_skill(skill_id: int, payload: SkillPatch, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ skill")
        actor_mid, _name, is_admin = _skill_actor(conn, sess)
        if not _skill_can_edit(row, actor_mid, is_admin):
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์แก้ skill นี้ (เฉพาะเจ้าของ/admin)")
        updates: dict[str, Any] = {}
        for f in ("name", "description", "category", "content", "tags"):
            v = getattr(payload, f)
            if v is not None:
                updates[f] = v.strip() if isinstance(v, str) and f in ("name", "description", "tags") else v
        if payload.owner_member_id is not None:
            oname = _member_name_of(conn, payload.owner_member_id)
            if oname is None:
                raise HTTPException(status_code=400, detail="owner_member_id ไม่พบ")
            updates["owner_member_id"] = payload.owner_member_id
            updates["owner_name"] = oname
        if payload.uploader_member_id is not None:
            uname = _member_name_of(conn, payload.uploader_member_id)
            if uname is None:
                raise HTTPException(status_code=400, detail="uploader_member_id ไม่พบ")
            updates["uploader_member_id"] = payload.uploader_member_id
            updates["uploader_name"] = uname
        if updates:
            updates["updated_at"] = utc_now().isoformat()
            sc = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE skills SET {sc} WHERE id = ?", list(updates.values()) + [skill_id])
    return {"ok": True}


# v1.9.134 — รายชื่อ member สำหรับ picker (owner/uploader) — logged-in ทุกคนเรียกได้
# path แยกจาก /api/skills/{id} เพื่อเลี่ยง route conflict
@app.get("/api/skill-member-options")
def skill_member_options(_auth: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT m.id, m.display_name, m.email, m.phone, m.avatar_data, "
            "  (SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id "
            "   WHERE tm.member_id = m.id ORDER BY t.name COLLATE NOCASE LIMIT 1) AS team_name "
            "FROM members m WHERE COALESCE(m.enabled, 1) = 1 "
            "ORDER BY m.display_name COLLATE NOCASE"
        ).fetchall()
    out = []
    for r in rows:
        ph = r["phone"]
        out.append({
            "id": r["id"],
            "name": r["display_name"] or r["email"] or (None if (ph and str(ph).startswith("email:")) else ph) or f"member#{r['id']}",
            "team": r["team_name"],          # ทีม/แผนกที่สังกัด (ตัวแรก)
            "avatar": r["avatar_data"],      # รูปประจำตัว (data URL) — อาจเป็น None
        })
    return {"members": out}


# v1.9.135 — Skill categories (เพิ่ม/แก้ไขได้ — เฉพาะ admin)
class SkillCategoryIn(BaseModel):
    key: Optional[str] = Field(None, max_length=50)
    icon: Optional[str] = Field(None, max_length=16)
    label: str = Field(..., min_length=1, max_length=80)
    sort_order: Optional[int] = None


def _require_skill_admin(conn, sess) -> None:
    _mid, _name, is_admin = _skill_actor(conn, sess)
    if not is_admin:
        raise HTTPException(status_code=403, detail="เฉพาะ admin จัดการหมวดหมู่ได้")


@app.get("/api/skill-categories")
def list_skill_categories(_auth: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, key, icon, label, sort_order FROM skill_categories ORDER BY sort_order, label COLLATE NOCASE"
        ).fetchall()
    return {"categories": [dict(r) for r in rows]}


@app.post("/api/skill-categories")
def create_skill_category(payload: SkillCategoryIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    label = payload.label.strip()
    key = (payload.key or "").strip().lower()
    if not key:
        key = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "cat"
    if not re.fullmatch(r"[a-z0-9_-]+", key):
        raise HTTPException(status_code=400, detail="key ต้องเป็น a-z 0-9 _ - เท่านั้น")
    with db_conn() as conn:
        _require_skill_admin(conn, sess)
        if conn.execute("SELECT 1 FROM skill_categories WHERE key = ?", (key,)).fetchone():
            raise HTTPException(status_code=409, detail=f"key '{key}' มีอยู่แล้ว")
        mx = conn.execute("SELECT COALESCE(MAX(sort_order), 0) AS m FROM skill_categories").fetchone()["m"]
        conn.execute(
            "INSERT INTO skill_categories(key, icon, label, sort_order, created_at) VALUES (?,?,?,?,?)",
            (key, (payload.icon or "📦").strip(), label, (payload.sort_order if payload.sort_order is not None else mx + 1), utc_now().isoformat()),
        )
    return {"ok": True, "key": key}


@app.patch("/api/skill-categories/{cat_id}")
def update_skill_category(cat_id: int, payload: SkillCategoryIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        _require_skill_admin(conn, sess)
        if not conn.execute("SELECT 1 FROM skill_categories WHERE id = ?", (cat_id,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบหมวดหมู่")
        updates = {"label": payload.label.strip()}
        if payload.icon is not None:
            updates["icon"] = payload.icon.strip() or "📦"
        if payload.sort_order is not None:
            updates["sort_order"] = payload.sort_order
        sc = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE skill_categories SET {sc} WHERE id = ?", list(updates.values()) + [cat_id])
    return {"ok": True}


@app.delete("/api/skill-categories/{cat_id}")
def delete_skill_category(cat_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        _require_skill_admin(conn, sess)
        row = conn.execute("SELECT key FROM skill_categories WHERE id = ?", (cat_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบหมวดหมู่")
        n = conn.execute("SELECT COUNT(*) AS n FROM skills WHERE category = ?", (row["key"],)).fetchone()["n"]
        conn.execute("DELETE FROM skill_categories WHERE id = ?", (cat_id,))
    return {"ok": True, "affected_skills": n}


@app.delete("/api/skills/{skill_id}")
def delete_skill(skill_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ skill")
        actor_mid, _name, is_admin = _skill_actor(conn, sess)
        if not _skill_can_edit(row, actor_mid, is_admin):
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์ลบ skill นี้")
        conn.execute("DELETE FROM skill_examples WHERE skill_id = ?", (skill_id,))
        conn.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
    return {"ok": True}


@app.get("/api/skills/{skill_id}/download")
def download_skill(skill_id: int, _auth: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            "SELECT name, file_name, file_data, file_mime, content FROM skills WHERE id = ?", (skill_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ skill")
        conn.execute("UPDATE skills SET download_count = download_count + 1 WHERE id = ?", (skill_id,))
    if row["file_data"]:
        return {"file_name": row["file_name"] or f"{row['name']}.txt", "file_data": row["file_data"],
                "mime": row["file_mime"] or "application/octet-stream"}
    # ไม่มีไฟล์แนบ → ดาวน์โหลด content เป็น SKILL.md
    import base64 as _b
    content = row["content"] or ""
    return {"file_name": "SKILL.md", "mime": "text/markdown",
            "file_data": "data:text/markdown;base64," + _b.b64encode(content.encode("utf-8")).decode("ascii")}


# v1.9.133 — Skill examples (prompt + ผลลัพธ์เป็นไฟล์)
class SkillExampleIn(BaseModel):
    prompt: Optional[str] = Field(None, max_length=20000)
    result_filename: Optional[str] = Field(None, max_length=300)
    result_mime: Optional[str] = Field(None, max_length=120)
    result_data: Optional[str] = Field(None, max_length=12_000_000)


@app.get("/api/skills/{skill_id}/examples")
def list_skill_examples(skill_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        skill = conn.execute("SELECT owner_member_id FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if not skill:
            raise HTTPException(status_code=404, detail="ไม่พบ skill")
        rows = conn.execute(
            "SELECT id, prompt, result_filename, result_mime, creator_member_id, creator_name, created_at, "
            "(result_data IS NOT NULL) AS has_result FROM skill_examples WHERE skill_id = ? ORDER BY created_at ASC",
            (skill_id,),
        ).fetchall()
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
    out = []
    for r in rows:
        can_del = is_admin or (actor_mid is not None and (r["creator_member_id"] == actor_mid or skill["owner_member_id"] == actor_mid))
        mime = r["result_mime"] or ""
        out.append({
            "id": r["id"], "prompt": r["prompt"],
            "result_filename": r["result_filename"], "result_mime": r["result_mime"],
            "creator_name": r["creator_name"], "created_at": r["created_at"],
            "has_result": bool(r["has_result"]), "is_image": mime.startswith("image/"),
            "can_delete": can_del,
        })
    return {"examples": out}


@app.post("/api/skills/{skill_id}/examples")
def create_skill_example(skill_id: int, payload: SkillExampleIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    if not (payload.prompt and payload.prompt.strip()) and not payload.result_data:
        raise HTTPException(status_code=400, detail="ต้องมี prompt หรือไฟล์ผลลัพธ์อย่างน้อยอย่างใดอย่างหนึ่ง")
    now = utc_now().isoformat()
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM skills WHERE id = ?", (skill_id,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบ skill")
        actor_mid, actor_name, _ = _skill_actor(conn, sess)
        cur = conn.execute(
            "INSERT INTO skill_examples(skill_id, prompt, result_filename, result_mime, result_data, "
            " creator_member_id, creator_name, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (skill_id, (payload.prompt or "").strip() or None, payload.result_filename,
             payload.result_mime, payload.result_data, actor_mid, actor_name, now),
        )
    return {"ok": True, "id": cur.lastrowid}


@app.delete("/api/skills/{skill_id}/examples/{ex_id}")
def delete_skill_example(skill_id: int, ex_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        ex = conn.execute("SELECT creator_member_id FROM skill_examples WHERE id = ? AND skill_id = ?", (ex_id, skill_id)).fetchone()
        if not ex:
            raise HTTPException(status_code=404, detail="ไม่พบ example")
        skill = conn.execute("SELECT owner_member_id FROM skills WHERE id = ?", (skill_id,)).fetchone()
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
        ok = is_admin or (actor_mid is not None and (ex["creator_member_id"] == actor_mid or (skill and skill["owner_member_id"] == actor_mid)))
        if not ok:
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์ลบ example นี้")
        conn.execute("DELETE FROM skill_examples WHERE id = ?", (ex_id,))
    return {"ok": True}


@app.get("/api/skills/{skill_id}/examples/{ex_id}/result")
def skill_example_result(skill_id: int, ex_id: int, _auth: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        r = conn.execute(
            "SELECT result_filename, result_mime, result_data FROM skill_examples WHERE id = ? AND skill_id = ?",
            (ex_id, skill_id),
        ).fetchone()
    if not r or not r["result_data"]:
        raise HTTPException(status_code=404, detail="ไม่มีไฟล์ผลลัพธ์")
    return {"file_name": r["result_filename"] or "result", "mime": r["result_mime"] or "application/octet-stream",
            "file_data": r["result_data"]}


# ===========================================================================
# v1.9.143 — AI Project (gallery เว็บ AI — โครงคล้าย Skill Marketplace)
# ===========================================================================
class AiProjectIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    url: Optional[str] = Field(None, max_length=1000)
    description: Optional[str] = Field(None, max_length=4000)
    department: Optional[str] = Field(None, max_length=120)
    tags: Optional[str] = Field(None, max_length=500)
    image_data: Optional[str] = Field(None, max_length=3_000_000)
    started_month: Optional[str] = Field(None, max_length=7)   # 'YYYY-MM'
    owner_member_id: Optional[int] = None
    creator_member_id: Optional[int] = None
    creator_unspecified: Optional[bool] = None   # v1.9.144 — ผู้สร้าง = ไม่ระบุ


class AiProjectPatch(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    url: Optional[str] = Field(None, max_length=1000)
    description: Optional[str] = Field(None, max_length=4000)
    department: Optional[str] = Field(None, max_length=120)
    tags: Optional[str] = Field(None, max_length=500)
    image_data: Optional[str] = Field(None, max_length=3_000_000)
    started_month: Optional[str] = Field(None, max_length=7)
    owner_member_id: Optional[int] = None
    creator_member_id: Optional[int] = None
    creator_unspecified: Optional[bool] = None   # v1.9.144 — ตั้งผู้สร้าง = ไม่ระบุ


class AiProjectPinIn(BaseModel):
    pinned: bool


def _aiproj_can_edit(row, actor_mid, is_admin) -> bool:
    if is_admin:
        return True
    return actor_mid is not None and row["owner_member_id"] == actor_mid


@app.get("/api/ai-projects")
def list_ai_projects(sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
        rows = conn.execute(
            "SELECT id, title, url, description, department, tags, image_data, started_month, "
            "  owner_name, creator_name, owner_member_id, pinned, pinned_at, "
            "  (SELECT avatar_data FROM members WHERE id = COALESCE(ai_projects.owner_member_id, ai_projects.creator_member_id)) AS owner_avatar, "
            "  created_at, updated_at "
            "FROM ai_projects "
            "ORDER BY pinned DESC, COALESCE(pinned_at,'') DESC, COALESCE(started_month,'') DESC, created_at DESC"
        ).fetchall()
        dept_counts: dict[str, int] = {}
        for r in conn.execute(
            "SELECT COALESCE(NULLIF(TRIM(department),''),'(ไม่ระบุแผนก)') AS d, COUNT(*) AS n FROM ai_projects GROUP BY d"
        ).fetchall():
            dept_counts[r["d"]] = r["n"]
        total = conn.execute("SELECT COUNT(*) AS n FROM ai_projects").fetchone()["n"]
    projects = []
    for r in rows:
        d = dict(r)
        d["can_edit"] = _aiproj_can_edit(r, actor_mid, is_admin)
        d["pinned"] = bool(d.get("pinned"))
        projects.append(d)
    return {"projects": projects, "department_counts": dept_counts, "total": total}


@app.get("/api/ai-projects/{proj_id}")
def get_ai_project(proj_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM ai_projects WHERE id = ?", (proj_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ AI Project")
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
    d = dict(row)
    d["can_edit"] = _aiproj_can_edit(row, actor_mid, is_admin)
    d["pinned"] = bool(d.get("pinned"))
    return d


@app.post("/api/ai-projects")
def create_ai_project(payload: AiProjectIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    now = utc_now().isoformat()
    with db_conn() as conn:
        actor_mid, actor_name, _is_admin = _skill_actor(conn, sess)
        # v1.9.144 — creator เลือก "ไม่ระบุ" ได้
        if payload.creator_unspecified:
            creator_mid, creator_name = None, None
        elif payload.creator_member_id is not None:
            creator_mid = payload.creator_member_id
            creator_name = _member_name_of(conn, payload.creator_member_id)
        else:
            creator_mid, creator_name = actor_mid, actor_name
        if payload.owner_member_id is not None:
            owner_mid = payload.owner_member_id
            owner_name = _member_name_of(conn, payload.owner_member_id)
        else:
            owner_mid, owner_name = creator_mid, creator_name
        cur = conn.execute(
            "INSERT INTO ai_projects(title, url, description, department, tags, image_data, started_month, "
            " owner_member_id, owner_name, creator_member_id, creator_name, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (payload.title.strip(), (payload.url or "").strip() or None, (payload.description or "").strip() or None,
             (payload.department or "").strip() or None, (payload.tags or "").strip() or None,
             payload.image_data, (payload.started_month or "").strip() or None,
             owner_mid, owner_name, creator_mid, creator_name, now, now),
        )
    return {"ok": True, "id": cur.lastrowid}


@app.patch("/api/ai-projects/{proj_id}")
def update_ai_project(proj_id: int, payload: AiProjectPatch, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM ai_projects WHERE id = ?", (proj_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ AI Project")
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
        if not _aiproj_can_edit(row, actor_mid, is_admin):
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์แก้ไข AI Project นี้ (เฉพาะเจ้าของ/admin)")
        updates: dict[str, Any] = {}
        for f in ("title", "url", "description", "department", "tags", "image_data", "started_month"):
            v = getattr(payload, f)
            if v is not None:
                updates[f] = (v.strip() or None) if (isinstance(v, str) and f != "image_data") else v
        if payload.owner_member_id is not None:
            oname = _member_name_of(conn, payload.owner_member_id)
            if oname is None:
                raise HTTPException(status_code=400, detail="owner_member_id ไม่พบ")
            updates["owner_member_id"] = payload.owner_member_id
            updates["owner_name"] = oname
        if payload.creator_unspecified:
            updates["creator_member_id"] = None
            updates["creator_name"] = None
        elif payload.creator_member_id is not None:
            cname = _member_name_of(conn, payload.creator_member_id)
            if cname is None:
                raise HTTPException(status_code=400, detail="creator_member_id ไม่พบ")
            updates["creator_member_id"] = payload.creator_member_id
            updates["creator_name"] = cname
        if updates:
            updates["updated_at"] = utc_now().isoformat()
            sc = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE ai_projects SET {sc} WHERE id = ?", list(updates.values()) + [proj_id])
    return {"ok": True}


@app.delete("/api/ai-projects/{proj_id}")
def delete_ai_project(proj_id: int, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM ai_projects WHERE id = ?", (proj_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ AI Project")
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
        if not _aiproj_can_edit(row, actor_mid, is_admin):
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์ลบ AI Project นี้")
        conn.execute("DELETE FROM ai_projects WHERE id = ?", (proj_id,))
    return {"ok": True}


# v1.9.369 — pin/unpin โปรเจกต์สำคัญให้อยู่บนสุด (เจ้าของ/admin เท่านั้น)
@app.post("/api/ai-projects/{proj_id}/pin")
def pin_ai_project(proj_id: int, payload: AiProjectPinIn, sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM ai_projects WHERE id = ?", (proj_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ไม่พบ AI Project")
        actor_mid, _n, is_admin = _skill_actor(conn, sess)
        if not _aiproj_can_edit(row, actor_mid, is_admin):
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์ปักหมุด AI Project นี้ (เฉพาะเจ้าของ/admin)")
        pinned_at = utc_now().isoformat() if payload.pinned else None
        conn.execute(
            "UPDATE ai_projects SET pinned = ?, pinned_at = ? WHERE id = ?",
            (1 if payload.pinned else 0, pinned_at, proj_id),
        )
    return {"ok": True, "pinned": payload.pinned}


# v1.9.143 — รายชื่อทีม (แผนก) สำหรับ dropdown — logged-in ทุกคนเรียกได้
@app.get("/api/team-options")
def team_options(_auth: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute("SELECT id, name FROM teams ORDER BY name COLLATE NOCASE").fetchall()
    return {"teams": [dict(r) for r in rows]}


# v1.9.153 — Dashboard quick stats (จำนวนรวม + ที่ต้องจัดการ) — คลิกการ์ดไปหน้านั้น
@app.get("/api/dashboard-stats")
def dashboard_stats(_auth: str = Depends(require_any_auth)) -> dict[str, Any]:
    with db_conn() as conn:
        platforms = conn.execute("SELECT COUNT(*) AS n FROM sites").fetchone()["n"]
        skills = conn.execute("SELECT COUNT(*) AS n FROM skills").fetchone()["n"]
        ai_projects = conn.execute("SELECT COUNT(*) AS n FROM ai_projects").fetchone()["n"]
        # v1.9.233 — เครื่องยังไม่ผูก "จริง ๆ" = ไม่มี owner และไม่ใช่คอมส่วนกลาง
        # (คอมส่วนกลาง = ระบุ unassigned_team_id / storage_location / status=stock)
        unbound_pc = conn.execute(
            "SELECT COUNT(*) AS n FROM hardware WHERE hw_type = 'pc' AND current_member_id IS NULL "
            "AND unassigned_team_id IS NULL "
            "AND (storage_location IS NULL OR TRIM(storage_location) = '') "
            "AND (status IS NULL OR status != 'stock')"
        ).fetchone()["n"]
        members_no_team = conn.execute(
            "SELECT COUNT(*) AS n FROM members m "
            "WHERE NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.member_id = m.id)"
        ).fetchone()["n"]
    return {
        "platforms": platforms,
        "skills": skills,
        "ai_projects": ai_projects,
        "unbound_pc": unbound_pc,
        "members_no_team": members_no_team,
    }


# v1.9.162 — dependency: อนุญาต admin หรือ member ที่ได้รับสิทธิ์ module นี้
# (เรียก _member_accessible_modules ตอน request — นิยามไว้ใน IAM block ด้านล่าง)
def _require_module(module_key: str):
    def _dep(fct_session: Optional[str] = Cookie(default=None),
             fct_member_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
        if get_session(fct_session):
            return {"role": "admin", "member_id": None}
        msess = get_member_session(fct_member_session)
        if msess:
            mid = msess["member_id"]
            with db_conn() as conn:
                row = conn.execute("SELECT is_admin FROM members WHERE id = ?", (mid,)).fetchone()
                is_admin = bool(row["is_admin"]) if row else False
                mods = _member_accessible_modules(conn, mid, is_admin)
            if module_key in mods:
                return {"role": "admin" if is_admin else "member", "member_id": mid}
        raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์เข้าถึงเมนูนี้")
    return _dep


# v1.9.172 — ดึง Windsor "all" connector (JSON) แบบ module-level (ใช้ซ้ำ)
def _windsor_get(fields: str, date_from: str, date_to: str, timeout: int = 40, connector: str = "all") -> list:
    from urllib.parse import urlencode as _urlencode
    qs = _urlencode({"api_key": WINDSOR_API_KEY, "date_from": date_from, "date_to": date_to,
                     "fields": fields, "_renderer": "json"})
    req = urllib.request.Request(f"{WINDSOR_BASE_URL}/{connector}?{qs}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = _json.loads(resp.read().decode("utf-8", errors="replace"))
    return raw.get("data", []) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])


# ===========================================================================
# v1.9.157 — Ads spend (ดึงจาก Windsor.ai — 7 วันย้อนหลัง แยกตาม platform & ad account)
# ===========================================================================
@app.get("/api/ads-spend")
def ads_spend(days: int = 7, date_from: str | None = None, date_to: str | None = None,
              _sess: dict = Depends(_require_module("ads"))) -> dict[str, Any]:
    if not WINDSOR_API_KEY:
        raise HTTPException(status_code=503,
                            detail="ยังไม่ได้ตั้งค่า WINDSOR_API_KEY ใน environment — ตั้งค่าบน Railway ก่อนใช้งาน")
    today = utc_now().date()

    def _parse_d(s):
        try:
            return datetime.strptime((s or "").strip(), "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return None

    df, dt = _parse_d(date_from), _parse_d(date_to)
    if df and dt:
        if df > dt:
            df, dt = dt, df
        if (dt - df).days > 92:                 # จำกัดช่วงไม่เกิน ~3 เดือน
            df = dt - timedelta(days=92)
        date_from, date_to = df.isoformat(), dt.isoformat()
    else:
        days = max(1, min(int(days or 7), 90))
        date_to = today.isoformat()
        date_from = (today - timedelta(days=days - 1)).isoformat()
    from urllib.parse import urlencode as _urlencode

    def _windsor(fields: str) -> list:
        qs = _urlencode({"api_key": WINDSOR_API_KEY, "date_from": date_from, "date_to": date_to,
                         "fields": fields, "_renderer": "json"})
        req = urllib.request.Request(f"{WINDSOR_BASE_URL}/all?{qs}", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=50) as resp:
            raw = _json.loads(resp.read().decode("utf-8", errors="replace"))
        return raw.get("data", []) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])

    try:
        rows = _windsor("source,account_id,account_name,campaign,objective,ad_type,ad_format,object_type,effective_instagram_media__media_type,spend,impressions,clicks,reach,currency,actions_video_view")
        trend_rows = _windsor("source,date,spend")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300] if hasattr(e, "read") else ""
        raise HTTPException(status_code=502, detail=f"Windsor API error (HTTP {e.code}) {body}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เชื่อมต่อ Windsor ไม่สำเร็จ: {e}")

    def _f(v) -> float:
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    def _norm_fmt(r) -> str:
        """v1.9.166 — รวม field หลายตัวเป็น ad format: image / video / carousel / other"""
        imt = str(r.get("effective_instagram_media__media_type") or "").strip().upper()
        if imt == "IMAGE": return "image"
        if imt == "VIDEO": return "video"
        if imt == "CAROUSEL_ALBUM": return "carousel"
        af = str(r.get("ad_format") or "").strip().upper()
        if af == "SINGLE_IMAGE": return "image"
        if af in ("SINGLE_VIDEO", "LIVE_CONTENT"): return "video"
        if af in ("CAROUSEL_ADS", "CATALOG_CAROUSEL"): return "carousel"
        ot = str(r.get("object_type") or "").strip().upper()
        if ot == "PHOTO": return "image"
        if ot == "VIDEO": return "video"
        return "other"

    def _metrics(spend: float, impr: float, clk: float, reach: float, views: float = 0.0) -> dict[str, Any]:
        return {
            "spend": round(spend, 2),
            "impressions": int(round(impr)),
            "clicks": int(round(clk)),
            "reach": int(round(reach)),
            "views": int(round(views)),
            "ctr": round(clk / impr * 100, 2) if impr else None,
            "cpc": round(spend / clk, 2) if clk else None,
            "cpm": round(spend / impr * 1000, 2) if impr else None,
            "cpv": round(spend / views, 4) if views else None,
            "frequency": round(impr / reach, 2) if reach else None,
        }

    # ---- breakdown: platform → account → campaign (+ metrics) ----
    platforms: dict[str, Any] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        source = (str(r.get("source") or "other").strip()) or "other"
        acc_id = str(r.get("account_id") or "")
        acc_name = str(r.get("account_name") or acc_id or "(unknown)")
        cur = (str(r.get("currency") or "").strip()) or "—"
        campaign = (str(r.get("campaign") or "").strip()) or "(ไม่ระบุแคมเปญ)"
        # v1.9.165 — ad type = objective (fallback ad_type สำหรับ tiktok)
        ad_type = (str(r.get("objective") or "").strip()) or (str(r.get("ad_type") or "").strip()) or "(ไม่ระบุ)"
        spend, impr, clk, rch = _f(r.get("spend")), _f(r.get("impressions")), _f(r.get("clicks")), _f(r.get("reach"))
        vws = _f(r.get("actions_video_view"))
        p = platforms.setdefault(source, {"source": source, "accounts": {}, "total_by_cur": {}})
        key = acc_id or acc_name
        a = p["accounts"].setdefault(key, {"account_id": acc_id, "account_name": acc_name, "currency": cur,
                                           "spend": 0.0, "impressions": 0.0, "clicks": 0.0, "reach": 0.0, "views": 0.0, "campaigns": {}})
        a["spend"] += spend
        a["impressions"] += impr
        a["clicks"] += clk
        a["reach"] += rch
        a["views"] += vws
        c = a["campaigns"].setdefault(campaign, {"campaign": campaign, "ad_type": ad_type, "spend": 0.0, "impressions": 0.0, "clicks": 0.0, "reach": 0.0, "views": 0.0, "_fmt": {}})
        c["ad_type"] = ad_type
        c["spend"] += spend
        c["impressions"] += impr
        c["clicks"] += clk
        c["reach"] += rch
        c["views"] += vws
        # v1.9.166 — เก็บ spend ต่อ ad format เพื่อหา format หลักของแคมเปญ
        c["_fmt"][_norm_fmt(r)] = c["_fmt"].get(_norm_fmt(r), 0.0) + spend
        p["total_by_cur"][cur] = p["total_by_cur"].get(cur, 0.0) + spend
    out = []
    for source, p in platforms.items():
        accounts = sorted(p["accounts"].values(), key=lambda x: x["spend"], reverse=True)
        acc_out = []
        for a in accounts:
            def _dom_fmt(c):
                fm = c.get("_fmt") or {}
                real = {k: v for k, v in fm.items() if k != "other"}
                pick = real or fm
                return max(pick, key=pick.get) if pick else "other"
            camps = sorted(
                ({"campaign": c["campaign"], "ad_type": c.get("ad_type"), "ad_format": _dom_fmt(c),
                  **_metrics(c["spend"], c["impressions"], c["clicks"], c["reach"], c.get("views", 0.0))}
                 for c in a["campaigns"].values()),
                key=lambda x: x["spend"], reverse=True,
            )
            acc_out.append({"account_id": a["account_id"], "account_name": a["account_name"], "currency": a["currency"],
                            **_metrics(a["spend"], a["impressions"], a["clicks"], a["reach"], a.get("views", 0.0)), "campaigns": camps})
        # platform-level totals (สรุปรวมต่อแพลตฟอร์ม — ไม่ขึ้นกับสกุลเงิน)
        t_impr = sum(a["impressions"] for a in acc_out)
        t_clk = sum(a["clicks"] for a in acc_out)
        t_reach = sum(a["reach"] for a in acc_out)
        totals = {
            "impressions": t_impr, "clicks": t_clk, "reach": t_reach,
            "ctr": round(t_clk / t_impr * 100, 2) if t_impr else None,
            "frequency": round(t_impr / t_reach, 2) if t_reach else None,
        }
        out.append({
            "source": source,
            "accounts": acc_out,
            "total_by_cur": {k: round(v, 2) for k, v in p["total_by_cur"].items()},
            "account_count": len(acc_out),
            "totals": totals,
        })
    out.sort(key=lambda x: sum(x["total_by_cur"].values()), reverse=True)

    # ---- trend: daily spend per source ----
    trend_map: dict[str, dict[str, float]] = {}
    sources_seen: set[str] = set()
    for r in trend_rows:
        if not isinstance(r, dict):
            continue
        d = str(r.get("date") or "").strip()[:10]
        if not d:
            continue
        s = (str(r.get("source") or "other").strip()) or "other"
        sources_seen.add(s)
        dm = trend_map.setdefault(d, {})
        dm[s] = dm.get(s, 0.0) + _f(r.get("spend"))
    dates = sorted(trend_map.keys())
    srcs = sorted(sources_seen)
    trend = {
        "dates": dates,
        "sources": srcs,
        "series": {s: [round(trend_map[d].get(s, 0.0), 2) for d in dates] for s in srcs},
    }

    return {"date_from": date_from, "date_to": date_to, "days": days, "platforms": out, "trend": trend}


# ===========================================================================
# v1.9.167 — Ads Benchmark: CPM แยกตาม Brand × Ad Type (ดึงจาก Google Sheet)
# ===========================================================================
# AdType vocabulary — match จากชื่อ campaign (เรียงตามความเฉพาะเจาะจง)
_BENCH_ADTYPES = [
    "Video Thruplay", "Video Views", "Page Likes", "Page Like", "CPAS",
    "Reach", "Engagement", "Traffic", "Awareness", "Messages", "Message",
    "Conversions", "Conversion", "Purchases", "Purchase", "Leads", "Lead",
]


def _bench_brand(camp: str) -> str:
    """Brand = คำแรกหลัง ] ตัวแรก (ข้าม space/dash นำหน้า)"""
    i = camp.find("]")
    if i < 0:
        return "(ไม่ระบุ)"
    rest = camp[i + 1:].lstrip(" -–—\t​\xa0")
    parts = rest.split()
    return (parts[0].strip(" .,:") if parts else "") or "(ไม่ระบุ)"


def _bench_adtype(camp: str) -> str:
    low = camp.lower()
    for t in _BENCH_ADTYPES:
        if t.lower() in low:
            return t
    return "(ไม่ระบุ)"


# v1.9.176 — หมวดสินค้าของแต่ละแบรนด์ (อิงหมวดแบบ AC Nielsen / FMCG)
# key = brand (ตัวพิมพ์เล็ก, ตรงกับผลของ _bench_brand) → category
# *** แก้/เพิ่มได้ตรงนี้ — แบรนด์ที่ไม่อยู่ในรายการจะเป็น "ไม่ระบุ" ***
_BRAND_CATEGORY = {
    # Oral Care (ผลิตภัณฑ์ดูแลช่องปาก)
    "systema": "Oral Care", "systema-oral": "Oral Care", "salz": "Oral Care", "zact": "Oral Care",
    # Baby & Kids Care
    "kodomo": "Baby & Kids Care",
    # Personal Care / Body Wash
    "kirei": "Personal & Body Care", "hi": "Personal & Body Care",
    # Home & Fabric / Dishwashing
    "pao": "Fabric Care (Detergent)", "fresh": "Fabric Care (Softener)", "lipon": "Dishwashing",
    # Paper & Tissue
    "mont": "Paper & Tissue",
    # Food
    "mama": "Instant Noodles", "farmhouse": "Bakery", "bissin": "Snacks (Biscuits)",
    # Beverage / Dairy
    "dutch": "Dairy", "arabus": "Beverage (RTD)", "beanwell": "Beverage (Coffee)",
    # Healthcare / Services
    "navavej": "Healthcare",
    # E-commerce / Pet / Automotive
    "lso": "Online Shopping",
    "hajiko": "Pet Product", "hashi": "Pet Product",
    "pulza": "Car Maintenance",
}
_BENCH_CAT_UNKNOWN = "ไม่ระบุหมวด"


def _bench_category(brand: str) -> str:
    return _BRAND_CATEGORY.get((brand or "").strip().lower(), _BENCH_CAT_UNKNOWN)


@app.get("/api/ads-benchmark")
def ads_benchmark(_sess: dict = Depends(_require_module("ads"))) -> dict[str, Any]:
    url = f"https://docs.google.com/spreadsheets/d/{ADS_BENCHMARK_SHEET_ID}/export?format=csv"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"ดึง Google Sheet ไม่สำเร็จ (HTTP {e.code}) — ตรวจว่าแชร์เป็น 'ทุกคนที่มีลิงก์'")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ดึง Google Sheet ไม่สำเร็จ: {e}")
    import csv as _csv
    import io as _io
    reader = _csv.DictReader(_io.StringIO(raw))
    # หา key ของคอลัมน์ (case-insensitive)
    fieldmap = {(k or "").strip().lower(): k for k in (reader.fieldnames or [])}
    k_camp = fieldmap.get("campaign")
    k_spend = fieldmap.get("spend")
    k_impr = fieldmap.get("impressions")
    k_cpm = fieldmap.get("cpm")
    k_obj = fieldmap.get("objective")
    k_src = fieldmap.get("source")
    k_reach = fieldmap.get("reach")
    k_freq = fieldmap.get("frequency")
    k_cpp = fieldmap.get("cpp")
    k_cpv = fieldmap.get("cost_per_action_type_video_view")   # CPV ต่อแถว
    if not k_camp:
        raise HTTPException(status_code=502, detail="ไม่พบคอลัมน์ 'campaign' ในชีต")

    def _ff(v):
        try:
            return float(str(v or "0").replace(",", ""))
        except (TypeError, ValueError):
            return 0.0

    def _newd():
        return {"spend": 0.0, "cpms": [], "cpvs": []}

    # ---- อ่านทุกแถวเป็น record ก่อน แล้วค่อยสรุปได้ทั้งแบบ brand และ category ----
    recs: list = []
    for row in reader:
        camp = (row.get(k_camp) or "").strip()
        if not camp:
            continue
        spend = _ff(row.get(k_spend)) if k_spend else 0.0
        impr = _ff(row.get(k_impr)) if k_impr else 0.0
        cpm_v = _ff(row.get(k_cpm)) if k_cpm else 0.0
        if cpm_v <= 0 and impr > 0:
            cpm_v = spend / impr * 1000
        if spend == 0 and impr == 0:
            continue
        cpv_v = _ff(row.get(k_cpv)) if k_cpv else 0.0
        brand = _bench_brand(camp)
        recs.append({
            "brand": brand,
            "category": _bench_category(brand),
            "adtype": _bench_adtype(camp),
            "spend": spend,
            "cpm": cpm_v,
            "cpv": cpv_v,
            "detail": {
                "campaign": camp,
                "objective": (row.get(k_obj) or "").strip() if k_obj else "",
                "source": (row.get(k_src) or "").strip() if k_src else "",
                "spend": round(spend, 2),
                "impressions": int(round(impr)),
                "reach": int(round(_ff(row.get(k_reach)))) if k_reach else None,
                "frequency": round(_ff(row.get(k_freq)), 3) if k_freq else None,
                "cpm": round(cpm_v, 2) if cpm_v > 0 else None,
                "cpv": round(cpv_v, 4) if cpv_v > 0 else None,
                "cpp": round(_ff(row.get(k_cpp)), 2) if k_cpp else None,
            },
        })
    n = len(recs)

    def _agg(d):
        cs = d["cpms"]
        vs = d["cpvs"]
        return {
            "avg": round(sum(cs) / len(cs), 2) if cs else None,
            "min": round(min(cs), 2) if cs else None,
            "max": round(max(cs), 2) if cs else None,
            "n": len(cs),
            "spend": round(d["spend"], 2),
            "cpv": {
                "avg": round(sum(vs) / len(vs), 4) if vs else None,
                "min": round(min(vs), 4) if vs else None,
                "max": round(max(vs), 4) if vs else None,
                "n": len(vs),
            },
        }

    def _build_view(group_key: str) -> dict:
        cells: dict = {}
        gtot: dict = {}
        atot: dict = {}
        details: dict = {}
        grand = _newd()
        for r in recs:
            g, t, spend, cpm_v, cpv_v = r[group_key], r["adtype"], r["spend"], r["cpm"], r["cpv"]
            for d in (cells.setdefault((g, t), _newd()),
                      gtot.setdefault(g, _newd()),
                      atot.setdefault(t, _newd()),
                      grand):
                d["spend"] += spend
                if cpm_v > 0:
                    d["cpms"].append(cpm_v)
                if cpv_v > 0:
                    d["cpvs"].append(cpv_v)
            details.setdefault(g, {}).setdefault(t, []).append(r["detail"])
        groups = sorted(gtot, key=lambda x: gtot[x]["spend"], reverse=True)
        adtypes = sorted(atot, key=lambda x: atot[x]["spend"], reverse=True)
        for g in details:
            for t in details[g]:
                details[g][t].sort(key=lambda x: x["spend"], reverse=True)
        return {
            "rows": groups,
            "adtypes": adtypes,
            "matrix": {g: {t: _agg(cells[(g, t)]) for t in adtypes if (g, t) in cells} for g in groups},
            "row_totals": {g: _agg(gtot[g]) for g in groups},
            "adtype_totals": {t: _agg(atot[t]) for t in adtypes},
            "grand": _agg(grand),
            "details": details,
        }

    brand_view = _build_view("brand")
    cat_view = _build_view("category")
    brand_category = {b: _bench_category(b) for b in brand_view["rows"]}
    return {
        "row_count": n,
        "brand_category": brand_category,
        "views": {"brand": brand_view, "category": cat_view},
        # ---- legacy fields (by brand) — ใช้โดย slide-out ในหน้า Report ----
        "brands": brand_view["rows"],
        "adtypes": brand_view["adtypes"],
        "matrix": brand_view["matrix"],
        "brand_totals": brand_view["row_totals"],
        "adtype_totals": brand_view["adtype_totals"],
        "grand": brand_view["grand"],
        "details": brand_view["details"],
    }


# ===========================================================================
# v1.9.198 — Ads Campaign: รายการแคมเปญจาก Google Sheet (sheet แรก)
# ===========================================================================
_CAMP_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _camp_parse_date(s: str):
    """แปลงวันที่หลายรูปแบบ → ISO (YYYY-MM-DD) | None"""
    s = (s or "").strip()
    if not s:
        return None
    import re as _re
    # 1 May 26 / 01 May 2026 / 1 May'26
    m = _re.match(r"^(\d{1,2})\s*[-/ ]?\s*([A-Za-z]{3,})[\s'`]*?(\d{2,4})$", s)
    if m:
        d, mon, y = m.group(1), m.group(2)[:3].lower(), m.group(3)
        if mon in _CAMP_MONTHS:
            yr = int(y); yr = yr + 2000 if yr < 100 else yr
            try:
                return f"{yr:04d}-{_CAMP_MONTHS[mon]:02d}-{int(d):02d}"
            except ValueError:
                return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%m/%d/%Y", "%m/%d/%y", "%d-%m-%Y", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _camp_period_range(period: str, start_iso, end_iso):
    """หา start/end ISO จาก period text (เช่น '1 May 26 - 31 May 26') หรือใช้ start/end ที่ parse มาแล้ว"""
    if start_iso and end_iso:
        return start_iso, end_iso
    import re as _re
    txt = period or ""
    # ตัดวงเล็บเหลี่ยมออก
    txt = txt.replace("[", " ").replace("]", " ")
    parts = _re.split(r"\s*(?:-|–|—|to|ถึง)\s*", txt)
    if len(parts) >= 2:
        a, b = _camp_parse_date(parts[0]), _camp_parse_date(parts[-1])
        return start_iso or a, end_iso or b
    d = _camp_parse_date(txt)
    return start_iso or d, end_iso or d


@app.get("/api/ads-campaigns")
def ads_campaigns(_sess: dict = Depends(_require_module("ads"))) -> dict[str, Any]:
    if ADS_CAMPAIGN_CSV_URL:
        url = ADS_CAMPAIGN_CSV_URL                       # ลิงก์ Publish-to-web (CSV) ตรง ๆ
    else:
        qs = "export?format=csv" + (f"&gid={ADS_CAMPAIGN_SHEET_GID}" if ADS_CAMPAIGN_SHEET_GID else "")
        url = f"https://docs.google.com/spreadsheets/d/{ADS_CAMPAIGN_SHEET_ID}/{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"ดึง Google Sheet ไม่สำเร็จ (HTTP {e.code}) — ชีตยังเข้าถึงสาธารณะไม่ได้ (องค์กรอาจล็อกการแชร์) ลองใช้ 'เผยแพร่ไปยังเว็บ' แล้วตั้ง ADS_CAMPAIGN_CSV_URL")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ดึง Google Sheet ไม่สำเร็จ: {e}")
    if raw.lstrip()[:14].lower().startswith("<!doctype") or "<html" in raw[:200].lower():
        raise HTTPException(status_code=502, detail="ชีตยังไม่เปิดสาธารณะ — แชร์เป็น 'ทุกคนที่มีลิงก์ดูได้' ก่อน")

    import csv as _csv
    import io as _io
    reader = _csv.DictReader(_io.StringIO(raw))
    cols = [c for c in (reader.fieldnames or []) if c is not None]
    fm = {(c or "").strip().lower(): c for c in cols}

    def _find(*cands):
        for cand in cands:
            for low, orig in fm.items():
                if low == cand:
                    return orig
        for cand in cands:               # contains
            for low, orig in fm.items():
                if cand in low:
                    return orig
        return None

    k_name = _find("campaign name", "campaign", "name", "ชื่อแคมเปญ", "ชื่อ")
    k_period = _find("period", "duration", "ระยะเวลา", "ช่วงเวลา")
    k_budget = _find("budget", "งบ", "งบประมาณ", "amount")
    k_obj = _find("objective", "วัตถุประสงค์", "obj", "goal")
    k_start = _find("start date", "start", "from", "วันเริ่ม", "เริ่ม")
    k_end = _find("end date", "end", "to", "วันสิ้นสุด", "สิ้นสุด")
    k_bid = _find("bid.", "bid", "bidder", "ผู้บิด", "คนบิด")
    k_pcode = _find("project code", "project_code", "projectcode", "code", "รหัสโปรเจกต์")
    k_pname = _find("project name", "project_name", "projectname", "โปรเจกต์")

    out = []
    objectives = set()
    bids = set()
    for row in reader:
        fields = {(c or "").strip(): (row.get(c) or "").strip() for c in cols}
        name = (row.get(k_name) or "").strip() if k_name else ""
        if not name and not any(fields.values()):
            continue
        period = (row.get(k_period) or "").strip() if k_period else ""
        raw_start = (row.get(k_start) or "").strip() if k_start else ""
        raw_end = (row.get(k_end) or "").strip() if k_end else ""
        s_iso = _camp_parse_date(raw_start) or None
        e_iso = _camp_parse_date(raw_end) or None
        s_iso, e_iso = _camp_period_range(period, s_iso, e_iso)
        if not period:                                    # ไม่มีคอลัมน์ period → ใช้ start–end (ข้อความเดิม)
            if raw_start and raw_end:
                period = f"{raw_start} – {raw_end}"
            elif raw_start or raw_end:
                period = raw_start or raw_end
            elif s_iso and e_iso:
                period = f"{s_iso} – {e_iso}"
        budget = (row.get(k_budget) or "").strip() if k_budget else ""
        obj = (row.get(k_obj) or "").strip() if k_obj else ""
        bid = (row.get(k_bid) or "").strip() if k_bid else ""
        if obj:
            objectives.add(obj)
        if bid:
            bids.add(bid)
        out.append({
            "name": name or "(ไม่ระบุชื่อ)",
            "period": period,
            "budget": budget,
            "objective": obj,
            "bid": bid,
            "project_code": (row.get(k_pcode) or "").strip() if k_pcode else "",
            "project_name": (row.get(k_pname) or "").strip() if k_pname else "",
            "start": s_iso,
            "end": e_iso,
            "start_txt": raw_start,
            "end_txt": raw_end,
            "fields": fields,
        })

    return {
        "columns": [c.strip() for c in cols],
        "count": len(out),
        "campaigns": out,
        "objectives": sorted(objectives),
        "bids": sorted(bids),
        "mapped": {"name": k_name, "period": k_period, "budget": k_budget, "objective": k_obj,
                   "start": k_start, "end": k_end, "bid": k_bid, "project_code": k_pcode, "project_name": k_pname},
    }


# ===========================================================================
# v1.9.207 — Claude RateLimit: ติดตาม usage/limit ของ Claude.ai subscription หลาย account
#   *** ดูข้อมูล usage จริง ทำโดย worker แยก (Playwright headless) — service นี้เก็บ/แสดงผล ***
# ===========================================================================
def _clrl_settings() -> dict:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM claude_ratelimit_settings WHERE id = 1").fetchone()
    if not row:
        return {"check_cron": "0 * * * *", "alert_config": {}, "threshold_pct": 90}
    d = dict(row)
    try:
        d["alert_config"] = _json.loads(d.get("alert_config") or "{}")
    except Exception:
        d["alert_config"] = {}
    return d


def _clrl_send_alert(text: str) -> tuple[bool, str]:
    """ส่ง alert ไป webhook (Teams/Power Automate/generic) และ/หรือ LINE — ไม่ log token/cookie"""
    cfg = _clrl_settings().get("alert_config") or {}
    sent, notes = False, []
    wh = (cfg.get("webhook_url") or "").strip()
    if wh:
        try:
            body = _json.dumps({"text": text}).encode("utf-8")
            req = urllib.request.Request(wh, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            sent = True
        except Exception as e:
            notes.append(f"webhook ล้มเหลว: {str(e)[:120]}")
    lt = (cfg.get("line_token") or "").strip()
    if lt:
        to = (cfg.get("line_to") or "").strip()
        url = "https://api.line.me/v2/bot/message/push" if to else "https://api.line.me/v2/bot/message/broadcast"
        payload = {"messages": [{"type": "text", "text": text[:4900]}]}
        if to:
            payload["to"] = to
        try:
            req = urllib.request.Request(url, data=_json.dumps(payload).encode("utf-8"),
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {lt}"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            sent = True
        except Exception as e:
            notes.append(f"LINE ล้มเหลว: {str(e)[:120]}")
    if not wh and not lt:
        return False, "ยังไม่ได้ตั้งค่า alert channel (webhook หรือ LINE)"
    return sent, "; ".join(notes)


def _clrl_account_dash(conn, acc) -> dict:
    """ข้อมูล 1 account สำหรับ dashboard (ไม่รวม storage_state)"""
    snap = conn.execute(
        "SELECT * FROM claude_usage_snapshots WHERE account_id = ? ORDER BY checked_at DESC LIMIT 1",
        (acc["id"],),
    ).fetchone()
    s = dict(snap) if snap else None
    if s:
        s.pop("raw_json", None)
    return {
        "id": acc["id"], "label": acc["label"],
        "session_status": acc["session_status"] or "no_session",
        "has_session": bool(acc["storage_state"]),
        "updated_at": acc["updated_at"],
        "latest": s,
    }


@app.get("/api/claude-ratelimit")
def claude_ratelimit_dashboard(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        accs = conn.execute("SELECT * FROM claude_accounts ORDER BY label COLLATE NOCASE").fetchall()
        out = [_clrl_account_dash(conn, a) for a in accs]
    return {"accounts": out, "count": len(out)}


@app.get("/api/claude-ratelimit/accounts")
def claude_rl_accounts(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        accs = conn.execute("SELECT * FROM claude_accounts ORDER BY label COLLATE NOCASE").fetchall()
        out = [{"id": a["id"], "label": a["label"], "session_status": a["session_status"] or "no_session",
                "has_session": bool(a["storage_state"]), "created_at": a["created_at"], "updated_at": a["updated_at"]}
               for a in accs]
    return {"accounts": out}


class ClrlAccountIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)


@app.post("/api/claude-ratelimit/accounts")
def claude_rl_create(payload: ClrlAccountIn, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    now = utc_now().isoformat()
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO claude_accounts(label, session_status, created_at, updated_at) VALUES (?, 'no_session', ?, ?)",
            (payload.label.strip(), now, now),
        )
        return {"id": cur.lastrowid, "label": payload.label.strip()}


@app.put("/api/claude-ratelimit/accounts/{acc_id}")
def claude_rl_update(acc_id: int, payload: ClrlAccountIn, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        r = conn.execute("SELECT id FROM claude_accounts WHERE id = ?", (acc_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบ account")
        conn.execute("UPDATE claude_accounts SET label = ?, updated_at = ? WHERE id = ?",
                     (payload.label.strip(), utc_now().isoformat(), acc_id))
    return {"ok": True}


@app.delete("/api/claude-ratelimit/accounts/{acc_id}")
def claude_rl_delete(acc_id: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        conn.execute("DELETE FROM claude_usage_snapshots WHERE account_id = ?", (acc_id,))
        conn.execute("DELETE FROM claude_accounts WHERE id = ?", (acc_id,))
    return {"ok": True}


class ClrlSessionIn(BaseModel):
    storage_state: str = Field(..., min_length=2, max_length=2_000_000)


@app.post("/api/claude-ratelimit/accounts/{acc_id}/session")
def claude_rl_session(acc_id: int, payload: ClrlSessionIn, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    # validate ว่าเป็น storageState JSON ที่มี cookies (ไม่ log เนื้อหา)
    try:
        obj = _json.loads(payload.storage_state)
    except Exception:
        raise HTTPException(status_code=400, detail="ไฟล์ไม่ใช่ JSON ที่ถูกต้อง")
    if not isinstance(obj, dict) or not isinstance(obj.get("cookies"), list) or not obj["cookies"]:
        raise HTTPException(status_code=400, detail="ไม่พบ 'cookies' ใน storageState — export ผิดไฟล์หรือยังไม่ได้ login")
    enc = _clrl_encrypt(payload.storage_state)
    with db_conn() as conn:
        r = conn.execute("SELECT id FROM claude_accounts WHERE id = ?", (acc_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบ account")
        conn.execute("UPDATE claude_accounts SET storage_state = ?, session_status = 'healthy', updated_at = ? WHERE id = ?",
                     (enc, utc_now().isoformat(), acc_id))
    return {"ok": True, "session_status": "healthy", "cookies": len(obj["cookies"])}


@app.post("/api/claude-ratelimit/check/{acc_id}")
def claude_rl_check(acc_id: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    # การเช็คจริงทำโดย worker (Playwright) แยก — web service ไม่มี Chromium
    with db_conn() as conn:
        r = conn.execute("SELECT * FROM claude_accounts WHERE id = ?", (acc_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบ account")
        if not r["storage_state"]:
            raise HTTPException(status_code=400, detail="ยังไม่ได้อัปโหลด session (storageState)")
    return {"ok": True, "queued": True,
            "note": "การเช็คจริงทำโดย worker service (Playwright) — รอบถัดไปจะอัปเดต snapshot ให้ (ดู scripts/claude_usage_worker.py)"}


@app.get("/api/claude-ratelimit/settings")
def claude_rl_get_settings(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    s = _clrl_settings()
    cfg = s.get("alert_config") or {}
    return {
        "check_cron": s.get("check_cron") or "0 * * * *",
        "threshold_pct": s.get("threshold_pct") or 90,
        "alert": {
            "webhook_url": cfg.get("webhook_url") or "",
            "line_to": cfg.get("line_to") or "",
            "line_token_set": bool(cfg.get("line_token")),   # ไม่ส่ง token กลับ
            "quiet_start": cfg.get("quiet_start") or "",
            "quiet_end": cfg.get("quiet_end") or "",
        },
    }


class ClrlSettingsIn(BaseModel):
    check_cron: str = Field("0 * * * *", max_length=120)
    threshold_pct: float = Field(90, ge=1, le=100)
    webhook_url: str = Field("", max_length=1000)
    line_token: Optional[str] = Field(None, max_length=400)   # None = ไม่เปลี่ยน, "" = ลบ
    line_to: str = Field("", max_length=200)
    quiet_start: str = Field("", max_length=5)
    quiet_end: str = Field("", max_length=5)


@app.post("/api/claude-ratelimit/settings")
def claude_rl_save_settings(payload: ClrlSettingsIn, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    cur = _clrl_settings().get("alert_config") or {}
    cfg = {
        "webhook_url": (payload.webhook_url or "").strip(),
        "line_to": (payload.line_to or "").strip(),
        "quiet_start": (payload.quiet_start or "").strip(),
        "quiet_end": (payload.quiet_end or "").strip(),
        "line_token": cur.get("line_token", ""),
    }
    if payload.line_token is not None:                      # ส่งมา = ตั้งค่าใหม่ ("" = ลบ)
        cfg["line_token"] = payload.line_token.strip()
    with db_conn() as conn:
        conn.execute(
            "UPDATE claude_ratelimit_settings SET check_cron = ?, alert_config = ?, threshold_pct = ?, updated_at = ? WHERE id = 1",
            (payload.check_cron.strip() or "0 * * * *", _json.dumps(cfg, ensure_ascii=False),
             float(payload.threshold_pct), utc_now().isoformat()),
        )
    return {"ok": True}


@app.post("/api/claude-ratelimit/test-alert")
def claude_rl_test_alert(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    ok, note = _clrl_send_alert("🔔 [ทดสอบ] Claude RateLimit alert — การตั้งค่าช่องแจ้งเตือนทำงานปกติ")
    if not ok:
        raise HTTPException(status_code=400, detail=note or "ส่งไม่สำเร็จ")
    return {"ok": True, "note": note}


def _clrl_compute_status(session_pct, weekly_pct, opus_pct, threshold) -> str:
    vals = [v for v in (session_pct, weekly_pct, opus_pct) if isinstance(v, (int, float))]
    if not vals:
        return "ok"
    hi = max(vals)
    return "full" if (hi >= 100 or hi >= float(threshold or 90)) else "ok"


class ClrlIngestIn(BaseModel):
    token: str
    label: str = Field(..., min_length=1, max_length=120)
    session_pct: Optional[float] = None
    session_reset_at: Optional[str] = None
    weekly_pct: Optional[float] = None
    weekly_reset_at: Optional[str] = None
    weekly_opus_pct: Optional[float] = None
    weekly_opus_reset_at: Optional[str] = None
    expired: bool = False
    raw: Optional[dict] = None


@app.post("/api/claude-ratelimit/ingest")
def claude_rl_ingest(payload: ClrlIngestIn) -> dict[str, Any]:
    # auth ด้วย shared token (เรียกจาก local runner ไม่ใช่ browser session)
    if not CLAUDE_RL_INGEST_TOKEN or payload.token != CLAUDE_RL_INGEST_TOKEN:
        raise HTTPException(status_code=403, detail="invalid ingest token")
    now = utc_now().isoformat()
    s = _clrl_settings()
    status = "expired" if payload.expired else _clrl_compute_status(
        payload.session_pct, payload.weekly_pct, payload.weekly_opus_pct, s.get("threshold_pct") or 90)
    with db_conn() as conn:
        acc = conn.execute("SELECT * FROM claude_accounts WHERE label = ?", (payload.label.strip(),)).fetchone()
        if acc:
            acc_id = acc["id"]
            prev_sess = acc["session_status"] or ""
            prow = conn.execute("SELECT status FROM claude_usage_snapshots WHERE account_id=? ORDER BY checked_at DESC LIMIT 1", (acc_id,)).fetchone()
            prev_status = (prow["status"] if prow else "") or ""
        else:
            cur = conn.execute("INSERT INTO claude_accounts(label, session_status, created_at, updated_at) VALUES (?, ?, ?, ?)",
                               (payload.label.strip(), "healthy", now, now))
            acc_id, prev_sess, prev_status = cur.lastrowid, "", ""
        conn.execute("UPDATE claude_accounts SET session_status=?, updated_at=? WHERE id=?",
                     ("expired" if payload.expired else "healthy", now, acc_id))
        conn.execute(
            "INSERT INTO claude_usage_snapshots(account_id, session_pct, session_reset_at, weekly_pct, weekly_reset_at, "
            " weekly_opus_pct, weekly_opus_reset_at, raw_json, status, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (acc_id, payload.session_pct, payload.session_reset_at, payload.weekly_pct, payload.weekly_reset_at,
             payload.weekly_opus_pct, payload.weekly_opus_reset_at, _json.dumps(payload.raw or {}, ensure_ascii=False), status, now),
        )
    # alert เฉพาะตอน state เปลี่ยน (กัน spam)
    if status == "full" and prev_status != "full":
        _clrl_send_alert(f"🔴 [{payload.label}] Claude limit ใกล้เต็ม/เต็มแล้ว — "
                         f"session {payload.session_pct}% · weekly {payload.weekly_pct}%")
    if payload.expired and prev_sess != "expired":
        _clrl_send_alert(f"⚠️ [{payload.label}] Claude session หมดอายุ — ต้อง re-auth (รัน save_session ใหม่)")
    return {"ok": True, "account_id": acc_id, "status": status}


# ===========================================================================
# v1.9.211 — SSO endpoints (Identity Provider)
# ===========================================================================
def _sso_get_client(client_id: str):
    if not client_id:
        return None
    with db_conn() as conn:
        return conn.execute("SELECT * FROM sso_clients WHERE client_id = ?", (client_id,)).fetchone()


def _sso_redirect_ok(client, redirect_uri: str) -> bool:
    allowed = [u.strip() for u in (client["redirect_uris"] or "").split() if u.strip()]
    return redirect_uri in allowed


def _sso_current_identity(fct_session, fct_member_session):
    sess = get_session(fct_session)
    if sess:
        return {"sub": f"admin:{sess.get('user_id')}", "name": sess.get("username") or "admin", "email": "", "role": "admin"}
    msess = get_member_session(fct_member_session)
    if msess:
        mid = msess["member_id"]
        with db_conn() as conn:
            row = conn.execute("SELECT * FROM members WHERE id = ?", (mid,)).fetchone()
        d = dict(row) if row else {}
        return {"sub": f"member:{mid}", "name": d.get("name") or "member", "email": d.get("email") or "", "role": "member"}
    return None


@app.get("/sso/authorize")
def sso_authorize(client_id: str = "", redirect_uri: str = "", state: str = "",
                  response_type: str = "code", scope: str = "",
                  fct_session: Optional[str] = Cookie(default=None),
                  fct_member_session: Optional[str] = Cookie(default=None)):
    from urllib.parse import urlencode as _ue, quote as _q
    client = _sso_get_client(client_id)
    if not client or not client["enabled"]:
        return HTMLResponse("<h3 style='font-family:sans-serif'>SSO error: ไม่รู้จัก client หรือถูกปิดใช้งาน</h3>", status_code=400)
    if not _sso_redirect_ok(client, redirect_uri):
        return HTMLResponse("<h3 style='font-family:sans-serif'>SSO error: redirect_uri ไม่ตรงกับที่ลงทะเบียนไว้</h3>", status_code=400)
    if response_type != "code":
        return HTMLResponse("<h3 style='font-family:sans-serif'>SSO error: รองรับเฉพาะ response_type=code</h3>", status_code=400)
    ident = _sso_current_identity(fct_session, fct_member_session)
    if not ident:
        # ยังไม่ได้ login Beat → พาไป login แล้วกลับมาที่ authorize เดิม
        cont = f"{SSO_ISSUER}/sso/authorize?" + _ue({"client_id": client_id, "redirect_uri": redirect_uri,
                                                      "state": state, "response_type": "code", "scope": scope})
        return RedirectResponse(f"/?sso_continue={_q(cont, safe='')}", status_code=302)
    code = secrets.token_urlsafe(32)
    now = utc_now()
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO sso_codes(code, client_id, redirect_uri, sub, email, name, role, expires_at, used, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,0,?)",
            (code, client_id, redirect_uri, ident["sub"], ident["email"], ident["name"], ident["role"],
             (now + timedelta(seconds=SSO_CODE_TTL)).isoformat(), now.isoformat()),
        )
    sep = "&" if "?" in redirect_uri else "?"
    url = f"{redirect_uri}{sep}code={code}" + (f"&state={_q(state, safe='')}" if state else "")
    return RedirectResponse(url, status_code=302)


@app.post("/sso/token")
async def sso_token(request: Request):
    ct = request.headers.get("content-type", "")
    try:
        if "application/json" in ct:
            data = await request.json()
        else:
            from urllib.parse import parse_qs
            data = {k: v[0] for k, v in parse_qs((await request.body()).decode()).items()}
    except Exception:
        data = {}
    client_id = (data.get("client_id") or "").strip()
    client_secret = (data.get("client_secret") or "").strip()
    code = (data.get("code") or "").strip()
    redirect_uri = (data.get("redirect_uri") or "").strip()
    client = _sso_get_client(client_id)
    import hmac as _hmac
    if not client or not _hmac.compare_digest(client["client_secret"], client_secret):
        raise HTTPException(status_code=401, detail="invalid client")
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM sso_codes WHERE code = ?", (code,)).fetchone()
        if not row or row["used"] or row["client_id"] != client_id or row["redirect_uri"] != redirect_uri:
            raise HTTPException(status_code=400, detail="invalid code")
        if parse_iso(row["expires_at"]) < utc_now():
            raise HTTPException(status_code=400, detail="code expired")
        conn.execute("UPDATE sso_codes SET used = 1 WHERE code = ?", (code,))
    now = int(utc_now().timestamp())
    claims = {
        "iss": SSO_ISSUER, "sub": row["sub"], "aud": client_id,
        "iat": now, "exp": now + SSO_ID_TOKEN_TTL,
        "name": row["name"], "email": row["email"], "role": row["role"],
    }
    id_token = _sso_jwt_encode(claims, client["client_secret"])
    return {"access_token": id_token, "id_token": id_token, "token_type": "Bearer",
            "expires_in": SSO_ID_TOKEN_TTL,
            "profile": {"sub": row["sub"], "name": row["name"], "email": row["email"], "role": row["role"]}}


@app.get("/sso/userinfo")
def sso_userinfo(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    # อ่าน aud (unverified) เพื่อหา client → verify ด้วย secret ของ client
    try:
        body = _json.loads(_sso_b64u_dec(token.split(".")[1]))
        aud = body.get("aud")
    except Exception:
        raise HTTPException(status_code=401, detail="invalid token")
    client = _sso_get_client(aud)
    payload = _sso_jwt_decode(token, client["client_secret"]) if client else None
    if not payload:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return {"sub": payload["sub"], "name": payload.get("name"), "email": payload.get("email"), "role": payload.get("role")}


# ---- client management (super admin) ----
class SsoClientIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    redirect_uris: str = Field("", max_length=4000)
    enabled: bool = True


@app.get("/api/sso/clients")
def sso_list_clients(_sess: dict = Depends(require_super_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM sso_clients ORDER BY created_at DESC").fetchall()
    return {"clients": [dict(r) for r in rows], "issuer": SSO_ISSUER,
            "authorize_url": f"{SSO_ISSUER}/sso/authorize", "token_url": f"{SSO_ISSUER}/sso/token",
            "userinfo_url": f"{SSO_ISSUER}/sso/userinfo"}


@app.post("/api/sso/clients")
def sso_create_client(payload: SsoClientIn, _sess: dict = Depends(require_super_admin)) -> dict[str, Any]:
    cid = "beat_" + secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    with db_conn() as conn:
        conn.execute("INSERT INTO sso_clients(client_id, client_secret, name, redirect_uris, enabled, created_at) VALUES (?,?,?,?,?,?)",
                     (cid, secret, payload.name.strip(), payload.redirect_uris.strip(), 1 if payload.enabled else 0, utc_now().isoformat()))
    return {"ok": True, "client_id": cid, "client_secret": secret}


@app.put("/api/sso/clients/{cid_id}")
def sso_update_client(cid_id: int, payload: SsoClientIn, _sess: dict = Depends(require_super_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        r = conn.execute("SELECT id FROM sso_clients WHERE id = ?", (cid_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบ client")
        conn.execute("UPDATE sso_clients SET name = ?, redirect_uris = ?, enabled = ? WHERE id = ?",
                     (payload.name.strip(), payload.redirect_uris.strip(), 1 if payload.enabled else 0, cid_id))
    return {"ok": True}


@app.post("/api/sso/clients/{cid_id}/rotate")
def sso_rotate_secret(cid_id: int, _sess: dict = Depends(require_super_admin)) -> dict[str, Any]:
    secret = secrets.token_urlsafe(32)
    with db_conn() as conn:
        r = conn.execute("SELECT id FROM sso_clients WHERE id = ?", (cid_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบ client")
        conn.execute("UPDATE sso_clients SET client_secret = ? WHERE id = ?", (secret, cid_id))
    return {"ok": True, "client_secret": secret}


@app.delete("/api/sso/clients/{cid_id}")
def sso_delete_client(cid_id: int, _sess: dict = Depends(require_super_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        conn.execute("DELETE FROM sso_clients WHERE id = ?", (cid_id,))
    return {"ok": True}


@app.get("/api/sso/embed-token")
def sso_embed_token(client_id: str = "",
                    fct_session: Optional[str] = Cookie(default=None),
                    fct_member_session: Optional[str] = Cookie(default=None)) -> dict[str, Any]:
    """v1.9.213 — Beat ออก id_token ให้ผู้ใช้ปัจจุบัน เพื่อ auto-login ระบบที่ฝัง iframe (first-party)"""
    ident = _sso_current_identity(fct_session, fct_member_session)
    if not ident:
        raise HTTPException(status_code=401, detail="ยังไม่ได้เข้าสู่ระบบ")
    cid = (client_id or TV_MONITOR_CLIENT_ID).strip()
    client = _sso_get_client(cid)
    if not client or not client["enabled"]:
        raise HTTPException(status_code=404, detail="ไม่พบ SSO client — สร้างใน Setting › SSO ก่อน")
    # v1.9.215 — ถ้า client ผูกกับ IAM module → member ต้องมีสิทธิ์ module นั้น (admin ผ่านเสมอ)
    need_mod = SSO_CLIENT_MODULE.get(cid)
    if need_mod and ident["role"] != "admin" and str(ident["sub"]).startswith("member:"):
        try:
            mid = int(str(ident["sub"]).split(":", 1)[1])
        except (ValueError, IndexError):
            mid = None
        with db_conn() as conn:
            row = conn.execute("SELECT is_admin FROM members WHERE id = ?", (mid,)).fetchone() if mid else None
            is_admin = bool(row["is_admin"]) if row else False
            mods = _member_accessible_modules(conn, mid, is_admin) if mid else []
        if not is_admin and need_mod not in mods:
            raise HTTPException(status_code=403, detail="คุณไม่มีสิทธิ์เข้าถึงเมนูนี้")
    now = int(utc_now().timestamp())
    claims = {"iss": SSO_ISSUER, "sub": ident["sub"], "aud": cid, "iat": now, "exp": now + SSO_ID_TOKEN_TTL,
              "name": ident["name"], "email": ident["email"], "role": ident["role"]}
    return {"id_token": _sso_jwt_encode(claims, client["client_secret"]), "expires_in": SSO_ID_TOKEN_TTL}


@app.get("/api/tv-config")
def tv_config(_sess: dict = Depends(_require_module("tv"))) -> dict[str, Any]:
    return {"base": TV_MONITOR_BASE_URL, "client_id": TV_MONITOR_CLIENT_ID}


# ===========================================================================
# v1.9.218 — Credit Card reconciliation (จับคู่รายการบัตรเครดิต ↔ invoice/receipt)
# ===========================================================================
class CcPageIn(BaseModel):
    image_data: Optional[str] = None
    ocr_text: Optional[str] = Field(None, max_length=300000)


class CcTxnIn(BaseModel):
    txn_date: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None


class CcBillIn(BaseModel):
    card_number: Optional[str] = None
    bill_month: Optional[int] = None
    bill_year: Optional[int] = None
    note: Optional[str] = None
    due_date: Optional[str] = Field(None, max_length=20)   # v1.9.343 — ISO YYYY-MM-DD
    pages: list[CcPageIn] = Field(default_factory=list)
    transactions: list[CcTxnIn] = Field(default_factory=list)


class CcInvoiceIn(BaseModel):
    bill_id: Optional[int] = None              # ว่าง = ลอยไว้ (ยังไม่ผูกบิล)
    company: Optional[str] = None
    kind: str = Field("invoice", pattern="^(invoice|receipt)$")
    inv_month: Optional[int] = None
    inv_year: Optional[int] = None
    inv_day: Optional[int] = None                # v1.9.391 — วันบนใบเสร็จ (1-31)
    amount: Optional[float] = None
    description: Optional[str] = Field(None, max_length=2000)
    # v1.9.306 — เลข Job / ชื่อสินค้า / AM ที่ดูแล / หมายเหตุ
    job_number: Optional[str] = Field(None, max_length=200)
    product_name: Optional[str] = Field(None, max_length=300)
    am_name: Optional[str] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=2000)
    expense_category: Optional[str] = Field(None, max_length=30)   # v1.9.309
    uploaded_by_id: Optional[int] = None       # ว่าง = ใช้ผู้ล็อกอินปัจจุบัน
    file_data: Optional[str] = None
    file_name: Optional[str] = None
    file_mime: Optional[str] = None
    ocr_text: Optional[str] = Field(None, max_length=300000)


class CcInvoiceEdit(BaseModel):
    company: Optional[str] = None
    kind: str = Field("invoice", pattern="^(invoice|receipt)$")
    inv_month: Optional[int] = None
    inv_year: Optional[int] = None
    inv_day: Optional[int] = None                # v1.9.391
    amount: Optional[float] = None
    description: Optional[str] = Field(None, max_length=2000)
    # v1.9.306
    job_number: Optional[str] = Field(None, max_length=200)
    product_name: Optional[str] = Field(None, max_length=300)
    am_name: Optional[str] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=2000)
    expense_category: Optional[str] = Field(None, max_length=30)   # v1.9.309
    uploaded_by_id: Optional[int] = None       # ว่าง = คงผู้อัพโหลดเดิม


class CcBillEdit(BaseModel):
    card_number: Optional[str] = None
    bill_month: Optional[int] = None
    bill_year: Optional[int] = None
    note: Optional[str] = None
    due_date: Optional[str] = Field(None, max_length=20)   # v1.9.343
    transactions: list[dict] = Field(default_factory=list)   # [{id?, txn_date, description, amount}]


class CcMatchIn(BaseModel):
    transaction_id: int
    invoice_id: int


def _cc_ident(fct_session, fct_member_session):
    ident = _sso_current_identity(fct_session, fct_member_session) or {}
    sub = ident.get("sub") or ""
    mid = None
    if sub.startswith("member:"):
        try:
            mid = int(sub.split(":", 1)[1])
        except (ValueError, IndexError):
            mid = None
    return mid, (ident.get("name") or "")


def _cc_member_name(conn, mid: Optional[int]) -> Optional[str]:
    if not mid:
        return None
    r = conn.execute("SELECT display_name, email FROM members WHERE id=?", (mid,)).fetchone()
    if not r:
        return None
    return r["display_name"] or r["email"] or f"member#{mid}"


@app.get("/api/creditcard/members")
def cc_members(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    """รายชื่อสมาชิกสำหรับเลือกผู้อัพโหลด/เจ้าของเอกสาร (profile)"""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, display_name, email, avatar_data FROM members "
            "WHERE enabled IS NULL OR enabled=1 ORDER BY display_name COLLATE NOCASE").fetchall()
    return {"members": [{"id": r["id"], "name": r["display_name"] or r["email"] or f"member#{r['id']}",
                         "avatar": r["avatar_data"]} for r in rows]}


@app.get("/api/creditcard/bills")
def cc_list_bills(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        bills = conn.execute(
            "SELECT * FROM cc_bills ORDER BY COALESCE(bill_year,0) DESC, COALESCE(bill_month,0) DESC, id DESC"
        ).fetchall()
        out = []
        for b in bills:
            bid = b["id"]
            tx = conn.execute("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM cc_transactions WHERE bill_id=?", (bid,)).fetchone()
            inv = conn.execute("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM cc_invoices WHERE bill_id=?", (bid,)).fetchone()
            mt = conn.execute("SELECT COUNT(DISTINCT transaction_id) c FROM cc_matches WHERE bill_id=?", (bid,)).fetchone()
            pg = conn.execute("SELECT COUNT(*) c FROM cc_statement_pages WHERE bill_id=?", (bid,)).fetchone()
            out.append({**dict(b), "txn_count": tx["c"], "txn_total": tx["s"],
                        "invoice_count": inv["c"], "invoice_total": inv["s"],
                        "matched_txn": mt["c"], "page_count": pg["c"]})
    return {"bills": out}


@app.post("/api/creditcard/bills")
def cc_create_bill(payload: CcBillIn,
                   fct_session: Optional[str] = Cookie(default=None),
                   fct_member_session: Optional[str] = Cookie(default=None),
                   _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    mid, name = _cc_ident(fct_session, fct_member_session)
    now = utc_now().isoformat()
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO cc_bills(card_number,bill_month,bill_year,note,due_date,created_by_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (payload.card_number, payload.bill_month, payload.bill_year, payload.note,
             (payload.due_date or "").strip() or None, mid, name, now))
        bid = cur.lastrowid
        for i, pg in enumerate(payload.pages):
            conn.execute("INSERT INTO cc_statement_pages(bill_id,page_order,image_data,ocr_text,created_at) VALUES (?,?,?,?,?)",
                         (bid, i, pg.image_data, pg.ocr_text, now))
        for i, t in enumerate(payload.transactions):
            conn.execute("INSERT INTO cc_transactions(bill_id,txn_date,description,amount,row_order,created_at) VALUES (?,?,?,?,?,?)",
                         (bid, t.txn_date, t.description, t.amount, i, now))
    return {"ok": True, "id": bid}


@app.get("/api/creditcard/bills/{bid}")
def cc_bill_detail(bid: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        b = conn.execute("SELECT * FROM cc_bills WHERE id=?", (bid,)).fetchone()
        if not b:
            raise HTTPException(status_code=404, detail="ไม่พบบิล")
        txns = conn.execute("SELECT * FROM cc_transactions WHERE bill_id=? ORDER BY row_order, id", (bid,)).fetchall()
        invs = conn.execute(
            "SELECT id,bill_id,company,kind,inv_month,inv_year,amount,description,job_number,product_name,am_name,note,expense_category,file_name,file_mime,ocr_text,uploaded_by,uploaded_by_id,created_at "
            "FROM cc_invoices WHERE bill_id=? ORDER BY id", (bid,)).fetchall()
        matches = conn.execute("SELECT * FROM cc_matches WHERE bill_id=?", (bid,)).fetchall()
        pages = conn.execute("SELECT id,page_order FROM cc_statement_pages WHERE bill_id=? ORDER BY page_order", (bid,)).fetchall()
        pool = conn.execute(
            "SELECT id,bill_id,company,kind,inv_month,inv_year,amount,description,job_number,product_name,am_name,note,expense_category,file_name,file_mime,uploaded_by,uploaded_by_id,created_at "
            "FROM cc_invoices WHERE bill_id IS NULL ORDER BY id DESC", ()).fetchall()
    return {"bill": dict(b),
            "transactions": [dict(t) for t in txns],
            "invoices": [dict(i) for i in invs],
            "pool_invoices": [dict(p) for p in pool],
            "matches": [dict(m) for m in matches],
            "pages": [dict(p) for p in pages]}


# v1.9.341 — เอกสารต้นฉบับของบิล (statement pages): ดูรูป / อัพเพิ่ม / ลบ
@app.get("/api/creditcard/bills/{bid}/pages/{page_id}/image")
def cc_bill_page_image(bid: int, page_id: int,
                       _sess: dict = Depends(_require_module("platform"))) -> Response:
    with db_conn() as conn:
        r = conn.execute("SELECT image_data FROM cc_statement_pages WHERE id=? AND bill_id=?",
                         (page_id, bid)).fetchone()
    if not r or not r["image_data"]:
        raise HTTPException(status_code=404, detail="ไม่มีรูป")
    raw = r["image_data"]
    mime = "image/jpeg"
    if raw.startswith("data:"):
        head, _, b64 = raw.partition(",")
        if ";base64" in head and head[5:].split(";")[0]:
            mime = head[5:].split(";")[0]
        raw = b64
    try:
        data = base64.b64decode(raw)
    except Exception:
        raise HTTPException(status_code=500, detail="ไฟล์เสียหาย")
    return Response(content=data, media_type=mime)


class CcPagesAddIn(BaseModel):
    pages: list[CcPageIn] = Field(default_factory=list)


@app.post("/api/creditcard/bills/{bid}/pages")
def cc_add_bill_pages(bid: int, payload: CcPagesAddIn,
                      _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    if not payload.pages:
        raise HTTPException(status_code=400, detail="ไม่มีหน้าเอกสาร")
    now = utc_now().isoformat()
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM cc_bills WHERE id=?", (bid,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบบิล")
        next_order = conn.execute(
            "SELECT COALESCE(MAX(page_order), -1) + 1 AS n FROM cc_statement_pages WHERE bill_id=?",
            (bid,)).fetchone()["n"]
        ids = []
        for i, p in enumerate(payload.pages):
            cur = conn.execute(
                "INSERT INTO cc_statement_pages(bill_id,page_order,image_data,ocr_text,created_at) "
                "VALUES (?,?,?,?,?)",
                (bid, next_order + i, p.image_data, p.ocr_text, now))
            ids.append(cur.lastrowid)
    return {"ok": True, "ids": ids}


@app.delete("/api/creditcard/bills/{bid}/pages/{page_id}")
def cc_delete_bill_page(bid: int, page_id: int,
                        _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM cc_statement_pages WHERE id=? AND bill_id=?", (page_id, bid))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="ไม่พบหน้าเอกสาร")
    return {"ok": True}


# v1.9.363 — Analytics: รายการทุกใบ (join บิล) → JS aggregate/filter/detect platform เอง
@app.get("/api/creditcard/analytics-transactions")
def cc_analytics_transactions(_sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT t.id, t.txn_date, t.description, t.amount, t.user_note, "
            "       b.id AS bill_id, b.card_number, b.bill_month, b.bill_year "
            "FROM cc_transactions t JOIN cc_bills b ON b.id = t.bill_id "
            "WHERE t.amount IS NOT NULL "
            "ORDER BY COALESCE(b.bill_year,0), COALESCE(b.bill_month,0)"
        ).fetchall()
    return {"transactions": [dict(r) for r in rows]}


# v1.9.381 — Absence: proxy ดึงเมลแจ้งลาจาก Microsoft Graph (me/messages)
# ผู้ใช้วาง access token เอง (จาก Graph Explorer) → ส่งมาเป็น Bearer เหมือน pattern Wazzup
_ABSENCE_SENDER = "notify.tigersoft1998@gmail.com"


@app.get("/api/absence/messages")
def absence_messages(request: Request, _sess: dict = Depends(require_admin_or_member)) -> dict[str, Any]:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="ต้องมี Microsoft Graph access token (Bearer) — วาง token จาก Graph Explorer")
    token = auth.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="access token ว่าง")
    from urllib.parse import quote
    flt = quote(f"from/emailAddress/address eq '{_ABSENCE_SENDER}'")
    # v1.9.383 — ดึง body เต็มมาด้วย (plain text ผ่าน Prefer header) เพื่อ parse วันลา
    sel = quote("subject,receivedDateTime,bodyPreview,body,from")
    url = (f"https://graph.microsoft.com/v1.0/me/messages?$filter={flt}"
           f"&$select={sel}&$top=25")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Prefer": 'outlook.body-content-type="text"',
    }
    out: list[dict[str, Any]] = []
    pages = 0
    while url and pages < 40:
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:400]
            except Exception:
                pass
            if e.code == 401:
                raise HTTPException(status_code=401, detail="token หมดอายุ/ไม่ถูกต้อง — ขอ token ใหม่จาก Graph Explorer")
            if e.code == 403:
                raise HTTPException(status_code=403, detail="token ไม่มีสิทธิ์ Mail.Read — เปิด scope Mail.Read ใน Graph Explorer แล้วขอ token ใหม่")
            raise HTTPException(status_code=502, detail=f"Microsoft Graph error HTTP {e.code}: {body}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"เชื่อมต่อ Microsoft Graph ไม่สำเร็จ: {e}")
        try:
            data = _json.loads(raw)
        except Exception:
            raise HTTPException(status_code=502, detail="Graph response ไม่ใช่ JSON")
        out.extend(data.get("value", []) or [])
        url = data.get("@odata.nextLink")
        pages += 1
    # v1.9.381 — เอาเฉพาะปี 2026 (ตาม receivedDateTime = ISO 8601, ปีอยู่ 4 ตัวแรก)
    msgs: list[dict[str, Any]] = []
    for m in out:
        rd = m.get("receivedDateTime") or ""
        if rd[:4] == "2026":
            frm = (m.get("from") or {}).get("emailAddress") or {}
            body = m.get("body") or {}
            msgs.append({
                "subject": m.get("subject") or "",
                "receivedDateTime": rd,
                "bodyPreview": m.get("bodyPreview") or "",
                "bodyText": (body.get("content") or "")[:8000],
                "from": frm.get("address") or "",
            })
    msgs.sort(key=lambda x: x["receivedDateTime"])
    return {"messages": msgs, "total_fetched": len(out), "sender": _ABSENCE_SENDER}


# v1.9.352 — ค้นหารายการในบัตรทุกใบ (description + user_note) — ใช้ใน popup search
@app.get("/api/creditcard/search-transactions")
def cc_search_transactions(q: str = "",
                           _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    q = (q or "").strip()
    with db_conn() as conn:
        sql = ("SELECT t.id, t.txn_date, t.description, t.amount, t.user_note, "
               "       b.id AS bill_id, b.card_number, b.bill_month, b.bill_year "
               "FROM cc_transactions t JOIN cc_bills b ON b.id = t.bill_id ")
        params: list[Any] = []
        if q:
            sql += "WHERE t.description LIKE ? OR t.user_note LIKE ? "
            like = f"%{q}%"
            params += [like, like]
        sql += ("ORDER BY COALESCE(b.bill_year,0) DESC, COALESCE(b.bill_month,0) DESC, "
                "t.row_order, t.id LIMIT 500")
        rows = conn.execute(sql, params).fetchall()
        # v1.9.353 — แนบ invoice ที่จับคู่แล้วของแต่ละรายการ (ใช้แสดง chip + เปิดดูเอกสาร)
        out = [dict(r) for r in rows]
        if out:
            ids = [t["id"] for t in out]
            pl = ",".join("?" * len(ids))
            mrows = conn.execute(
                f"SELECT m.transaction_id, i.id, i.company, i.kind, i.amount, "
                f"       i.inv_month, i.inv_year, i.description, i.file_name, i.file_mime, "
                f"       i.uploaded_by, i.uploaded_by_id "
                f"FROM cc_matches m JOIN cc_invoices i ON i.id = m.invoice_id "
                f"WHERE m.transaction_id IN ({pl})", ids).fetchall()
            by_txn: dict[int, list[dict[str, Any]]] = {}
            for r in mrows:
                d = dict(r)
                tid = d.pop("transaction_id")
                by_txn.setdefault(tid, []).append(d)
            for t in out:
                t["invoices"] = by_txn.get(t["id"], [])
    return {"transactions": out if rows else []}


# v1.9.344 — toggle เสร็จสิ้น (completed) ของบิล
class CcBillCompletedIn(BaseModel):
    completed: bool


@app.patch("/api/creditcard/bills/{bid}/completed")
def cc_set_bill_completed(bid: int, payload: CcBillCompletedIn,
                          _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    now = utc_now().isoformat()
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM cc_bills WHERE id=?", (bid,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบบิล")
        conn.execute("UPDATE cc_bills SET is_completed=?, completed_at=?, updated_at=? WHERE id=?",
                     (1 if payload.completed else 0, now if payload.completed else None, now, bid))
    return {"ok": True, "is_completed": payload.completed}


@app.delete("/api/creditcard/bills/{bid}")
def cc_delete_bill(bid: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        conn.execute("PRAGMA foreign_keys = ON")   # cascade ลบ pages/transactions/invoices(ที่ผูกบิล)/matches
        conn.execute("DELETE FROM cc_bills WHERE id=?", (bid,))
    return {"ok": True}


@app.post("/api/creditcard/invoices")
def cc_create_invoice(payload: CcInvoiceIn,
                      fct_session: Optional[str] = Cookie(default=None),
                      fct_member_session: Optional[str] = Cookie(default=None),
                      _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    mid, name = _cc_ident(fct_session, fct_member_session)
    now = utc_now().isoformat()
    with db_conn() as conn:
        if payload.bill_id is not None and not conn.execute("SELECT 1 FROM cc_bills WHERE id=?", (payload.bill_id,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบบิลปลายทาง")
        # ผู้อัพโหลด: ถ้าระบุ member มา → ใช้คนนั้น (เจ้าของเอกสาร), ไม่งั้นใช้ผู้ล็อกอิน
        up_id, up_name = mid, name
        if payload.uploaded_by_id:
            up_id = payload.uploaded_by_id
            up_name = _cc_member_name(conn, payload.uploaded_by_id) or name
        _s = lambda v: (v.strip() if isinstance(v, str) else v) or None
        _day = payload.inv_day if (payload.inv_day and 1 <= payload.inv_day <= 31) else None
        cur = conn.execute(
            "INSERT INTO cc_invoices(bill_id,company,kind,inv_month,inv_year,inv_day,amount,description,"
            "job_number,product_name,am_name,note,expense_category,file_data,file_name,file_mime,ocr_text,uploaded_by_id,uploaded_by,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (payload.bill_id, payload.company, payload.kind, payload.inv_month, payload.inv_year, _day, payload.amount,
             payload.description, _s(payload.job_number), _s(payload.product_name), _s(payload.am_name), _s(payload.note),
             _s(payload.expense_category), payload.file_data, payload.file_name, payload.file_mime, payload.ocr_text, up_id, up_name, now))
    return {"ok": True, "id": cur.lastrowid}


@app.put("/api/creditcard/invoices/{iid}")
def cc_edit_invoice(iid: int, payload: CcInvoiceEdit, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM cc_invoices WHERE id=?", (iid,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบ invoice")
        _s = lambda v: (v.strip() if isinstance(v, str) else v) or None
        _day = payload.inv_day if (payload.inv_day and 1 <= payload.inv_day <= 31) else None
        conn.execute("UPDATE cc_invoices SET company=?, kind=?, inv_month=?, inv_year=?, inv_day=?, amount=?, description=?, "
                     "job_number=?, product_name=?, am_name=?, note=?, expense_category=? WHERE id=?",
                     (payload.company, payload.kind, payload.inv_month, payload.inv_year, _day, payload.amount, payload.description,
                      _s(payload.job_number), _s(payload.product_name), _s(payload.am_name), _s(payload.note),
                      _s(payload.expense_category), iid))
        # เปลี่ยนผู้อัพโหลด/เจ้าของเอกสาร (ถ้าเลือก member มา)
        if payload.uploaded_by_id:
            conn.execute("UPDATE cc_invoices SET uploaded_by_id=?, uploaded_by=? WHERE id=?",
                         (payload.uploaded_by_id, _cc_member_name(conn, payload.uploaded_by_id), iid))
    return {"ok": True}


@app.get("/api/creditcard/pool-invoices")
def cc_pool_invoices(scope: str = "unmatched",
                     _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    """รายการใบเสร็จ/invoice
    scope='unmatched' (default) → เฉพาะที่ยังไม่จับคู่ (ลอย + ผูกบิลแต่ยังไม่ match)
    scope='all' → ทุกใบ พร้อมข้อมูลว่าจับคู่กับอะไร (matched_txn / matched_bill)"""
    cols = ("id,bill_id,company,kind,inv_month,inv_year,inv_day,amount,description,"
            "job_number,product_name,am_name,note,expense_category,file_name,file_mime,"
            "uploaded_by,uploaded_by_id,created_at")
    with db_conn() as conn:
        rows = conn.execute(
            f"SELECT {cols} FROM cc_invoices ORDER BY id DESC").fetchall()
        # map invoice_id → ข้อมูลรายการที่จับคู่ + บิล
        match_rows = conn.execute(
            "SELECT m.invoice_id, t.description AS txn_desc, t.amount AS txn_amount, "
            "       b.id AS bill_id, b.card_number, b.bill_month, b.bill_year "
            "FROM cc_matches m "
            "JOIN cc_transactions t ON t.id = m.transaction_id "
            "JOIN cc_bills b ON b.id = m.bill_id").fetchall()
        matched_map: dict[int, dict[str, Any]] = {}
        for r in match_rows:
            matched_map[r["invoice_id"]] = {
                "txn_description": r["txn_desc"], "txn_amount": r["txn_amount"],
                "bill_id": r["bill_id"], "card_number": r["card_number"],
                "bill_month": r["bill_month"], "bill_year": r["bill_year"],
            }
    out = []
    for r in rows:
        d = dict(r)
        m = matched_map.get(d["id"])
        d["matched"] = m if m else None
        if scope == "all" or m is None:
            out.append(d)
    return {"invoices": out, "scope": scope}


@app.put("/api/creditcard/bills/{bid}")
def cc_edit_bill(bid: int, payload: CcBillEdit, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    now = utc_now().isoformat()
    with db_conn() as conn:
        conn.execute("PRAGMA foreign_keys = ON")   # ลบรายการที่หาย → cascade ลบ match ของแถวนั้น (ต้องสั่งก่อน DML)
        if not conn.execute("SELECT 1 FROM cc_bills WHERE id=?", (bid,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบบิล")
        conn.execute("UPDATE cc_bills SET card_number=?, bill_month=?, bill_year=?, note=?, due_date=?, updated_at=? WHERE id=?",
                     (payload.card_number, payload.bill_month, payload.bill_year, payload.note,
                      (payload.due_date or "").strip() or None, now, bid))
        # upsert transactions by id; delete ที่หายไป (รักษา match ของแถวเดิมที่ไม่ถูกลบ)
        keep_ids = []
        for i, t in enumerate(payload.transactions):
            tid = t.get("id")
            date = t.get("txn_date")
            desc = t.get("description")
            amt = t.get("amount")
            if tid and conn.execute("SELECT 1 FROM cc_transactions WHERE id=? AND bill_id=?", (tid, bid)).fetchone():
                conn.execute("UPDATE cc_transactions SET txn_date=?, description=?, amount=?, row_order=? WHERE id=?",
                             (date, desc, amt, i, tid))
                keep_ids.append(tid)
            else:
                cur = conn.execute("INSERT INTO cc_transactions(bill_id,txn_date,description,amount,row_order,created_at) VALUES (?,?,?,?,?,?)",
                                   (bid, date, desc, amt, i, now))
                keep_ids.append(cur.lastrowid)
        if keep_ids:
            ph = ",".join("?" * len(keep_ids))
            conn.execute(f"DELETE FROM cc_transactions WHERE bill_id=? AND id NOT IN ({ph})", [bid] + keep_ids)
        else:
            conn.execute("DELETE FROM cc_transactions WHERE bill_id=?", (bid,))
    return {"ok": True}


# v1.9.314 — บันทึก description (user_note) ของรายการในบัตร แบบ inline
class CcTxnNoteIn(BaseModel):
    user_note: Optional[str] = Field(None, max_length=500)


@app.patch("/api/creditcard/transactions/{tid}")
def cc_update_txn_note(tid: int, payload: CcTxnNoteIn,
                       _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        r = conn.execute("SELECT 1 FROM cc_transactions WHERE id=?", (tid,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบรายการ")
        note = (payload.user_note or "").strip() or None
        conn.execute("UPDATE cc_transactions SET user_note=? WHERE id=?", (note, tid))
    return {"ok": True, "user_note": note}


# v1.9.360 — แก้ชื่อเอกสาร (company) แบบ inline จากหน้า preview
class CcInvoiceCompanyIn(BaseModel):
    company: Optional[str] = Field(None, max_length=300)


@app.patch("/api/creditcard/invoices/{iid}/company")
def cc_update_invoice_company(iid: int, payload: CcInvoiceCompanyIn,
                              _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        if not conn.execute("SELECT 1 FROM cc_invoices WHERE id=?", (iid,)).fetchone():
            raise HTTPException(status_code=404, detail="ไม่พบ invoice")
        company = (payload.company or "").strip() or None
        conn.execute("UPDATE cc_invoices SET company=? WHERE id=?", (company, iid))
    return {"ok": True, "company": company}


@app.get("/api/creditcard/invoices/{iid}/file")
def cc_invoice_file(iid: int, _sess: dict = Depends(_require_module("platform"))) -> Response:
    with db_conn() as conn:
        r = conn.execute("SELECT file_data,file_mime,file_name FROM cc_invoices WHERE id=?", (iid,)).fetchone()
    if not r or not r["file_data"]:
        raise HTTPException(status_code=404, detail="ไม่มีไฟล์")
    raw_b64 = r["file_data"]
    mime = r["file_mime"] or "application/octet-stream"
    if raw_b64.startswith("data:"):
        head, _, b64 = raw_b64.partition(",")
        if ";base64" in head and head[5:].split(";")[0]:
            mime = head[5:].split(";")[0]
        raw_b64 = b64
    try:
        data = base64.b64decode(raw_b64)
    except Exception:
        raise HTTPException(status_code=500, detail="ไฟล์เสียหาย")
    return Response(content=data, media_type=mime)


# v1.9.350 — ถอด invoice ออกจากบิล (ปล่อยลอย) — ใช้ย้ายใบที่อัพผิดบิลไปใช้กับบิลอื่น
@app.post("/api/creditcard/invoices/{iid}/detach")
def cc_detach_invoice(iid: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        r = conn.execute("SELECT bill_id FROM cc_invoices WHERE id=?", (iid,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="ไม่พบ invoice")
        if r["bill_id"] is None:
            raise HTTPException(status_code=400, detail="invoice นี้ลอยอยู่แล้ว")
        if conn.execute("SELECT 1 FROM cc_matches WHERE invoice_id=?", (iid,)).fetchone():
            raise HTTPException(status_code=400, detail="ต้องถอดการจับคู่ (✕) ก่อน จึงจะปล่อยลอยได้")
        conn.execute("UPDATE cc_invoices SET bill_id=NULL WHERE id=?", (iid,))
    return {"ok": True}


@app.delete("/api/creditcard/invoices/{iid}")
def cc_delete_invoice(iid: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        conn.execute("PRAGMA foreign_keys = ON")   # cascade ลบ matches ของ invoice นี้
        conn.execute("DELETE FROM cc_invoices WHERE id=?", (iid,))
    return {"ok": True}


@app.post("/api/creditcard/matches")
def cc_create_match(payload: CcMatchIn,
                    fct_session: Optional[str] = Cookie(default=None),
                    fct_member_session: Optional[str] = Cookie(default=None),
                    _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    _mid, name = _cc_ident(fct_session, fct_member_session)
    now = utc_now().isoformat()
    with db_conn() as conn:
        t = conn.execute("SELECT bill_id FROM cc_transactions WHERE id=?", (payload.transaction_id,)).fetchone()
        i = conn.execute("SELECT bill_id FROM cc_invoices WHERE id=?", (payload.invoice_id,)).fetchone()
        if not t or not i:
            raise HTTPException(status_code=404, detail="ไม่พบรายการ/invoice")
        # invoice ลอย (bill_id NULL) → ผูกเข้ากับบิลของรายการนี้อัตโนมัติ
        if i["bill_id"] is None:
            conn.execute("UPDATE cc_invoices SET bill_id=? WHERE id=?", (t["bill_id"], payload.invoice_id))
        elif t["bill_id"] != i["bill_id"]:
            raise HTTPException(status_code=400, detail="invoice นี้ผูกกับบิลอื่นอยู่แล้ว")
        conn.execute(
            "INSERT OR IGNORE INTO cc_matches(bill_id,transaction_id,invoice_id,created_by,created_at) VALUES (?,?,?,?,?)",
            (t["bill_id"], payload.transaction_id, payload.invoice_id, name, now))
        m = conn.execute("SELECT id FROM cc_matches WHERE transaction_id=? AND invoice_id=?",
                         (payload.transaction_id, payload.invoice_id)).fetchone()
    return {"ok": True, "id": m["id"] if m else None}


@app.delete("/api/creditcard/matches/{mid}")
def cc_delete_match(mid: int, _sess: dict = Depends(_require_module("platform"))) -> dict[str, Any]:
    with db_conn() as conn:
        conn.execute("DELETE FROM cc_matches WHERE id=?", (mid,))
    return {"ok": True}


# ===========================================================================
# v1.9.172 — Ads: targeting/audience ของแคมเปญ (ดึง breakdown หลายตัวจาก Windsor)
# ===========================================================================
@app.get("/api/ads-campaign-targeting")
def ads_campaign_targeting(campaign: str, days: int = 30, _sess: dict = Depends(_require_module("ads"))) -> dict[str, Any]:
    if not WINDSOR_API_KEY:
        raise HTTPException(status_code=503, detail="ยังไม่ได้ตั้งค่า WINDSOR_API_KEY")
    days = max(1, min(int(days or 30), 90))
    today = utc_now().date()
    date_to = today.isoformat()
    date_from = (today - timedelta(days=days - 1)).isoformat()
    import re as _re

    def _ckey(s):  # normalize campaign string (collapse tabs/spaces) for robust matching
        return _re.sub(r"\s+", " ", str(s or "")).strip().lower()

    camp_l = _ckey(campaign)
    if not camp_l:
        raise HTTPException(status_code=400, detail="ต้องระบุ campaign")

    def _f(v):
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    # แต่ละ breakdown ดึงแยก (Meta ไม่ยอมรวมหลาย breakdown ในคิวรีเดียว)
    # age/gender → connector "facebook" เท่านั้น (connector "all" รวม twitter ซึ่ง reject age/gender → HTTP 500 ทั้งคิวรี)
    queries = {
        "age": ("campaign,age,spend", "facebook"),
        "gender": ("campaign,gender,spend", "facebook"),
        "placement": ("campaign,platform_position,spend", "all"),
        "region": ("campaign,region,spend", "all"),
        "adset": ("campaign,adset_name,adsset_optimization_goal,adset_destination_type,spend", "facebook"),
    }
    import concurrent.futures as _cf
    results: dict[str, list] = {}
    errs: dict[str, str] = {}
    with _cf.ThreadPoolExecutor(max_workers=5) as ex:
        futs = {k: ex.submit(_windsor_get, q, date_from, date_to, 45, conn) for k, (q, conn) in queries.items()}
        for k, fu in futs.items():
            try:
                results[k] = fu.result()
            except urllib.error.HTTPError as e:
                results[k] = []
                body = e.read().decode("utf-8", errors="replace")[:200] if hasattr(e, "read") else ""
                errs[k] = f"HTTP {e.code} {body}"
            except Exception as e:
                results[k] = []
                errs[k] = str(e)[:200]

    def _norm_age(v):
        v = str(v or "").strip()
        return v.replace("AGE_", "").replace("_", "-").replace(" to ", "-") or "(ไม่ระบุ)"

    def _norm_gender(v):
        v = str(v or "").strip().lower()
        return {"male": "ชาย", "female": "หญิง", "unknown": "ไม่ระบุ", "none": "ไม่ระบุ", "": "ไม่ระบุ"}.get(v, v)

    matched_counts: dict[str, int] = {}

    def _agg(bk, key, norm=lambda x: (str(x or "").strip() or "(ไม่ระบุ)")):
        rows = results.get(bk, [])
        out: dict[str, float] = {}
        m = 0
        for r in rows:
            if not isinstance(r, dict):
                continue
            if _ckey(r.get("campaign")) != camp_l:
                continue
            m += 1
            out[norm(r.get(key))] = out.get(norm(r.get(key)), 0.0) + _f(r.get("spend"))
        matched_counts[bk] = m
        return sorted(({"label": k, "spend": round(v, 2)} for k, v in out.items() if v > 0),
                      key=lambda x: x["spend"], reverse=True)

    age = _agg("age", "age", _norm_age)
    gender = _agg("gender", "gender", _norm_gender)
    placement = _agg("placement", "platform_position")
    region = _agg("region", "region")[:12]
    # ad sets + settings
    adsets: dict[str, Any] = {}
    _adset_m = 0
    for r in results.get("adset", []):
        if not isinstance(r, dict):
            continue
        if _ckey(r.get("campaign")) != camp_l:
            continue
        _adset_m += 1
        nm = (str(r.get("adset_name") or "").strip()) or "(ไม่ระบุ)"
        a = adsets.setdefault(nm, {"name": nm, "spend": 0.0, "optimization": set(), "destination": set()})
        a["spend"] += _f(r.get("spend"))
        og = str(r.get("adsset_optimization_goal") or "").strip()
        if og:
            a["optimization"].add(og)
        de = str(r.get("adset_destination_type") or "").strip()
        if de and de.upper() != "UNDEFINED":
            a["destination"].add(de)
    adset_list = sorted(
        ({"name": a["name"], "spend": round(a["spend"], 2),
          "optimization": sorted(a["optimization"]), "destination": sorted(a["destination"])}
         for a in adsets.values()),
        key=lambda x: x["spend"], reverse=True,
    )
    matched_counts["adset"] = _adset_m
    diag = {k: {"fetched": len(results.get(k, [])), "matched": matched_counts.get(k, 0),
                "err": errs.get(k)} for k in queries}
    return {
        "campaign": campaign,
        "age": age, "gender": gender, "placement": placement, "region": region,
        "adsets": adset_list,
        "found": bool(age or gender or placement or region or adset_list),
        "_diag": diag,
        "days": days,
    }


# ===========================================================================
# v1.9.180 — Audience Report: ใช้จ่ายแยกตามกลุ่มอายุ (Age) → breakdown แคมเปญ
# ===========================================================================
@app.get("/api/ads-audience")
def ads_audience(days: int = 7, _sess: dict = Depends(_require_module("ads"))) -> dict[str, Any]:
    if not WINDSOR_API_KEY:
        raise HTTPException(status_code=503, detail="ยังไม่ได้ตั้งค่า WINDSOR_API_KEY")
    days = max(1, min(int(days or 7), 90))
    today = utc_now().date()
    date_to = today.isoformat()
    date_from = (today - timedelta(days=days - 1)).isoformat()

    # ทุก breakdown ใช้ connector "facebook" (Meta) เพื่อให้ยอดรวมตรงกันทุกตาราง
    # (connector "all" รวม twitter ซึ่ง reject age/gender → HTTP 500)
    dims = {"age": "age", "placement": "platform_position", "region": "region"}
    import concurrent.futures as _cf
    raw: dict[str, list] = {}
    errs: dict[str, str] = {}

    def _fetch(field):
        return _windsor_get(f"campaign,{field},spend,impressions,clicks,reach,currency,actions_video_view,actions_page_engagement", date_from, date_to, 60, "facebook")

    with _cf.ThreadPoolExecutor(max_workers=3) as ex:
        futs = {k: ex.submit(_fetch, f) for k, f in dims.items()}
        for k, fu in futs.items():
            try:
                raw[k] = fu.result()
            except urllib.error.HTTPError as e:
                raw[k] = []
                body = e.read().decode("utf-8", errors="replace")[:200] if hasattr(e, "read") else ""
                errs[k] = f"HTTP {e.code} {body}"
            except Exception as e:
                raw[k] = []
                errs[k] = str(e)[:200]
    if errs.get("age") and not raw.get("age") and not raw.get("placement") and not raw.get("region"):
        raise HTTPException(status_code=502, detail=f"ดึง Windsor ไม่สำเร็จ: {errs['age']}")

    def _f(v):
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    def _norm_age(v):
        v = str(v or "").strip()
        v = v.replace("AGE_", "").replace("_", "-").replace(" to ", "-")
        return v or "(ไม่ระบุ)"

    def _norm_plain(v):
        return (str(v or "").strip()) or "(ไม่ระบุ)"

    def _metrics(spend: float, impr: float, clk: float, reach: float, views: float = 0.0, eng: float = 0.0) -> dict[str, Any]:
        return {
            "spend": round(spend, 2),
            "impressions": int(round(impr)),
            "clicks": int(round(clk)),
            "reach": int(round(reach)),
            "views": int(round(views)),
            "engagements": int(round(eng)),
            "ctr": round(clk / impr * 100, 2) if impr else None,
            "cpc": round(spend / clk, 2) if clk else None,
            "cpm": round(spend / impr * 1000, 2) if impr else None,
            "cpv": round(spend / views, 4) if views else None,
            "cpe": round(spend / eng, 4) if eng else None,
            "frequency": round(impr / reach, 2) if reach else None,
        }

    _AGE_ORDER = {"13-17": 0, "18-24": 1, "25-34": 2, "35-44": 3, "45-54": 4, "55-64": 5, "65+": 6}

    def _build(rows, field, norm, order, limit=None):
        groups: dict[str, Any] = {}
        for r in rows:
            if not isinstance(r, dict):
                continue
            key = norm(r.get(field))
            camp = (str(r.get("campaign") or "").strip()) or "(ไม่ระบุแคมเปญ)"
            cur = (str(r.get("currency") or "").strip()) or "—"
            sp, im, ck, rc = _f(r.get("spend")), _f(r.get("impressions")), _f(r.get("clicks")), _f(r.get("reach"))
            vw = _f(r.get("actions_video_view"))
            en = _f(r.get("actions_page_engagement"))
            g = groups.setdefault(key, {"label": key, "campaigns": {}, "by_cur": {}, "impressions": 0.0, "clicks": 0.0, "reach": 0.0, "views": 0.0, "eng": 0.0})
            g["by_cur"][cur] = g["by_cur"].get(cur, 0.0) + sp
            g["impressions"] += im
            g["clicks"] += ck
            g["reach"] += rc
            g["views"] += vw
            g["eng"] += en
            c = g["campaigns"].setdefault(camp, {"campaign": camp, "currency": cur, "spend": 0.0, "impressions": 0.0, "clicks": 0.0, "reach": 0.0, "views": 0.0, "eng": 0.0})
            c["spend"] += sp
            c["impressions"] += im
            c["clicks"] += ck
            c["reach"] += rc
            c["views"] += vw
            c["eng"] += en
        if order == "age":
            keys = sorted(groups, key=lambda k: (_AGE_ORDER.get(k, 90), k))
        else:
            keys = sorted(groups, key=lambda k: sum(groups[k]["by_cur"].values()), reverse=True)
        tbc: dict[str, float] = {}
        for g in groups.values():
            for cur, v in g["by_cur"].items():
                tbc[cur] = tbc.get(cur, 0.0) + v
        total_n = len(keys)
        truncated = bool(limit and total_n > limit)
        if limit:
            keys = keys[:limit]
        out_rows = []
        for key in keys:
            g = groups[key]
            camps = sorted(
                ({"campaign": c["campaign"], "currency": c["currency"],
                  **_metrics(c["spend"], c["impressions"], c["clicks"], c["reach"], c["views"], c["eng"])}
                 for c in g["campaigns"].values()),
                key=lambda x: x["spend"], reverse=True,
            )
            out_rows.append({
                "label": key,
                "total_by_cur": {k: round(v, 2) for k, v in g["by_cur"].items()},
                **_metrics(sum(g["by_cur"].values()), g["impressions"], g["clicks"], g["reach"], g["views"], g["eng"]),
                "campaigns": camps,
            })
        return {
            "rows": out_rows,
            "total_by_cur": {k: round(v, 2) for k, v in tbc.items()},
            "shown": len(out_rows),
            "total": total_n,
            "truncated": truncated,
            "err": errs.get(field) or None,
        }

    t_age = _build(raw.get("age", []), "age", _norm_age, "age")
    t_place = _build(raw.get("placement", []), "platform_position", _norm_plain, "spend")
    t_region = _build(raw.get("region", []), "region", _norm_plain, "spend", limit=40)

    return {
        "days": days,
        "date_from": date_from,
        "date_to": date_to,
        "total_by_cur": t_age["total_by_cur"] or t_place["total_by_cur"] or t_region["total_by_cur"],
        "tables": {"age": t_age, "placement": t_place, "region": t_region},
    }


# ===========================================================================
# v1.9.162 — IAM: กำหนดสิทธิ์เข้าถึง module ต่อบุคคล/ทีม/ทั้งหมด
# ===========================================================================
IAM_MODULES = [
    {"key": "platform", "label": "Platform", "icon": "🚀", "desc": "เมนู Platforms"},
    {"key": "customer", "label": "Customer", "icon": "🌐", "desc": "เมนู Customer (Calendar / Websites / Services)"},
    {"key": "ads",      "label": "Ads",      "icon": "💰", "desc": "เมนู Ads (ยอดใช้จ่ายค่าโฆษณา)"},
    {"key": "tv",       "label": "TV",       "icon": "📺", "desc": "เมนู TV (TV Ad Monitor — ฝัง Scheduling)"},
    # v1.9.339 — Device & Software: กำหนดสิทธิ์ได้ถึงระดับเมนูย่อย
    {"key": "hw-dashboard", "label": "Device & Software · Dashboard",          "icon": "📊", "desc": "ภาพรวมคอมพิวเตอร์ + ปฏิทินการซื้อ"},
    {"key": "hw-pc",        "label": "Device & Software · Personal Computer",  "icon": "💻", "desc": "รายการ PC ทั้งหมด + แก้ไข"},
    {"key": "hw-central",   "label": "Device & Software · คอมส่วนกลาง",        "icon": "📦", "desc": "PC ที่ไม่มี owner (stock / ส่วนกลาง)"},
    {"key": "hw-device",    "label": "Device & Software · Device",             "icon": "📱", "desc": "อุปกรณ์อื่น (HDD / Monitor / WACOM ฯลฯ)"},
    {"key": "hw-network",   "label": "Device & Software · Network",            "icon": "📡", "desc": "อุปกรณ์เครือข่าย"},
    {"key": "hw-report",    "label": "Device & Software · Report",             "icon": "📑", "desc": "รายงานการเปลี่ยนเครื่อง"},
    {"key": "hw-findoc",    "label": "Device & Software · Financial Document", "icon": "💰", "desc": "เอกสารการสั่งซื้อ (invoice / ใบเสร็จ)"},
]
# v1.9.215 — client_id ของ SSO ที่ผูกกับ module (กันคนไม่มีสิทธิ์ขอ embed-token ไปเปิดเอง)
SSO_CLIENT_MODULE = {TV_MONITOR_CLIENT_ID: "tv"}
IAM_MODULE_KEYS = {m["key"] for m in IAM_MODULES}


def _member_accessible_modules(conn, member_id: int, is_admin: bool) -> list[str]:
    """v1.9.162 — module ที่ member นี้เข้าถึงได้ (admin เห็นทุก module)"""
    if is_admin:
        return [m["key"] for m in IAM_MODULES]
    team_ids = [r["team_id"] for r in conn.execute(
        "SELECT team_id FROM team_members WHERE member_id = ?", (member_id,)
    ).fetchall()]
    out = []
    for m in IAM_MODULES:
        mk = m["key"]
        cfg = conn.execute("SELECT mode FROM iam_module_config WHERE module_key = ?", (mk,)).fetchone()
        mode = cfg["mode"] if cfg else "restricted"
        if mode == "all":
            out.append(mk)
            continue
        if conn.execute("SELECT 1 FROM iam_module_members WHERE module_key = ? AND member_id = ?",
                        (mk, member_id)).fetchone():
            out.append(mk)
            continue
        if team_ids:
            pl = ",".join("?" * len(team_ids))
            if conn.execute(f"SELECT 1 FROM iam_module_teams WHERE module_key = ? AND team_id IN ({pl})",
                            [mk] + team_ids).fetchone():
                out.append(mk)
    return out


@app.get("/api/iam/modules")
def iam_get_modules(_sess: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_conn() as conn:
        out = []
        for m in IAM_MODULES:
            mk = m["key"]
            cfg = conn.execute("SELECT mode FROM iam_module_config WHERE module_key = ?", (mk,)).fetchone()
            mode = cfg["mode"] if cfg else "restricted"
            mems = conn.execute(
                "SELECT mm.id, mm.display_name, mm.email, mm.phone "
                "FROM iam_module_members im JOIN members mm ON mm.id = im.member_id "
                "WHERE im.module_key = ? ORDER BY mm.display_name COLLATE NOCASE", (mk,)
            ).fetchall()
            teams = conn.execute(
                "SELECT t.id, t.name FROM iam_module_teams it JOIN teams t ON t.id = it.team_id "
                "WHERE it.module_key = ? ORDER BY t.name COLLATE NOCASE", (mk,)
            ).fetchall()

            def _nm(r):
                ph = r["phone"]
                return r["display_name"] or r["email"] or (None if (ph and str(ph).startswith("email:")) else ph) or f"member#{r['id']}"
            out.append({
                "key": mk, "label": m["label"], "icon": m["icon"], "desc": m["desc"], "mode": mode,
                "members": [{"id": r["id"], "name": _nm(r)} for r in mems],
                "teams": [dict(t) for t in teams],
            })
    return {"modules": out}


class IamModuleIn(BaseModel):
    mode: str = Field("restricted", pattern="^(all|restricted)$")
    member_ids: list[int] = Field(default_factory=list)
    team_ids: list[int] = Field(default_factory=list)


@app.put("/api/iam/modules/{module_key}")
def iam_set_module(module_key: str, payload: IamModuleIn, _sess: dict = Depends(require_admin)) -> dict[str, Any]:
    if module_key not in IAM_MODULE_KEYS:
        raise HTTPException(status_code=404, detail="ไม่พบ module")
    now = utc_now().isoformat()
    with db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO iam_module_config(module_key, mode, updated_at) VALUES (?,?,?)",
                     (module_key, payload.mode, now))
        conn.execute("DELETE FROM iam_module_members WHERE module_key = ?", (module_key,))
        conn.execute("DELETE FROM iam_module_teams WHERE module_key = ?", (module_key,))
        if payload.mode == "restricted":
            for mid in set(payload.member_ids):
                conn.execute("INSERT OR IGNORE INTO iam_module_members(module_key, member_id) VALUES (?,?)",
                             (module_key, mid))
            for tid in set(payload.team_ids):
                conn.execute("INSERT OR IGNORE INTO iam_module_teams(module_key, team_id) VALUES (?,?)",
                             (module_key, tid))
    return {"ok": True}


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


# v1.9.338 — admin SPA JS แยกเป็นโมดูลใน admin_js/ → ต่อกลับเป็นสคริปต์เดียวตอน serve
# (browser เห็น script context เดียวเหมือน inline เดิม — hoisting/top-level scope ไม่เปลี่ยน)
ADMIN_JS_DIR = BASE_DIR / "admin_js"


@app.get("/admin-app.js", include_in_schema=False)
def serve_admin_app_js() -> Response:
    parts = sorted(ADMIN_JS_DIR.glob("*.js")) if ADMIN_JS_DIR.exists() else []
    if not parts:
        raise HTTPException(status_code=404, detail="admin_js missing")
    chunks = []
    for p in parts:
        t = p.read_text(encoding="utf-8")
        if not t.endswith("\n"):
            t += "\n"
        chunks.append(t)
    return Response(content="".join(chunks),
                    media_type="application/javascript; charset=utf-8",
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

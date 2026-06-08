#!/usr/bin/env python3
"""
claude_usage_worker.py — ตัวเช็ค usage ของ Claude.ai (Playwright headless)
รันเป็น service แยกบน Railway ด้วย Playwright Docker image (ดู Dockerfile.worker)
เรียกเป็นรอบเดียวจบ (เหมาะกับ Railway cron) :  python scripts/claude_usage_worker.py

ขั้นตอนต่อ 1 account:
  1) launch chromium headless ด้วย storage_state (decrypt จาก DB)
  2) ดัก network response ที่ url มีคำว่า usage/rate/limit (status 200, JSON)
  3) goto /settings/usage  wait_until=networkidle
  4) ถ้าโดน redirect ไป login หรือไม่มี usage → session_status=expired + alert "re-auth"
  5) parse (claude_usage_parser) → status → insert snapshot → update account
  6) ถ้า state เปลี่ยน (ok→full / healthy→expired) → ส่ง alert (กัน spam)

⚠️ usage URL pattern + parser = UNDOCUMENTED → ต้อง verify (ดู claude_usage_parser.py)
⚠️ IP ของ Railway (datacenter) ต่างจากตอน login → session อาจอายุสั้น/ถูกบังคับ verify
⚠️ ใช้ส่วนตัวเท่านั้น · ตั้งความถี่พอเหมาะ (รายชั่วโมง ไม่ใช่ทุกนาที)
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR / "backend"))
import claude_usage_parser as parser  # noqa: E402

DB_PATH = Path(os.environ.get("FCT_DB_PATH", BASE_DIR / "backend" / "freepik_tracker.db"))
USAGE_URL = os.environ.get("CLAUDE_USAGE_URL", "https://claude.ai/settings/usage")
# url ของ response ที่ถือว่าเป็น usage data — ปรับได้เมื่อ verify ของจริง
USAGE_RESP_HINTS = ("usage", "rate", "limit", "organizations")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- encryption (ต้องตรงกับ backend/server.py _clrl_*) ----
def _fernet():
    try:
        from cryptography.fernet import Fernet
    except Exception:
        return None
    key = os.environ.get("CLAUDE_RL_KEY", "").strip()
    if not key:
        kf = DB_PATH.parent / "claude_rl.key"
        if kf.exists():
            key = kf.read_text().strip()
        else:
            return None
    try:
        return Fernet(key.encode())
    except Exception:
        return None


def _decrypt(stored: str) -> str:
    if not stored:
        return ""
    if stored.startswith("fe:"):
        f = _fernet()
        if not f:
            return ""
        try:
            return f.decrypt(stored[3:].encode()).decode()
        except Exception:
            return ""
    if stored.startswith("b64:"):
        try:
            return base64.b64decode(stored[4:]).decode()
        except Exception:
            return ""
    return ""


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def _settings(conn) -> dict:
    row = conn.execute("SELECT * FROM claude_ratelimit_settings WHERE id = 1").fetchone()
    d = dict(row) if row else {}
    try:
        d["alert_config"] = json.loads(d.get("alert_config") or "{}")
    except Exception:
        d["alert_config"] = {}
    return d


def _send_alert(cfg: dict, text: str) -> None:
    """ส่ง webhook / LINE — ไม่ print token/cookie"""
    wh = (cfg.get("webhook_url") or "").strip()
    if wh:
        try:
            req = urllib.request.Request(wh, data=json.dumps({"text": text}).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            print("alert webhook fail:", str(e)[:100])
    lt = (cfg.get("line_token") or "").strip()
    if lt:
        to = (cfg.get("line_to") or "").strip()
        url = "https://api.line.me/v2/bot/message/push" if to else "https://api.line.me/v2/bot/message/broadcast"
        payload = {"messages": [{"type": "text", "text": text[:4900]}]}
        if to:
            payload["to"] = to
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {lt}"})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            print("alert line fail:", str(e)[:100])


def _prev_status(conn, account_id: int) -> str:
    row = conn.execute(
        "SELECT status FROM claude_usage_snapshots WHERE account_id = ? ORDER BY checked_at DESC LIMIT 1",
        (account_id,),
    ).fetchone()
    return (row["status"] if row else "") or ""


def check_account(conn, acc, settings: dict) -> None:
    from playwright.sync_api import sync_playwright

    label = acc["label"]
    ss = _decrypt(acc["storage_state"] or "")
    if not ss:
        print(f"[{label}] ไม่มี/ถอดรหัส storage_state ไม่ได้ — ข้าม")
        return
    try:
        storage = json.loads(ss)
    except Exception:
        print(f"[{label}] storage_state ไม่ใช่ JSON — ข้าม")
        return

    captured: list = []
    expired = False
    final_url = ""
    page_text = ""

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = browser.new_context(storage_state=storage)
            page = ctx.new_page()

            def on_response(resp):
                try:
                    u = resp.url.lower()
                    if resp.status == 200 and any(h in u for h in USAGE_RESP_HINTS):
                        ct = (resp.headers or {}).get("content-type", "")
                        if "json" in ct:
                            captured.append(resp.json())
                except Exception:
                    pass

            page.on("response", on_response)
            page.goto(USAGE_URL, wait_until="networkidle", timeout=45000)
            final_url = page.url.lower()
            try:
                page_text = page.inner_text("body")[:4000]
            except Exception:
                page_text = ""
            ctx.close()
            browser.close()
    except Exception as e:
        print(f"[{label}] playwright error: {str(e)[:160]}")
        conn.execute(
            "INSERT INTO claude_usage_snapshots(account_id, status, raw_json, checked_at) VALUES (?,?,?,?)",
            (acc["id"], "error", json.dumps({"error": str(e)[:300]}), _now()),
        )
        conn.commit()
        return

    # ตรวจ session หมดอายุ: โดน redirect ไป login หรือไม่มี usage data เลย
    if "login" in final_url or "/auth" in final_url:
        expired = True
    parsed = parser.parse_usage(captured, page_text)
    if not parsed["found"]:
        expired = expired or True   # ไม่มี usage → ถือว่าต้อง re-auth (defensive)

    prev = _prev_status(conn, acc["id"])
    cfg = settings.get("alert_config") or {}

    if expired:
        conn.execute("UPDATE claude_accounts SET session_status='expired', updated_at=? WHERE id=?", (_now(), acc["id"]))
        conn.execute(
            "INSERT INTO claude_usage_snapshots(account_id, status, raw_json, checked_at) VALUES (?,?,?,?)",
            (acc["id"], "expired", json.dumps({"captured_n": len(captured)}), _now()),
        )
        conn.commit()
        if (acc["session_status"] or "") != "expired":   # state เปลี่ยน → alert
            _send_alert(cfg, f"⚠️ [{label}] Claude session หมดอายุ — ต้อง re-auth (อัปโหลด storageState ใหม่)")
        print(f"[{label}] EXPIRED → re-auth needed")
        return

    status = parser.compute_status(parsed, settings.get("threshold_pct") or 90)
    conn.execute("UPDATE claude_accounts SET session_status='healthy', updated_at=? WHERE id=?", (_now(), acc["id"]))
    conn.execute(
        "INSERT INTO claude_usage_snapshots(account_id, session_pct, session_reset_at, weekly_pct, weekly_reset_at, "
        " weekly_opus_pct, weekly_opus_reset_at, raw_json, status, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (acc["id"], parsed["session_pct"], parsed["session_reset_at"], parsed["weekly_pct"], parsed["weekly_reset_at"],
         parsed["weekly_opus_pct"], parsed["weekly_opus_reset_at"], json.dumps(parsed), status, _now()),
    )
    conn.commit()

    if status == "full" and prev != "full":              # OK→Full → alert ครั้งเดียว
        _send_alert(cfg, f"🔴 [{label}] Claude limit ใกล้เต็ม/เต็มแล้ว — "
                         f"session {parsed.get('session_pct')}% · weekly {parsed.get('weekly_pct')}%")
    print(f"[{label}] {status} · session={parsed.get('session_pct')} weekly={parsed.get('weekly_pct')}")


def main() -> int:
    if not DB_PATH.exists():
        print("ไม่พบ DB:", DB_PATH)
        return 1
    conn = _conn()
    settings = _settings(conn)
    accs = conn.execute("SELECT * FROM claude_accounts WHERE storage_state IS NOT NULL AND storage_state != ''").fetchall()
    print(f"worker: {len(accs)} account(s) · {_now()}")
    for acc in accs:
        try:
            check_account(conn, acc, settings)
        except Exception as e:
            print(f"[{acc['label']}] unexpected: {str(e)[:160]}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

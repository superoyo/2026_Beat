#!/usr/bin/env python3
"""
claude_usage_local.py — รันที่เครื่องคุณ (IP เดียวกับที่ login, ผ่าน Cloudflare)
เช็ค usage ของแต่ละ account แล้ว POST ผล (ตัวเลข usage เท่านั้น) เข้าเว็บ /api/claude-ratelimit/ingest
*** session อยู่ในเครื่องนี้ ไม่ออกไปไหน — ส่งเข้าเว็บแค่ %, ไม่ส่ง credential ***

ตั้งเป็น cron/launchd รายชั่วโมง เช่น (crontab -e):
  0 * * * * cd /path/to/2026_Beat && /usr/bin/python3 scripts/claude_usage_local.py >> /tmp/claude_rl.log 2>&1

config: scripts/claude_runner_config.json  (gitignore แล้ว) เช่น
{
  "web_base": "https://<railway-app-domain>",
  "ingest_token": "<CLAUDE_RL_INGEST_TOKEN เดียวกับเว็บ>",
  "headless": false,
  "accounts": [
    {"label": "superoyo@gmail.com", "session_file": "claude_superoyo.json"}
  ]
}
หมายเหตุ: headless=false (มีจอ) เสถียรกว่าในการผ่าน Cloudflare · ถ้าเครื่องไม่มีจอ ลอง headless=true
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import claude_usage_parser as P  # noqa: E402

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")
USAGE_URL = "https://claude.ai/settings/usage"


def check_account(session_file: str, headless: bool) -> dict:
    """คืน {expired, parsed} — expired=True ถ้าเด้ง login / อ่าน usage ไม่ได้"""
    from playwright.sync_api import sync_playwright

    sf = Path(session_file)
    if not sf.is_absolute():
        sf = ROOT / sf
    storage = json.loads(sf.read_text())
    captured = []
    final = ""
    with sync_playwright() as p:
        b = p.chromium.launch(headless=headless, args=["--disable-blink-features=AutomationControlled"])
        ctx = b.new_context(storage_state=storage, user_agent=UA, viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")

        def on_resp(r):
            try:
                ct = (r.headers or {}).get("content-type", "")
                if r.status == 200 and "json" in ct and P._find_usage_obj(r.json()) is not None:
                    captured.append(r.json())
            except Exception:
                pass

        page.on("response", on_resp)
        page.goto(USAGE_URL, wait_until="domcontentloaded", timeout=60000)
        for _ in range(9):
            page.wait_for_timeout(4000)
            if captured or "/login" in page.url:
                break
        final = page.url
        ctx.close()
        b.close()

    parsed = P.parse_usage(captured)
    expired = ("/login" in final) or (not parsed["found"])
    return {"expired": expired, "parsed": parsed, "final": final}


def post_ingest(web_base: str, token: str, label: str, res: dict) -> None:
    pr = res["parsed"]
    body = {
        "token": token, "label": label, "expired": res["expired"],
        "session_pct": pr["session_pct"], "session_reset_at": pr["session_reset_at"],
        "weekly_pct": pr["weekly_pct"], "weekly_reset_at": pr["weekly_reset_at"],
        "weekly_opus_pct": pr["weekly_opus_pct"], "weekly_opus_reset_at": pr["weekly_opus_reset_at"],
        "raw": {k: pr.get(k) for k in ("session_pct", "weekly_pct", "weekly_opus_pct", "extra")},
    }
    req = urllib.request.Request(web_base.rstrip("/") + "/api/claude-ratelimit/ingest",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        print("  ingest:", resp.read().decode()[:200])


def main() -> int:
    cfg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else (ROOT / "scripts" / "claude_runner_config.json")
    if not cfg_path.exists():
        print("ไม่พบ config:", cfg_path, "— สร้างจากตัวอย่างใน docstring")
        return 1
    cfg = json.loads(cfg_path.read_text())
    web_base, token = cfg["web_base"], cfg["ingest_token"]
    headless = bool(cfg.get("headless", False))
    for a in cfg.get("accounts", []):
        label = a["label"]
        try:
            res = check_account(a["session_file"], headless)
            pr = res["parsed"]
            print(f"[{label}] expired={res['expired']} session={pr['session_pct']} weekly={pr['weekly_pct']} opus={pr['weekly_opus_pct']}")
            post_ingest(web_base, token, label, res)
        except Exception as e:
            print(f"[{label}] error: {str(e)[:160]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

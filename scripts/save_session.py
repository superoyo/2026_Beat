#!/usr/bin/env python3
"""
save_session.py — capture session ของ Claude.ai (รันที่เครื่อง dev, มีจอ)
แล้ว VERIFY ว่า login ครบ + อ่าน usage ได้จริง ก่อน save

วิธีใช้:
  python3 -m pip install --user playwright cryptography
  python3 -m playwright install chromium
  python3 scripts/save_session.py --out claude_<label>.json
  → เบราว์เซอร์เปิด → login Claude.ai ให้ "เห็นหน้าแอป/usage จริง" → กลับมา terminal กด Enter
  → สคริปต์จะเช็คว่า session ใช้ได้ (เจอ sessionKey + อ่าน usage ได้) แล้วค่อย save

⚠️ ไฟล์ output = credential เต็มของ session — gitignore แล้ว, อย่าแชร์
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="claude_session.json")
    ap.add_argument("--url", default="https://claude.ai/settings/usage")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
        import claude_usage_parser as P
    except ImportError as e:
        print("ติดตั้งก่อน: python3 -m pip install --user playwright && python3 -m playwright install chromium")
        print("(", e, ")")
        return 1

    UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")
    captured = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(user_agent=UA, viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        page.goto("https://claude.ai/login")
        print("\n>> login Claude.ai ในเบราว์เซอร์ให้เรียบร้อย (จนเห็นหน้าแอป)")
        print(">> แล้วกลับมาที่ terminal นี้ กด Enter ...")
        input()

        def on_resp(r):
            try:
                ct = (r.headers or {}).get("content-type", "")
                if r.status == 200 and "json" in ct and P._find_usage_obj(r.json()) is not None:
                    captured.append(r.json())
            except Exception:
                pass

        page.on("response", on_resp)
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        for _ in range(8):
            page.wait_for_timeout(4000)
            if captured or "/login" in page.url:
                break
        final = page.url
        storage = ctx.storage_state()
        browser.close()

    cookies = storage.get("cookies", [])
    has_key = any(c.get("name") == "sessionKey" for c in cookies)
    parsed = P.parse_usage(captured)

    if "/login" in final or not captured:
        print("\n❌ ยังไม่ผ่าน: เด้งไป login หรืออ่าน usage ไม่ได้ (อาจ login ไม่ครบ / Cloudflare)")
        print(f"   cookies={len(cookies)} sessionKey={'มี' if has_key else 'ไม่มี'} final={final}")
        print("   ลองใหม่: login ให้เห็นหน้าแอปจริง ๆ ก่อนค่อยกด Enter")
        return 2

    Path(args.out).write_text(json.dumps(storage))
    print(f"\n✅ session ใช้ได้ → {args.out}")
    print(f"   cookies={len(cookies)} · sessionKey={'มี' if has_key else 'ไม่มี'}")
    print(f"   usage อ่านได้: session={parsed['session_pct']}% · weekly={parsed['weekly_pct']}% · opus={parsed['weekly_opus_pct']}")
    print("   → ใช้กับ scripts/claude_usage_local.py (cron) ได้เลย · อย่า commit ไฟล์นี้")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
save_session.py — รันที่เครื่อง dev (มีจอ) เพื่อ capture session ของ Claude.ai
แล้ว export เป็น storageState JSON ไปอัปโหลด/วางใน Settings ของ Claude RateLimit

ทำไมต้องทำที่เครื่อง local:
  Claude.ai login เป็น Google OAuth / email code → automate แบบ headless บน server ไม่ได้
  จึงต้อง login ด้วยมือที่นี่ครั้งเดียว แล้วเอา session ที่ได้ไปให้ worker ใช้

วิธีใช้:
  pip install playwright
  python -m playwright install chromium
  python scripts/save_session.py --out claude_session_<label>.json
  → เบราว์เซอร์เปิดขึ้น, login ให้เรียบร้อย, กลับมาที่ terminal กด Enter
  → ได้ไฟล์ JSON → เปิดไฟล์ copy เนื้อหา ไปวางใน Settings (หรืออัปโหลดไฟล์)

⚠️ ไฟล์นี้ = credential เต็มของ session — อย่า commit ลง git / อย่าแชร์
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="claude_session.json", help="ไฟล์ปลายทาง storageState JSON")
    ap.add_argument("--url", default="https://claude.ai/settings/usage", help="หน้าเป้าหมายหลัง login")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ติดตั้งก่อน:  pip install playwright  &&  python -m playwright install chromium")
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto("https://claude.ai/login")
        print("\n>> เบราว์เซอร์เปิดแล้ว — login Claude.ai ให้เรียบร้อย")
        print(">> เมื่อเห็นหน้า usage/dashboard แล้ว กลับมาที่ terminal นี้แล้วกด Enter ...")
        try:
            page.goto(args.url, wait_until="domcontentloaded")
        except Exception:
            pass
        input()
        ctx.storage_state(path=args.out)
        browser.close()

    print(f"\n✅ บันทึก session แล้ว: {args.out}")
    print("   เปิดไฟล์นี้ copy เนื้อหา (JSON) ไปวางใน Platform › Claude RateLimit › Settings")
    print("   ⚠️ อย่า commit ไฟล์นี้ลง git")
    return 0


if __name__ == "__main__":
    sys.exit(main())

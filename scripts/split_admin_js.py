#!/usr/bin/env python3
"""One-time migration: แยก inline <script> ใน admin.html ออกเป็นไฟล์โมดูลใน backend/admin_js/

หลักการ: browser ยังเห็น "สคริปต์เดียว" เหมือนเดิม — server ต่อไฟล์กลับที่
GET /admin-app.js (join ด้วย "" — แต่ละไฟล์จบด้วย \n อยู่แล้ว)
→ semantic เหมือน inline เป๊ะ (hoisting / top-level let-const ข้ามไฟล์ไม่มีปัญหา)

Script นี้ verify byte-identity: concat(parts) ต้องเท่ากับ JS เดิมทุก byte
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "backend" / "admin.html"
OUT_DIR = ROOT / "backend" / "admin_js"

# (filename, start_marker, back_lines)
# ตัดที่บรรทัดที่ marker ปรากฏ (ลบ back_lines เพื่อรวมเส้นคั่น ===== ด้านบน)
BOUNDARIES = [
    ("02-ads-creditcard.js",  "// ============== v1.9.157 — Ads (ยอดใช้จ่ายค่าโฆษณา จาก Windsor) ==============", 0),
    ("03-sites-platforms.js", "// ====== Site form helpers (shared by add + edit) ======", 0),
    ("04-iam-teams.js",       "// ============== v1.9.162 — IAM (สิทธิ์เข้าถึง module) ==============", 0),
    ("05-customer-domains.js", "// ============== Calendar (general) — domain + service expirations ==============", 0),
    ("06-hardware.js",        "// ============== Hardware (PC / Device / Network — admin only) ==============", 0),
    ("07-mydevice-members.js", "// My Device — member-side page (อุปกรณ์ที่ผูกกับตัวเอง + อัพโหลดรูปได้)", 1),
    ("08-skills-aiproject.js", "// ============== v1.9.132 — Skill Marketplace ==============", 0),
    ("09-workflow.js",        "// ============================ v1.9.278 — Workflow builder (n8n-style) ============================", 0),
    ("10-profiles-boot.js",   "// ===== Multi-profile localStorage =====", 0),
]
FIRST_PART = "01-core.js"


def main() -> None:
    html = HTML.read_text(encoding="utf-8")
    open_tag = "\n<script>\n"
    close_tag = "\n</script>"
    i0 = html.index(open_tag) + len(open_tag)
    i1 = html.index(close_tag, i0) + 1          # +1 เก็บ \n สุดท้ายของ JS ไว้ในไฟล์
    js = html[i0:i1]
    lines = js.splitlines(keepends=True)

    # หา index บรรทัดของแต่ละ boundary
    cuts = []  # (line_index, filename)
    for fname, marker, back in BOUNDARIES:
        idx = [i for i, ln in enumerate(lines) if ln.rstrip("\n") == marker]
        if len(idx) != 1:
            raise SystemExit(f"marker not unique ({len(idx)} hits): {marker}")
        cuts.append((idx[0] - back, fname))
    if cuts != sorted(cuts):
        raise SystemExit("boundaries out of order")

    OUT_DIR.mkdir(exist_ok=True)
    starts = [0] + [c[0] for c in cuts]
    names = [FIRST_PART] + [c[1] for c in cuts]
    parts = []
    for k, (start, name) in enumerate(zip(starts, names)):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        content = "".join(lines[start:end])
        if not content.endswith("\n"):
            content += "\n"
        (OUT_DIR / name).write_text(content, encoding="utf-8")
        parts.append(content)
        print(f"  {name:26s} {end - start:6,d} lines")

    # byte-identity check
    joined = "".join(parts)
    if joined != js and joined != js + "\n":
        raise SystemExit("FATAL: concat(parts) != original JS — aborting, HTML untouched")
    print("byte-identity: OK")

    # rewrite admin.html — inline script → external
    new_html = html[: i0 - len(open_tag)] + \
        '\n<script src="/admin-app.js"></script>' + html[i1 + len("\n</script>") - 1:]
    HTML.write_text(new_html, encoding="utf-8")
    print(f"admin.html rewritten: {len(html):,} → {len(new_html):,} chars")


if __name__ == "__main__":
    main()

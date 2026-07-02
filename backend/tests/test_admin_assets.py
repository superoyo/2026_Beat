# v1.9.338 — admin.html + /admin-app.js (JS แยกโมดูล ต่อกลับเป็นสคริปต์เดียว)
from pathlib import Path

import server


def test_admin_html_references_app_js(client):
    r = client.get("/admin")
    assert r.status_code == 200
    assert 'src="/admin-app.js"' in r.text
    assert "<script>\n" not in r.text  # ไม่มี inline script ก้อนใหญ่เหลืออยู่


def test_admin_app_js_serves_all_parts_in_order(client):
    r = client.get("/admin-app.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/javascript")
    body = r.text
    # ต้องเท่ากับ concat ของทุกไฟล์ใน admin_js/ ตามลำดับชื่อ
    parts = sorted((Path(server.__file__).parent / "admin_js").glob("*.js"))
    assert len(parts) >= 5
    expected = ""
    for p in parts:
        t = p.read_text(encoding="utf-8")
        expected += t if t.endswith("\n") else t + "\n"
    assert body == expected
    # sentinel จากไฟล์แรก / กลาง / ท้าย — กันไฟล์หาย
    assert "function escapeHtml" in body          # 01-core
    assert "HW_STATUS_META" in body               # 06-hardware
    assert "Multi-profile localStorage" in body   # 10-profiles-boot


def test_admin_app_js_not_cached(client):
    r = client.get("/admin-app.js")
    assert r.headers.get("cache-control") == "no-store"

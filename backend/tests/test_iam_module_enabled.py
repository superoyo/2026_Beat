# v1.9.405 — IAM: toggle เปิด/ปิด module ทั้งระบบ (ปิด = ไม่มีเมนูนั้นเลย ทุกบทบาท รวม admin)
import server
from conftest import make_member, member_login


def _mods(client):
    return {m["key"]: m for m in client.get("/api/iam/modules").json()["modules"]}


def test_modules_enabled_by_default(admin_client):
    mods = _mods(admin_client)
    assert mods and all(m["enabled"] is True for m in mods.values())


def test_toggle_off_then_on(admin_client):
    r = admin_client.patch("/api/iam/modules/ads/enabled", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False
    assert _mods(admin_client)["ads"]["enabled"] is False
    assert _mods(admin_client)["platform"]["enabled"] is True      # module อื่นไม่กระทบ

    admin_client.patch("/api/iam/modules/ads/enabled", json={"enabled": True})
    assert _mods(admin_client)["ads"]["enabled"] is True


def test_toggle_unknown_module_404(admin_client):
    assert admin_client.patch("/api/iam/modules/nope/enabled", json={"enabled": False}).status_code == 404


def test_disabled_module_blocks_super_admin_too(admin_client):
    """ปิดแล้วต้องเข้าไม่ได้แม้เป็น super admin — ไม่งั้นไม่เรียกว่า 'ไม่มีในระบบ'"""
    admin_client.patch("/api/iam/modules/platform/enabled", json={"enabled": False})
    r = admin_client.get("/api/license-docs")          # endpoint ที่ guard ด้วย module 'platform'
    assert r.status_code == 403
    assert "ปิดใช้งาน" in r.json()["detail"]

    admin_client.patch("/api/iam/modules/platform/enabled", json={"enabled": True})
    assert admin_client.get("/api/license-docs").status_code == 200


def test_disabled_module_blocks_member(client):
    mid = make_member("สมาชิก", is_admin=0)
    member_login(client, mid)      # member ไม่มีสิทธิ์แก้ IAM → ตั้งค่าตรงที่ DB

    # เปิดให้ทุกคนก่อน → เข้าได้
    with server.db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO iam_module_config(module_key, mode, is_enabled, updated_at) "
                     "VALUES ('platform','all',1,'now')")
    assert client.get("/api/license-docs").status_code == 200

    # ปิดทั้งระบบ → เข้าไม่ได้แม้ mode='all'
    with server.db_conn() as conn:
        conn.execute("UPDATE iam_module_config SET is_enabled=0 WHERE module_key='platform'")
    assert client.get("/api/license-docs").status_code == 403


def test_disabled_module_hidden_from_member_module_list(client):
    mid = make_member("สมาชิก", is_admin=0)
    with server.db_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO iam_module_config(module_key, mode, is_enabled, updated_at) "
                     "VALUES ('platform','all',1,'now')")
        assert "platform" in server._member_accessible_modules(conn, mid, False)
        conn.execute("UPDATE iam_module_config SET is_enabled=0 WHERE module_key='platform'")
        assert "platform" not in server._member_accessible_modules(conn, mid, False)
        # admin ก็ต้องไม่เห็นเช่นกัน
        assert "platform" not in server._member_accessible_modules(conn, mid, True)


def test_admin_state_lists_enabled_modules(admin_client):
    st = admin_client.get("/api/admin/state").json()
    assert "platform" in st["modules"] and "ads" in st["modules"]

    admin_client.patch("/api/iam/modules/ads/enabled", json={"enabled": False})
    st = admin_client.get("/api/admin/state").json()
    assert "ads" not in st["modules"] and "platform" in st["modules"]


def test_saving_permissions_keeps_enabled_flag(admin_client):
    """PUT /api/iam/modules/{k} (ตั้งค่าสิทธิ์) ต้องไม่รีเซ็ต is_enabled"""
    admin_client.patch("/api/iam/modules/ads/enabled", json={"enabled": False})
    r = admin_client.put("/api/iam/modules/ads", json={"mode": "all", "member_ids": [], "team_ids": []})
    assert r.status_code == 200
    assert _mods(admin_client)["ads"]["enabled"] is False     # ยังปิดอยู่เหมือนเดิม


def test_toggle_requires_admin(client):
    assert client.patch("/api/iam/modules/ads/enabled", json={"enabled": False}).status_code == 401

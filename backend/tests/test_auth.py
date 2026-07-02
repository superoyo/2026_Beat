# Auth boundary tests — ทุกชั้นสิทธิ์: unauth / member / admin-member / super-admin
from conftest import make_member, member_login


def test_admin_endpoint_rejects_unauthenticated(client):
    r = client.get("/api/admin/hardware")
    assert r.status_code == 401


def test_admin_endpoint_rejects_plain_member(client):
    mid = make_member("สมาชิกธรรมดา")
    member_login(client, mid)
    r = client.get("/api/admin/hardware")
    assert r.status_code == 401


def test_admin_endpoint_allows_super_admin(admin_client):
    r = admin_client.get("/api/admin/hardware")
    assert r.status_code == 200
    assert "hardware" in r.json()


def test_admin_endpoint_allows_admin_member(client):
    mid = make_member("แอดมินจาก member", is_admin=1)
    member_login(client, mid)
    r = client.get("/api/admin/hardware")
    assert r.status_code == 200


def test_module_endpoint_rejects_unauthenticated(client):
    # creditcard ใช้ _require_module("platform") → ไม่มี session = 403
    r = client.get("/api/creditcard/bills")
    assert r.status_code == 403


def test_module_endpoint_allows_super_admin(admin_client):
    r = admin_client.get("/api/creditcard/bills")
    assert r.status_code == 200
    assert "bills" in r.json()


def test_expired_admin_session_rejected(client):
    import server
    from datetime import datetime, timezone, timedelta
    token = server.create_session(1, "expired-admin")
    server._SESSIONS[token]["expires"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    client.cookies.set("fct_session", token)
    r = client.get("/api/admin/hardware")
    assert r.status_code == 401
    assert token not in server._SESSIONS  # expired token ถูกลบทิ้ง


def test_report_endpoint_requires_admin(client):
    r = client.get("/api/admin/hardware/pc-replacement-report")
    assert r.status_code == 401

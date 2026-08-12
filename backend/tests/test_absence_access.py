# Tests for v1.9.395 — Absence: IAM-role access gating + fetched snapshot
import server
from conftest import make_member, member_login


def _set_iam_roles(member_id, roles_json):
    with server.db_conn() as conn:
        conn.execute("UPDATE members SET iam_roles = ? WHERE id = ?", (roles_json, member_id))


# ---- migration ----------------------------------------------------------
def test_migration_created_table_and_column(client):
    with server.db_conn() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(members)").fetchall()}
        assert "iam_roles" in cols
        tbls = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert "absence_snapshot" in tbls


# ---- access-config (admin only) -----------------------------------------
def test_access_config_requires_admin(client):
    mid = make_member(is_admin=0)
    member_login(client, mid)
    assert client.get("/api/absence/access-config").status_code in (401, 403)


def test_admin_can_set_and_get_access_config(admin_client):
    r = admin_client.post("/api/absence/access-config",
                          json={"roles": "Beat Absence, HR Viewer, Beat Absence"})
    assert r.status_code == 200
    # de-dup รักษาลำดับ
    assert r.json()["roles"] == ["Beat Absence", "HR Viewer"]
    g = admin_client.get("/api/absence/access-config").json()
    assert g["roles_text"] == "Beat Absence, HR Viewer"


# ---- can_absence in /api/member/me --------------------------------------
def test_member_me_can_absence_by_role(admin_client):
    admin_client.post("/api/absence/access-config", json={"roles": "Beat Absence"})
    # member ที่ไม่มี role → เห็นเมนูไม่ได้
    plain = make_member(is_admin=0)
    member_login(admin_client, plain)
    assert admin_client.get("/api/member/me").json()["member"]["can_absence"] is False
    # member ที่มี role ตรง (case-insensitive) → เห็นได้
    roled = make_member(is_admin=0)
    _set_iam_roles(roled, '["beat absence", "KOL"]')
    member_login(admin_client, roled)
    assert admin_client.get("/api/member/me").json()["member"]["can_absence"] is True


def test_admin_member_always_can_absence(admin_client):
    admin_client.post("/api/absence/access-config", json={"roles": ""})  # ว่าง = เฉพาะ admin
    am = make_member(is_admin=1)
    member_login(admin_client, am)
    assert admin_client.get("/api/member/me").json()["member"]["can_absence"] is True


# ---- snapshot access gating ---------------------------------------------
def test_snapshot_forbidden_without_role(admin_client):
    admin_client.post("/api/absence/access-config", json={"roles": "Beat Absence"})
    plain = make_member(is_admin=0)
    member_login(admin_client, plain)
    assert admin_client.get("/api/absence/snapshot").status_code == 403


def test_snapshot_empty_then_saved(admin_client):
    # ยังไม่มี snapshot
    r = admin_client.get("/api/absence/snapshot")
    assert r.status_code == 200 and r.json()["messages"] is None
    # เขียน snapshot ตรง ๆ ผ่าน helper แล้วอ่านกลับ
    msgs = [{"subject": "Leave", "receivedDateTime": "2026-08-01T00:00:00Z",
             "bodyText": "พนักงานที่ขอลา (Employee) : 200023 นายทดสอบ"}]
    with server.db_conn() as conn:
        server._save_absence_snapshot(conn, msgs, 5, "ผู้ทดสอบ", "2026-08-12T03:00:00+00:00")
    d = admin_client.get("/api/absence/snapshot").json()
    assert isinstance(d["messages"], list) and len(d["messages"]) == 1
    assert d["msg_count"] == 1 and d["total_fetched"] == 5
    assert d["fetched_by"] == "ผู้ทดสอบ"

# Hardware CRUD + owner assignment history + flags + status log
from conftest import make_member, make_team, db_row, db_rows


def _create_pc(admin_client, **overrides):
    body = {"hw_type": "pc", "name": "Test PC", **overrides}
    r = admin_client.post("/api/admin/hardware", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_create_and_list_hardware(admin_client):
    hw_id = _create_pc(admin_client, name="Lenovo ทดสอบ", os="Windows 11",
                       purchased_at="2025-06")
    r = admin_client.get("/api/admin/hardware?type=pc")
    items = r.json()["hardware"]
    match = [h for h in items if h["id"] == hw_id]
    assert len(match) == 1
    assert match[0]["name"] == "Lenovo ทดสอบ"
    assert match[0]["os"] == "Windows 11"
    assert match[0]["purchased_at"] == "2025-06"


def test_create_with_owner_creates_assignment(admin_client):
    mid = make_member("เจ้าของเครื่อง")
    hw_id = _create_pc(admin_client, current_member_id=mid)
    r = admin_client.get(f"/api/admin/hardware/{hw_id}/history")
    history = r.json()["history"]
    assert len(history) == 1
    assert history[0]["member_id"] == mid
    assert history[0]["unassigned_at"] is None  # ยังถือครองอยู่


def test_owner_change_closes_old_assignment(admin_client):
    m1 = make_member("คนแรก")
    m2 = make_member("คนที่สอง")
    hw_id = _create_pc(admin_client, current_member_id=m1)

    r = admin_client.patch(f"/api/admin/hardware/{hw_id}",
                           json={"current_member_id": m2})
    assert r.status_code == 200

    history = admin_client.get(f"/api/admin/hardware/{hw_id}/history").json()["history"]
    assert len(history) == 2
    open_rows = [h for h in history if h["unassigned_at"] is None]
    closed_rows = [h for h in history if h["unassigned_at"] is not None]
    assert len(open_rows) == 1 and open_rows[0]["member_id"] == m2
    assert len(closed_rows) == 1 and closed_rows[0]["member_id"] == m1

    row = db_row("SELECT current_member_id FROM hardware WHERE id = ?", (hw_id,))
    assert row["current_member_id"] == m2


def test_owner_clear_to_null(admin_client):
    mid = make_member("จะถูกถอด")
    hw_id = _create_pc(admin_client, current_member_id=mid)
    r = admin_client.patch(f"/api/admin/hardware/{hw_id}",
                           json={"current_member_id": None})
    assert r.status_code == 200
    row = db_row("SELECT current_member_id FROM hardware WHERE id = ?", (hw_id,))
    assert row["current_member_id"] is None
    history = admin_client.get(f"/api/admin/hardware/{hw_id}/history").json()["history"]
    assert all(h["unassigned_at"] is not None for h in history)


def test_old_pc_flags_roundtrip(admin_client):
    # v1.9.329 — checkbox สถานะคอมเก่า 3 ตัว
    hw_id = _create_pc(admin_client, old_pc_bought_by_employee=True,
                       old_pc_broken=False, old_pc_donated_sold=True)
    row = db_row("SELECT old_pc_bought_by_employee, old_pc_broken, old_pc_donated_sold "
                 "FROM hardware WHERE id = ?", (hw_id,))
    assert row["old_pc_bought_by_employee"] == 1
    assert row["old_pc_broken"] == 0
    assert row["old_pc_donated_sold"] == 1

    r = admin_client.patch(f"/api/admin/hardware/{hw_id}",
                           json={"old_pc_broken": True, "old_pc_bought_by_employee": False})
    assert r.status_code == 200
    row = db_row("SELECT old_pc_bought_by_employee, old_pc_broken, old_pc_donated_sold "
                 "FROM hardware WHERE id = ?", (hw_id,))
    assert row["old_pc_bought_by_employee"] == 0
    assert row["old_pc_broken"] == 1
    assert row["old_pc_donated_sold"] == 1  # ไม่ส่ง key = ไม่เปลี่ยน


def test_patch_partial_does_not_clobber(admin_client):
    hw_id = _create_pc(admin_client, name="ก่อนแก้", os="macOS", ram="16GB")
    r = admin_client.patch(f"/api/admin/hardware/{hw_id}", json={"ram": "32GB"})
    assert r.status_code == 200
    row = db_row("SELECT name, os, ram FROM hardware WHERE id = ?", (hw_id,))
    assert row["name"] == "ก่อนแก้"
    assert row["os"] == "macOS"
    assert row["ram"] == "32GB"


def test_status_log_written_on_note_change(admin_client):
    hw_id = _create_pc(admin_client)
    r = admin_client.patch(f"/api/admin/hardware/{hw_id}",
                           json={"notes": "เตรียมเปลี่ยนเครื่อง", "note_category": "keep"})
    assert r.status_code == 200
    r = admin_client.get(f"/api/admin/hardware/{hw_id}/status-log")
    assert r.status_code == 200
    logs = r.json().get("log") or r.json().get("logs") or []
    assert any((l.get("notes") == "เตรียมเปลี่ยนเครื่อง") for l in logs)


def test_delete_hardware(admin_client):
    hw_id = _create_pc(admin_client)
    r = admin_client.delete(f"/api/admin/hardware/{hw_id}")
    assert r.status_code == 200
    r = admin_client.delete(f"/api/admin/hardware/{hw_id}")
    assert r.status_code == 404


def test_invalid_hw_type_rejected(admin_client):
    r = admin_client.post("/api/admin/hardware",
                          json={"hw_type": "spaceship", "name": "ยานอวกาศ"})
    assert r.status_code == 422


def test_unassigned_pcs_lists_ownerless(admin_client):
    tid = make_team("Stock Room")
    no_owner = _create_pc(admin_client, name="เครื่องส่วนกลาง", unassigned_team_id=tid)
    mid = make_member("มีเจ้าของ")
    owned = _create_pc(admin_client, name="เครื่องมีเจ้าของ", current_member_id=mid)

    r = admin_client.get("/api/admin/hardware/unassigned-pcs")
    ids = [h["id"] for h in r.json()["hardware"]]
    assert no_owner in ids
    assert owned not in ids

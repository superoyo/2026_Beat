# pc-replacement-report — logic หลักของหน้า Report (Device & Software > Report)
from conftest import make_member, make_team, add_to_team


def _create_pc(admin_client, **overrides):
    body = {"hw_type": "pc", "name": "PC", **overrides}
    r = admin_client.post("/api/admin/hardware", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _report(admin_client):
    r = admin_client.get("/api/admin/hardware/pc-replacement-report")
    assert r.status_code == 200
    return r.json()


def test_only_pcs_with_purchase_date_counted(admin_client):
    _create_pc(admin_client, name="มีวันซื้อ", purchased_at="2025-06-15")
    _create_pc(admin_client, name="ไม่มีวันซื้อ")  # ไม่ควรอยู่ใน report
    body = _report(admin_client)
    names = [e["new_pc"] for e in body["events"]]
    assert "มีวันซื้อ" in names
    assert "ไม่มีวันซื้อ" not in names


def test_year_month_parsed_and_years_desc(admin_client):
    _create_pc(admin_client, name="A", purchased_at="2024-03-01")
    _create_pc(admin_client, name="B", purchased_at="2026-11")
    body = _report(admin_client)
    assert body["years"] == sorted(body["years"], reverse=True)
    assert {2024, 2026}.issubset(set(body["years"]))
    ev_b = [e for e in body["events"] if e["new_pc"] == "B"][0]
    assert ev_b["year"] == 2026 and ev_b["month"] == 11


def test_events_sorted_by_purchase_desc(admin_client):
    _create_pc(admin_client, name="เก่า", purchased_at="2023-01-01")
    _create_pc(admin_client, name="ใหม่", purchased_at="2026-01-01")
    events = _report(admin_client)["events"]
    names = [e["new_pc"] for e in events]
    assert names.index("ใหม่") < names.index("เก่า")


def test_prev_pcs_includes_formerly_held_machine(admin_client):
    # scenario: M1 เคยถือ PC A (ถูกถอดแล้ว) → ได้ PC B ใหม่
    # → event ของ B ต้องมี A ใน prev_pcs (v1.9.319 logic)
    m1 = make_member("ผู้ใช้เปลี่ยนเครื่อง")
    pc_a = _create_pc(admin_client, name="เครื่องเก่า A", purchased_at="2022-05-01",
                      current_member_id=m1)
    admin_client.patch(f"/api/admin/hardware/{pc_a}", json={"current_member_id": None})
    pc_b = _create_pc(admin_client, name="เครื่องใหม่ B", purchased_at="2026-05-01",
                      current_member_id=m1)

    events = _report(admin_client)["events"]
    ev_b = [e for e in events if e["hardware_id"] == pc_b][0]
    prev_ids = [p["id"] for p in ev_b["prev_pcs"]]
    assert pc_a in prev_ids

    # เครื่องเก่า A ไม่มีเจ้าของแล้ว → member ของ event A ต้องว่าง
    ev_a = [e for e in events if e["hardware_id"] == pc_a][0]
    assert ev_a["member_id"] is None
    assert ev_a["prev_pcs"] == []


def test_prev_pcs_excludes_currently_held_second_machine(admin_client):
    # ถือ 2 เครื่องพร้อมกัน → เครื่องที่สองไม่ใช่ "คอมเดิม" (ยังถืออยู่)
    m1 = make_member("ถือสองเครื่อง")
    pc_a = _create_pc(admin_client, name="เครื่องแรก", purchased_at="2024-01-01",
                      current_member_id=m1)
    pc_b = _create_pc(admin_client, name="เครื่องที่สอง", purchased_at="2026-01-01",
                      current_member_id=m1)
    events = _report(admin_client)["events"]
    ev_b = [e for e in events if e["hardware_id"] == pc_b][0]
    assert [p["id"] for p in ev_b["prev_pcs"]] == []


def test_member_teams_included(admin_client):
    tid = make_team("Data Unit")
    m1 = make_member("คนมีทีม")
    add_to_team(tid, m1)
    _create_pc(admin_client, name="เครื่องคนมีทีม", purchased_at="2025-01-01",
               current_member_id=m1)
    events = _report(admin_client)["events"]
    ev = [e for e in events if e["new_pc"] == "เครื่องคนมีทีม"][0]
    assert "Data Unit" in ev["member_teams"]


def test_temp_department_fallback_when_no_team(admin_client):
    m1 = make_member("temp ไม่มีทีม", is_temp=1, temp_department="Legal")
    _create_pc(admin_client, name="เครื่อง temp", purchased_at="2025-02-01",
               current_member_id=m1)
    ev = [e for e in _report(admin_client)["events"] if e["new_pc"] == "เครื่อง temp"][0]
    assert ev["member_teams"] == ["Legal"]


def test_replaces_member_name_in_event(admin_client):
    # v1.9.332 — กล่อง 'พนักงานคนก่อน' ใน Report
    alum = make_member("พี่คนก่อน", is_alumni=1)
    m1 = make_member("น้องคนใหม่", replaces_member_id=alum)
    _create_pc(admin_client, name="เครื่องน้องใหม่", purchased_at="2026-03-01",
               current_member_id=m1)
    ev = [e for e in _report(admin_client)["events"] if e["new_pc"] == "เครื่องน้องใหม่"][0]
    assert ev["replaces_member_id"] == alum
    assert ev["replaces_member_name"] == "พี่คนก่อน"

# Members: temp staff / alumni / replaces (มาแทน) / create-replaces / own-computer
from conftest import make_member, make_team, add_to_team, db_row


def test_create_temp_staff(admin_client):
    r = admin_client.post("/api/admin/temp-staff",
                          json={"name": "พนักงานชั่วคราว", "department": "HR"})
    assert r.status_code == 200
    mid = r.json()["id"]
    row = db_row("SELECT display_name, is_temp, temp_department FROM members WHERE id = ?", (mid,))
    assert row["display_name"] == "พนักงานชั่วคราว"
    assert row["is_temp"] == 1
    assert row["temp_department"] == "HR"


def test_set_alumni(admin_client):
    mid = make_member("จะลาออก")
    r = admin_client.patch(f"/api/admin/members/{mid}/alumni",
                           json={"is_alumni": True, "last_working_day": "2026-06-30"})
    assert r.status_code == 200
    row = db_row("SELECT is_alumni, last_working_day FROM members WHERE id = ?", (mid,))
    assert row["is_alumni"] == 1
    assert row["last_working_day"] == "2026-06-30"

    # ยกเลิก alumni
    r = admin_client.patch(f"/api/admin/members/{mid}/alumni",
                           json={"is_alumni": False, "last_working_day": None})
    assert r.status_code == 200
    row = db_row("SELECT is_alumni, last_working_day FROM members WHERE id = ?", (mid,))
    assert row["is_alumni"] == 0
    assert row["last_working_day"] is None


def test_replaces_requires_alumni_target(admin_client):
    m1 = make_member("พนักงานใหม่")
    m2 = make_member("ยังทำงานอยู่")  # ไม่ใช่ alumni
    r = admin_client.patch(f"/api/admin/members/{m1}/replaces",
                           json={"replaces_member_id": m2})
    assert r.status_code == 400


def test_replaces_rejects_self(admin_client):
    m1 = make_member("ตัวเอง")
    r = admin_client.patch(f"/api/admin/members/{m1}/replaces",
                           json={"replaces_member_id": m1})
    assert r.status_code == 400


def test_replaces_rejects_missing_target(admin_client):
    m1 = make_member("คนจริง")
    r = admin_client.patch(f"/api/admin/members/{m1}/replaces",
                           json={"replaces_member_id": 999999})
    assert r.status_code == 404


def test_replaces_set_and_clear(admin_client):
    alum = make_member("อดีตพนักงาน", is_alumni=1, last_working_day="2026-01-31")
    m1 = make_member("มาแทน")
    r = admin_client.patch(f"/api/admin/members/{m1}/replaces",
                           json={"replaces_member_id": alum})
    assert r.status_code == 200
    assert db_row("SELECT replaces_member_id FROM members WHERE id = ?",
                  (m1,))["replaces_member_id"] == alum

    r = admin_client.patch(f"/api/admin/members/{m1}/replaces",
                           json={"replaces_member_id": None})
    assert r.status_code == 200
    assert db_row("SELECT replaces_member_id FROM members WHERE id = ?",
                  (m1,))["replaces_member_id"] is None


def test_own_computer_returns_alumni_options(admin_client):
    alum1 = make_member("Alumni หนึ่ง", is_alumni=1, last_working_day="2026-03-31")
    alum2 = make_member("Alumni สอง", is_alumni=1)
    active = make_member("ยังทำงาน")
    m1 = make_member("คนที่ดู")

    r = admin_client.get(f"/api/admin/members/{m1}/own-computer")
    assert r.status_code == 200
    body = r.json()
    ids = [a["id"] for a in body["alumni_options"]]
    assert alum1 in ids and alum2 in ids
    assert active not in ids            # ไม่ใช่ alumni → ไม่อยู่ใน options
    assert body["replaces_member_id"] is None


def test_create_replaces_creates_alumni_and_links(admin_client):
    # v1.9.332 — สร้าง alumni ใหม่ + set replaces ในทรานแซกชันเดียว
    tid = make_team("Graphic Department")
    m1 = make_member("พนักงานใหม่")
    add_to_team(tid, m1)

    r = admin_client.post(f"/api/admin/members/{m1}/create-replaces",
                          json={"name": "พี่เก่าที่ลาออก",
                                "department": "Graphic Department",
                                "team_ids": [tid]})
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]

    row = db_row("SELECT display_name, is_temp, is_alumni, temp_department "
                 "FROM members WHERE id = ?", (new_id,))
    assert row["display_name"] == "พี่เก่าที่ลาออก"
    assert row["is_temp"] == 1          # เป็น temp staff
    assert row["is_alumni"] == 1        # เป็น alumni อัตโนมัติ
    assert row["temp_department"] == "Graphic Department"

    # ผูกทีมเดียวกับผู้มาแทน
    tm = db_row("SELECT 1 AS x FROM team_members WHERE team_id = ? AND member_id = ?",
                (tid, new_id))
    assert tm is not None

    # m1 ชี้ไป alumni ใหม่
    assert db_row("SELECT replaces_member_id FROM members WHERE id = ?",
                  (m1,))["replaces_member_id"] == new_id


def test_create_replaces_rejects_blank_name(admin_client):
    m1 = make_member("คนว่าง")
    r = admin_client.post(f"/api/admin/members/{m1}/create-replaces",
                          json={"name": "   "})
    assert r.status_code == 400


def test_team_detail_exposes_replaces_info(admin_client):
    # v1.9.328 — team detail JOIN ชื่อ alumni ที่ถูกแทน
    tid = make_team("CX Team")
    alum = make_member("คนเก่า CX", is_alumni=1, last_working_day="2026-02-28")
    m1 = make_member("คนใหม่ CX", replaces_member_id=alum)
    add_to_team(tid, m1)

    r = admin_client.get(f"/api/admin/teams/{tid}")
    assert r.status_code == 200
    members = r.json()["members"]
    me = [m for m in members if m["id"] == m1][0]
    assert me["replaces_member_id"] == alum
    assert me["replaces_member_label"] == "คนเก่า CX"
    assert me["replaces_last_working_day"] == "2026-02-28"

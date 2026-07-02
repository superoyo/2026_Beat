# v1.9.339 — IAM สำหรับ Device & Software: grant member เข้าเมนูย่อยผ่าน hw-* modules
from conftest import make_member, make_team, add_to_team, member_login


def _grant(admin_client, module_key, member_ids=(), team_ids=()):
    r = admin_client.put(f"/api/iam/modules/{module_key}",
                         json={"mode": "restricted",
                               "member_ids": list(member_ids),
                               "team_ids": list(team_ids)})
    assert r.status_code == 200, r.text


def test_iam_modules_include_hw_submenus(admin_client):
    r = admin_client.get("/api/iam/modules")
    keys = {m["key"] for m in r.json()["modules"]}
    assert {"hw-dashboard", "hw-pc", "hw-central", "hw-device",
            "hw-network", "hw-report", "hw-findoc"}.issubset(keys)


def test_member_granted_hw_pc_can_read_hardware(client, admin_client):
    mid = make_member("ได้สิทธิ์ hw-pc")
    _grant(admin_client, "hw-pc", member_ids=[mid])
    member_login(client, mid)
    assert client.get("/api/admin/hardware?type=pc").status_code == 200
    # ยังเข้า cache endpoints ที่หน้า hardware ใช้ได้ (members / teams)
    assert client.get("/api/admin/members").status_code == 200
    assert client.get("/api/admin/teams").status_code == 200


def test_hw_grant_does_not_open_findoc(client, admin_client):
    mid = make_member("มีแค่ hw-pc")
    _grant(admin_client, "hw-pc", member_ids=[mid])
    member_login(client, mid)
    assert client.get("/api/admin/financial-documents").status_code == 403


def test_findoc_grant_opens_findoc_and_hardware_family(client, admin_client):
    mid = make_member("ได้สิทธิ์ findoc")
    _grant(admin_client, "hw-findoc", member_ids=[mid])
    member_login(client, mid)
    assert client.get("/api/admin/financial-documents").status_code == 200
    # hw-findoc อยู่ใน family → อ่าน hardware list ได้ (ใช้ตอน link เอกสารกับเครื่อง)
    assert client.get("/api/admin/hardware?type=pc").status_code == 200


def test_team_grant_covers_team_members(client, admin_client):
    tid = make_team("IT Center ทดสอบ")
    mid = make_member("คนในทีม IT")
    add_to_team(tid, mid)
    _grant(admin_client, "hw-report", team_ids=[tid])
    member_login(client, mid)
    assert client.get("/api/admin/hardware/pc-replacement-report").status_code == 200


def test_ungranted_member_still_blocked(client, admin_client):
    granted = make_member("คนได้สิทธิ์")
    other = make_member("คนไม่ได้สิทธิ์")
    _grant(admin_client, "hw-pc", member_ids=[granted])
    member_login(client, other)
    assert client.get("/api/admin/hardware").status_code == 403
    assert client.get("/api/admin/hardware/pc-replacement-report").status_code == 403


def test_granted_member_can_write_hardware(client, admin_client):
    mid = make_member("แก้ไขเครื่องได้")
    _grant(admin_client, "hw-pc", member_ids=[mid])
    member_login(client, mid)
    r = client.post("/api/admin/hardware", json={"hw_type": "pc", "name": "เครื่องจาก member"})
    assert r.status_code == 200
    hw_id = r.json()["id"]
    assert client.patch(f"/api/admin/hardware/{hw_id}", json={"ram": "8GB"}).status_code == 200


def test_iam_writes_remain_admin_only(client, admin_client):
    mid = make_member("member มี hw-pc")
    _grant(admin_client, "hw-pc", member_ids=[mid])
    member_login(client, mid)
    # ตั้งค่า IAM เอง / จัดการ alumni-replaces ยังต้องเป็น admin
    r = client.put("/api/iam/modules/hw-pc",
                   json={"mode": "all", "member_ids": [], "team_ids": []})
    assert r.status_code == 401

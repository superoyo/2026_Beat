# Teams: hierarchy + subtree members + alumni ไม่นับใน member_count
from conftest import make_member, add_to_team, db_row


def _create_team(admin_client, name, parent=None):
    r = admin_client.post("/api/admin/teams",
                          json={"name": name, "parent_team_id": parent})
    assert r.status_code == 200, r.text
    body = r.json()
    return body.get("id") or body.get("team", {}).get("id")


def test_create_team_and_child(admin_client):
    pid = _create_team(admin_client, "Data First ทดสอบ")
    cid = _create_team(admin_client, "Media Unit ทดสอบ", parent=pid)
    row = db_row("SELECT parent_team_id FROM teams WHERE id = ?", (cid,))
    assert row["parent_team_id"] == pid


def test_create_team_rejects_missing_parent(admin_client):
    r = admin_client.post("/api/admin/teams",
                          json={"name": "ลอย", "parent_team_id": 999999})
    assert r.status_code == 400


def test_parent_team_detail_includes_subtree_members(admin_client):
    pid = _create_team(admin_client, "แม่")
    cid = _create_team(admin_client, "ลูก", parent=pid)
    m_direct = make_member("สมาชิกตรง")
    m_sub = make_member("สมาชิกทีมลูก")
    add_to_team(pid, m_direct)
    add_to_team(cid, m_sub)

    r = admin_client.get(f"/api/admin/teams/{pid}")
    assert r.status_code == 200
    members = {m["id"]: m for m in r.json()["members"]}
    assert members[m_direct]["direct"] is True
    assert members[m_sub]["direct"] is False
    assert "ลูก" in members[m_sub]["sub_team_names"]


def test_duplicate_team_member_conflict(admin_client):
    tid = _create_team(admin_client, "ซ้ำ")
    mid = make_member("สมาชิก")
    r = admin_client.post(f"/api/admin/teams/{tid}/members", json={"member_id": mid})
    assert r.status_code == 200
    r = admin_client.post(f"/api/admin/teams/{tid}/members", json={"member_id": mid})
    assert r.status_code == 409


def test_alumni_excluded_from_member_count(admin_client):
    tid = _create_team(admin_client, "นับคน")
    active = make_member("ยังอยู่")
    alum = make_member("ออกแล้ว", is_alumni=1)
    add_to_team(tid, active)
    add_to_team(tid, alum)

    r = admin_client.get("/api/admin/teams")
    teams = r.json()["teams"]
    me = [t for t in teams if t["id"] == tid][0]
    assert me["member_count"] == 1  # alumni ไม่นับ

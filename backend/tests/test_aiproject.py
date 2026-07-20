"""AI Project — pin โปรเจกต์สำคัญให้อยู่บนสุด (v1.9.369)"""
from conftest import make_member, member_login


def _create(client, title="Proj"):
    r = client.post("/api/ai-projects", json={"title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_pin_moves_project_to_top(admin_client):
    a = _create(admin_client, "Alpha")   # สร้างก่อน
    b = _create(admin_client, "Beta")    # สร้างหลัง → ปกติอยู่บนกว่า
    # ปักหมุด Alpha (ตัวเก่ากว่า) → ต้องเด้งขึ้นบนสุดแม้สร้างก่อน
    r = admin_client.post(f"/api/ai-projects/{a}/pin", json={"pinned": True})
    assert r.status_code == 200, r.text
    assert r.json()["pinned"] is True
    projects = admin_client.get("/api/ai-projects").json()["projects"]
    assert projects[0]["id"] == a
    assert projects[0]["pinned"] is True
    pinned_by_id = {p["id"]: p["pinned"] for p in projects}
    assert pinned_by_id[b] is False


def test_unpin_reverts(admin_client):
    a = _create(admin_client, "Alpha")
    admin_client.post(f"/api/ai-projects/{a}/pin", json={"pinned": True})
    r = admin_client.post(f"/api/ai-projects/{a}/pin", json={"pinned": False})
    assert r.status_code == 200 and r.json()["pinned"] is False
    projects = admin_client.get("/api/ai-projects").json()["projects"]
    assert all(p["pinned"] is False for p in projects)


def test_detail_returns_pinned_flag(admin_client):
    a = _create(admin_client, "Alpha")
    admin_client.post(f"/api/ai-projects/{a}/pin", json={"pinned": True})
    d = admin_client.get(f"/api/ai-projects/{a}").json()
    assert d["pinned"] is True


def test_pin_requires_owner_or_admin(admin_client):
    # admin สร้าง (owner = super-admin ไม่ใช่ member คนนี้)
    pid = _create(admin_client, "AdminOwned")
    # member ที่ไม่ใช่เจ้าของ → ปักหมุดไม่ได้ (403)
    mid = make_member("ไม่ใช่เจ้าของ")
    member_login(admin_client, mid)
    r = admin_client.post(f"/api/ai-projects/{pid}/pin", json={"pinned": True})
    assert r.status_code == 403

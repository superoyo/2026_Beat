# v1.9.404 — เอกสารควบคุม license: อัพโหลด / list / preview file / ปักดาว / rename / ลบ
import base64

# 1x1 PNG
_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
_DATA_URL = "data:image/png;base64," + _TINY_PNG_B64


def _upload(admin_client, name="license.png", title=None, mime="image/png", data=_DATA_URL):
    return admin_client.post("/api/license-docs", json={
        "title": title, "file_data": data, "file_name": name, "file_mime": mime,
    })


def test_upload_then_listed(admin_client):
    r = _upload(admin_client)
    assert r.status_code == 200, r.text
    doc = r.json()["doc"]
    assert doc["title"] == "license.png"        # default title = ชื่อไฟล์
    assert doc["is_starred"] is False
    assert doc["file_size"] == len(base64.b64decode(_TINY_PNG_B64))

    docs = admin_client.get("/api/license-docs").json()["docs"]
    assert [d["id"] for d in docs] == [doc["id"]]
    assert "file_data" not in docs[0]           # ไม่ส่ง base64 ก้อนใหญ่มากับ list


def test_title_defaults_and_override(admin_client):
    assert _upload(admin_client, name="a.png").json()["doc"]["title"] == "a.png"
    assert _upload(admin_client, name="b.png", title="สัญญา 2026").json()["doc"]["title"] == "สัญญา 2026"


def test_upload_requires_file(admin_client):
    assert admin_client.post("/api/license-docs", json={"file_data": "  "}).status_code == 400


def test_upload_rejects_oversize(admin_client):
    big = "data:image/png;base64," + ("A" * (17 * 1024 * 1024))    # ~12.75MB หลัง decode
    assert _upload(admin_client, data=big).status_code == 400


def test_file_endpoint_serves_bytes(admin_client):
    did = _upload(admin_client).json()["id"]
    r = admin_client.get(f"/api/license-docs/{did}/file")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    assert r.content == base64.b64decode(_TINY_PNG_B64)


def test_file_endpoint_404_when_missing(admin_client):
    assert admin_client.get("/api/license-docs/9999/file").status_code == 404


def test_star_pulls_doc_to_top(admin_client):
    first = _upload(admin_client, name="1.png").json()["id"]
    _upload(admin_client, name="2.png")
    third = _upload(admin_client, name="3.png").json()["id"]

    # default: ใหม่สุดก่อน
    assert admin_client.get("/api/license-docs").json()["docs"][0]["id"] == third

    r = admin_client.patch(f"/api/license-docs/{first}/star", json={"starred": True})
    assert r.status_code == 200 and r.json()["is_starred"] is True

    docs = admin_client.get("/api/license-docs").json()["docs"]
    assert docs[0]["id"] == first and docs[0]["is_starred"] is True
    assert docs[0]["starred_at"]
    assert [d["is_starred"] for d in docs[1:]] == [False, False]

    # ปลดดาว → กลับไปเรียงตามใหม่สุด
    admin_client.patch(f"/api/license-docs/{first}/star", json={"starred": False})
    docs = admin_client.get("/api/license-docs").json()["docs"]
    assert docs[0]["id"] == third
    assert docs[-1]["id"] == first
    assert docs[-1]["starred_at"] is None


def test_star_newest_first_among_starred(admin_client):
    a = _upload(admin_client, name="a.png").json()["id"]
    b = _upload(admin_client, name="b.png").json()["id"]
    admin_client.patch(f"/api/license-docs/{a}/star", json={"starred": True})
    admin_client.patch(f"/api/license-docs/{b}/star", json={"starred": True})
    assert [d["id"] for d in admin_client.get("/api/license-docs").json()["docs"]] == [b, a]


def test_star_404(admin_client):
    assert admin_client.patch("/api/license-docs/9999/star", json={"starred": True}).status_code == 404


def test_rename(admin_client):
    did = _upload(admin_client, name="x.png").json()["id"]
    r = admin_client.patch(f"/api/license-docs/{did}", json={"title": "  ใบอนุญาต 2026  ", "note": "ต่ออายุ ธ.ค."})
    assert r.status_code == 200 and r.json()["title"] == "ใบอนุญาต 2026"
    doc = admin_client.get("/api/license-docs").json()["docs"][0]
    assert doc["title"] == "ใบอนุญาต 2026" and doc["note"] == "ต่ออายุ ธ.ค."

    # ชื่อว่าง → คงชื่อเดิมไว้ ไม่ลบทิ้ง
    admin_client.patch(f"/api/license-docs/{did}", json={"title": "   "})
    assert admin_client.get("/api/license-docs").json()["docs"][0]["title"] == "ใบอนุญาต 2026"


def test_rename_404(admin_client):
    assert admin_client.patch("/api/license-docs/9999", json={"title": "x"}).status_code == 404


def test_delete(admin_client):
    did = _upload(admin_client).json()["id"]
    assert admin_client.delete(f"/api/license-docs/{did}").status_code == 200
    assert admin_client.get("/api/license-docs").json()["docs"] == []
    assert admin_client.get(f"/api/license-docs/{did}/file").status_code == 404


def test_requires_auth(client):
    assert client.get("/api/license-docs").status_code == 403
    assert _upload(client).status_code == 403

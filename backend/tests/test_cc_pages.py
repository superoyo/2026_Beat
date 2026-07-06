# v1.9.341 — เอกสารต้นฉบับของบิลบัตรเครดิต (statement pages)
import base64

# 1x1 JPEG (พอสำหรับ test decode)
_TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="
)
_DATA_URL = "data:image/jpeg;base64," + _TINY_JPEG_B64


def _create_bill_with_page(admin_client):
    r = admin_client.post("/api/creditcard/bills", json={
        "card_number": "TEST", "bill_month": 6, "bill_year": 2026,
        "pages": [{"image_data": _DATA_URL, "ocr_text": "hello"}],
        "transactions": [],
    })
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_pages_stored_on_create_and_served(admin_client):
    bid = _create_bill_with_page(admin_client)
    pages = admin_client.get(f"/api/creditcard/bills/{bid}").json()["pages"]
    assert len(pages) == 1
    pid = pages[0]["id"]
    r = admin_client.get(f"/api/creditcard/bills/{bid}/pages/{pid}/image")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/jpeg")
    assert r.content == base64.b64decode(_TINY_JPEG_B64)


def test_add_pages_appends_with_order(admin_client):
    bid = _create_bill_with_page(admin_client)
    r = admin_client.post(f"/api/creditcard/bills/{bid}/pages",
                          json={"pages": [{"image_data": _DATA_URL},
                                          {"image_data": _DATA_URL}]})
    assert r.status_code == 200
    pages = admin_client.get(f"/api/creditcard/bills/{bid}").json()["pages"]
    assert len(pages) == 3
    orders = [p["page_order"] for p in pages] if "page_order" in pages[0] else None
    if orders is not None:
        assert orders == sorted(orders)


def test_add_pages_validation(admin_client):
    bid = _create_bill_with_page(admin_client)
    assert admin_client.post(f"/api/creditcard/bills/{bid}/pages",
                             json={"pages": []}).status_code == 400
    assert admin_client.post("/api/creditcard/bills/999999/pages",
                             json={"pages": [{"image_data": _DATA_URL}]}).status_code == 404


def test_delete_page(admin_client):
    bid = _create_bill_with_page(admin_client)
    pid = admin_client.get(f"/api/creditcard/bills/{bid}").json()["pages"][0]["id"]
    assert admin_client.delete(f"/api/creditcard/bills/{bid}/pages/{pid}").status_code == 200
    assert admin_client.get(f"/api/creditcard/bills/{bid}").json()["pages"] == []
    assert admin_client.delete(f"/api/creditcard/bills/{bid}/pages/{pid}").status_code == 404


def test_page_image_wrong_bill_404(admin_client):
    bid = _create_bill_with_page(admin_client)
    pid = admin_client.get(f"/api/creditcard/bills/{bid}").json()["pages"][0]["id"]
    other = _create_bill_with_page(admin_client)
    r = admin_client.get(f"/api/creditcard/bills/{other}/pages/{pid}/image")
    assert r.status_code == 404

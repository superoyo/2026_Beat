# Credit Card: bills / transactions (user_note) / invoices / matches
from conftest import db_row


def _create_bill(admin_client, txns=None):
    body = {
        "card_number": "4513-47XX-XXXX-7528",
        "bill_month": 6,
        "bill_year": 2026,
        "pages": [],
        "transactions": txns if txns is not None else [
            {"txn_date": "04/06", "description": "ANTHROPIC CLAUDE SUB", "amount": 3347.63},
            {"txn_date": "05/06", "description": "GOOGLE CLOUD", "amount": 2000.00},
        ],
    }
    r = admin_client.post("/api/creditcard/bills", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_create_bill_and_detail(admin_client):
    bid = _create_bill(admin_client)
    r = admin_client.get(f"/api/creditcard/bills/{bid}")
    assert r.status_code == 200
    d = r.json()
    assert d["bill"]["card_number"] == "4513-47XX-XXXX-7528"
    assert len(d["transactions"]) == 2
    descs = [t["description"] for t in d["transactions"]]
    assert "ANTHROPIC CLAUDE SUB" in descs


def test_txn_user_note_patch_and_clear(admin_client):
    # v1.9.314 — inline description ของรายการในบัตร
    bid = _create_bill(admin_client)
    txn = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"][0]

    r = admin_client.patch(f"/api/creditcard/transactions/{txn['id']}",
                           json={"user_note": "ค่า Claude สำหรับโปรเจค ปยป"})
    assert r.status_code == 200
    assert r.json()["user_note"] == "ค่า Claude สำหรับโปรเจค ปยป"

    d = admin_client.get(f"/api/creditcard/bills/{bid}").json()
    t = [x for x in d["transactions"] if x["id"] == txn["id"]][0]
    assert t["user_note"] == "ค่า Claude สำหรับโปรเจค ปยป"

    # ส่ง empty string = ลบ note
    r = admin_client.patch(f"/api/creditcard/transactions/{txn['id']}",
                           json={"user_note": "  "})
    assert r.status_code == 200
    assert r.json()["user_note"] is None


def test_txn_user_note_404(admin_client):
    r = admin_client.patch("/api/creditcard/transactions/999999",
                           json={"user_note": "x"})
    assert r.status_code == 404


def test_floating_invoice_match_binds_to_bill(admin_client):
    bid = _create_bill(admin_client)
    txn = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"][0]

    # invoice ลอย (ไม่มี bill_id)
    r = admin_client.post("/api/creditcard/invoices",
                          json={"company": "Anthropic", "kind": "invoice",
                                "amount": 3347.63, "inv_month": 6, "inv_year": 2026})
    assert r.status_code == 200
    inv_id = r.json()["id"]
    assert db_row("SELECT bill_id FROM cc_invoices WHERE id = ?", (inv_id,))["bill_id"] is None

    # จับคู่ → invoice ลอยถูกผูกเข้าบิลอัตโนมัติ
    r = admin_client.post("/api/creditcard/matches",
                          json={"transaction_id": txn["id"], "invoice_id": inv_id})
    assert r.status_code == 200
    assert db_row("SELECT bill_id FROM cc_invoices WHERE id = ?", (inv_id,))["bill_id"] == bid

    d = admin_client.get(f"/api/creditcard/bills/{bid}").json()
    assert any(m["invoice_id"] == inv_id and m["transaction_id"] == txn["id"]
               for m in d["matches"])


def test_match_rejects_invoice_of_other_bill(admin_client):
    bid1 = _create_bill(admin_client)
    bid2 = _create_bill(admin_client, txns=[
        {"txn_date": "01/07", "description": "OTHER", "amount": 100.0}])
    txn1 = admin_client.get(f"/api/creditcard/bills/{bid1}").json()["transactions"][0]

    r = admin_client.post("/api/creditcard/invoices",
                          json={"company": "X", "kind": "receipt", "bill_id": bid2,
                                "amount": 100.0})
    inv_id = r.json()["id"]
    r = admin_client.post("/api/creditcard/matches",
                          json={"transaction_id": txn1["id"], "invoice_id": inv_id})
    assert r.status_code == 400  # ผูกกับบิลอื่นอยู่แล้ว


def test_edit_bill_preserves_kept_rows_deletes_missing(admin_client):
    bid = _create_bill(admin_client)
    txns = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"]
    keep, drop = txns[0], txns[1]

    r = admin_client.put(f"/api/creditcard/bills/{bid}", json={
        "card_number": "แก้แล้ว", "bill_month": 7, "bill_year": 2026, "note": None,
        "transactions": [
            {"id": keep["id"], "txn_date": keep["txn_date"],
             "description": "แก้ชื่อรายการ", "amount": 999.0},
            {"txn_date": "09/07", "description": "แถวใหม่", "amount": 50.0},
        ],
    })
    assert r.status_code == 200, r.text

    d = admin_client.get(f"/api/creditcard/bills/{bid}").json()
    assert d["bill"]["card_number"] == "แก้แล้ว"
    ids = [t["id"] for t in d["transactions"]]
    assert keep["id"] in ids            # แถวเดิม (id คงที่ → match ไม่หาย)
    assert drop["id"] not in ids        # แถวที่หายไป = โดนลบ
    descs = [t["description"] for t in d["transactions"]]
    assert "แก้ชื่อรายการ" in descs and "แถวใหม่" in descs


def test_delete_bill_cascades(admin_client):
    bid = _create_bill(admin_client)
    txn = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"][0]
    r = admin_client.delete(f"/api/creditcard/bills/{bid}")
    assert r.status_code == 200
    assert db_row("SELECT 1 AS x FROM cc_transactions WHERE id = ?", (txn["id"],)) is None
    r = admin_client.get(f"/api/creditcard/bills/{bid}")
    assert r.status_code == 404


def test_due_date_roundtrip(admin_client):
    # v1.9.343 — กำหนดชำระ: create → list → edit
    r = admin_client.post("/api/creditcard/bills", json={
        "card_number": "DUE", "bill_month": 6, "bill_year": 2026,
        "due_date": "2026-06-25", "pages": [], "transactions": []})
    bid = r.json()["id"]
    bills = admin_client.get("/api/creditcard/bills").json()["bills"]
    me = [b for b in bills if b["id"] == bid][0]
    assert me["due_date"] == "2026-06-25"

    r = admin_client.put(f"/api/creditcard/bills/{bid}", json={
        "card_number": "DUE", "bill_month": 6, "bill_year": 2026,
        "due_date": "2026-07-01", "transactions": []})
    assert r.status_code == 200
    d = admin_client.get(f"/api/creditcard/bills/{bid}").json()
    assert d["bill"]["due_date"] == "2026-07-01"

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


def test_bill_completed_toggle(admin_client):
    # v1.9.344 — ทำเครื่องหมายเสร็จสิ้น (ปิดเตือนเลยกำหนด)
    r = admin_client.post("/api/creditcard/bills", json={
        "card_number": "DONE", "bill_month": 5, "bill_year": 2026,
        "due_date": "2026-05-25", "pages": [], "transactions": []})
    bid = r.json()["id"]

    r = admin_client.patch(f"/api/creditcard/bills/{bid}/completed", json={"completed": True})
    assert r.status_code == 200
    me = [b for b in admin_client.get("/api/creditcard/bills").json()["bills"] if b["id"] == bid][0]
    assert me["is_completed"] == 1
    assert me["completed_at"] is not None

    r = admin_client.patch(f"/api/creditcard/bills/{bid}/completed", json={"completed": False})
    assert r.status_code == 200
    me = [b for b in admin_client.get("/api/creditcard/bills").json()["bills"] if b["id"] == bid][0]
    assert me["is_completed"] == 0
    assert me["completed_at"] is None

    assert admin_client.patch("/api/creditcard/bills/999999/completed",
                              json={"completed": True}).status_code == 404


def test_detach_invoice_from_bill(admin_client):
    # v1.9.350 — ปล่อยลอย: ถอด invoice ออกจากบิล → กลับเป็นใบลอย
    bid = _create_bill(admin_client)
    r = admin_client.post("/api/creditcard/invoices",
                          json={"company": "Windsor", "kind": "invoice",
                                "bill_id": bid, "amount": 299.0})
    inv_id = r.json()["id"]

    r = admin_client.post(f"/api/creditcard/invoices/{inv_id}/detach")
    assert r.status_code == 200
    assert db_row("SELECT bill_id FROM cc_invoices WHERE id = ?", (inv_id,))["bill_id"] is None
    # กลับไปโผล่ใน pool
    pool = admin_client.get("/api/creditcard/pool-invoices").json()["invoices"]
    assert inv_id in [i["id"] for i in pool]
    # ลอยอยู่แล้ว → 400
    assert admin_client.post(f"/api/creditcard/invoices/{inv_id}/detach").status_code == 400


def test_detach_blocked_when_matched(admin_client):
    bid = _create_bill(admin_client)
    txn = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"][0]
    inv_id = admin_client.post("/api/creditcard/invoices",
                               json={"company": "X", "kind": "invoice",
                                     "bill_id": bid, "amount": 1.0}).json()["id"]
    admin_client.post("/api/creditcard/matches",
                      json={"transaction_id": txn["id"], "invoice_id": inv_id})
    r = admin_client.post(f"/api/creditcard/invoices/{inv_id}/detach")
    assert r.status_code == 400  # ต้องถอดการจับคู่ก่อน


def test_search_transactions_across_bills(admin_client):
    # v1.9.352 — ค้นหารายการข้ามทุกบิล
    b1 = _create_bill(admin_client)
    admin_client.post("/api/creditcard/bills", json={
        "card_number": "OTHER-CARD", "bill_month": 7, "bill_year": 2026,
        "pages": [], "transactions": [
            {"txn_date": "01/07", "description": "ANTHROPIC CLAUDE MAX", "amount": 6700.0}]})

    r = admin_client.get("/api/creditcard/search-transactions?q=ANTHROPIC")
    assert r.status_code == 200
    txns = r.json()["transactions"]
    assert len(txns) == 2                     # เจอทั้งสองบิล
    cards = {t["card_number"] for t in txns}
    assert "OTHER-CARD" in cards and "4513-47XX-XXXX-7528" in cards
    assert all("bill_month" in t and "bill_year" in t for t in txns)

    # ค้นจาก user_note ได้ด้วย
    tid = [t for t in txns if t["card_number"] != "OTHER-CARD"][0]["id"]
    admin_client.patch(f"/api/creditcard/transactions/{tid}",
                       json={"user_note": "โปรเจคลับสุดยอด"})
    r = admin_client.get("/api/creditcard/search-transactions?q=โปรเจคลับ")
    assert [t["id"] for t in r.json()["transactions"]] == [tid]

    # ไม่เจอ = list ว่าง
    assert admin_client.get("/api/creditcard/search-transactions?q=ZZZNOTFOUND").json()["transactions"] == []


def test_search_transactions_includes_matched_invoices(admin_client):
    # v1.9.353 — ผล search แนบ invoice ที่จับคู่แล้ว
    bid = _create_bill(admin_client)
    txn = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"][0]
    inv_id = admin_client.post("/api/creditcard/invoices",
                               json={"company": "Anthropic", "kind": "invoice",
                                     "bill_id": bid, "amount": 100.0}).json()["id"]
    admin_client.post("/api/creditcard/matches",
                      json={"transaction_id": txn["id"], "invoice_id": inv_id})

    txns = admin_client.get("/api/creditcard/search-transactions?q=ANTHROPIC").json()["transactions"]
    me = [t for t in txns if t["id"] == txn["id"]][0]
    assert len(me["invoices"]) == 1
    assert me["invoices"][0]["id"] == inv_id
    assert me["invoices"][0]["company"] == "Anthropic"
    # รายการที่ไม่ได้จับคู่ → invoices ว่าง
    other = [t for t in txns if t["id"] != txn["id"]]
    assert all(t["invoices"] == [] for t in other)


def test_pool_invoices_scope(admin_client):
    # v1.9.357 — pool: scope unmatched (default) vs all + ข้อมูล matched
    bid = _create_bill(admin_client)
    txn = admin_client.get(f"/api/creditcard/bills/{bid}").json()["transactions"][0]
    # ใบที่จะจับคู่
    inv_matched = admin_client.post("/api/creditcard/invoices",
                                    json={"company": "Anthropic", "kind": "invoice",
                                          "bill_id": bid, "amount": 100.0}).json()["id"]
    admin_client.post("/api/creditcard/matches",
                      json={"transaction_id": txn["id"], "invoice_id": inv_matched})
    # ใบลอย (ยังไม่จับคู่)
    inv_float = admin_client.post("/api/creditcard/invoices",
                                  json={"company": "Google", "kind": "receipt",
                                        "amount": 50.0}).json()["id"]

    # default (unmatched) → เห็นเฉพาะใบลอย
    un = admin_client.get("/api/creditcard/pool-invoices").json()["invoices"]
    ids = [i["id"] for i in un]
    assert inv_float in ids and inv_matched not in ids

    # scope=all → เห็นทั้งคู่ + ใบที่จับคู่มีข้อมูล matched
    allinv = admin_client.get("/api/creditcard/pool-invoices?scope=all").json()["invoices"]
    ids2 = [i["id"] for i in allinv]
    assert inv_float in ids2 and inv_matched in ids2
    m = [i for i in allinv if i["id"] == inv_matched][0]
    assert m["matched"] is not None
    assert m["matched"]["bill_id"] == bid
    assert m["matched"]["txn_description"] == txn["description"]
    f = [i for i in allinv if i["id"] == inv_float][0]
    assert f["matched"] is None

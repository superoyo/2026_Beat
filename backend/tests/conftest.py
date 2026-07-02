# Test fixtures for server.py — pytest + FastAPI TestClient
#
# กลยุทธ์ isolation: DB_PATH เป็น module global ที่ db_conn() อ่านตอนเรียก
# → monkeypatch server.DB_PATH เป็นไฟล์ใหม่ต่อ test แล้วเรียก init_db()
# ทุก test ได้ DB เปล่า ไม่มี cross-test interference
#
# Sessions เป็น in-memory dict → สร้างผ่าน server.create_session()/
# create_member_session() ตรง ๆ แล้ว set cookie บน TestClient
import os
import sys
import tempfile
import uuid
from pathlib import Path

# ต้อง set env ก่อน import server — DB_PATH ถูกอ่านตอน import
# (ไฟล์นี้เป็นแค่ guard กัน init โดน DB จริง; แต่ละ test ใช้ tmp_path แยก)
_IMPORT_GUARD_DIR = tempfile.mkdtemp(prefix="fct-test-guard-")
os.environ.setdefault("FCT_DB_PATH", str(Path(_IMPORT_GUARD_DIR) / "guard.db"))

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient บน DB เปล่า (สร้างใหม่ต่อ test) — ไม่มี auth cookie"""
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    server.init_db()
    server._SESSIONS.clear()
    server._MEMBER_SESSIONS.clear()
    with TestClient(server.app) as c:
        yield c


@pytest.fixture()
def admin_client(client):
    """TestClient พร้อม super-admin session cookie"""
    token = server.create_session(user_id=1, username="test-admin")
    client.cookies.set("fct_session", token)
    return client


# ---------------------------------------------------------------------------
# Data factories — insert ตรงเข้า DB (เร็วกว่า + ไม่พึ่ง endpoint ที่กำลังทดสอบ)
# ---------------------------------------------------------------------------

def make_member(display_name="ทดสอบ", *, email=None, phone=None, is_admin=0,
                is_alumni=0, is_temp=0, temp_department=None,
                last_working_day=None, replaces_member_id=None) -> int:
    uniq = uuid.uuid4().hex[:12]
    with server.db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO members(phone, firebase_uid, display_name, email, is_admin, "
            "                    is_alumni, is_temp, temp_department, last_working_day, "
            "                    replaces_member_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (phone or f"nophone:{uniq}", f"test:{uniq}", display_name, email,
             is_admin, is_alumni, is_temp, temp_department, last_working_day,
             replaces_member_id, server.utc_now().isoformat()),
        )
        return cur.lastrowid


def make_team(name=None, parent_team_id=None) -> int:
    with server.db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO teams(name, description, created_at, parent_team_id) "
            "VALUES (?, NULL, ?, ?)",
            (name or f"team-{uuid.uuid4().hex[:8]}", server.utc_now().isoformat(),
             parent_team_id),
        )
        return cur.lastrowid


def add_to_team(team_id: int, member_id: int) -> None:
    with server.db_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO team_members(team_id, member_id, added_at) "
            "VALUES (?, ?, ?)",
            (team_id, member_id, server.utc_now().isoformat()),
        )


def member_login(client, member_id: int, phone="+66800000000"):
    """สร้าง member session + set cookie — คืน client เดิม
    เคลียร์ admin cookie ด้วย (กันกรณี test ใช้ admin_client แล้วสลับมาเป็น member)"""
    client.cookies.delete("fct_session")
    token = server.create_member_session(member_id, phone)
    client.cookies.set("fct_member_session", token)
    return client


def db_row(sql: str, params=()):
    with server.db_conn() as conn:
        return conn.execute(sql, params).fetchone()


def db_rows(sql: str, params=()):
    with server.db_conn() as conn:
        return conn.execute(sql, params).fetchall()

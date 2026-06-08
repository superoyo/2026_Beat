"""
claude_usage_parser.py — แยก logic การ parse usage ของ Claude.ai ไว้ที่เดียว (แก้ง่าย)

⚠️⚠️  ต้อง VERIFY กับของจริงก่อนใช้งานจริง  ⚠️⚠️
โครงสร้าง usage JSON และ DOM ของ claude.ai เป็น UNDOCUMENTED + เปลี่ยนได้ทุกเมื่อ
วิธี verify (ทำครั้งเดียวตอน build / ตอนมันพัง):
  1) เปิด https://claude.ai/settings/usage (login แล้ว) → DevTools › Network
  2) หา response ที่มี usage data (มักมี url คำว่า 'usage' / 'rate' / 'limit', status 200, type JSON)
  3) ดู key จริง แล้วเติม candidate keys ใน _KEYS_* ด้านล่าง / ปรับ _pick_block()
  4) ถ้า capture JSON ไม่ได้เลย → ใช้ parse_dom_text() เป็น fallback (อ่านตัวเลข % จาก DOM)

ฟังก์ชันนี้ออกแบบให้ DEFENSIVE: ไม่ throw, คืน dict เสมอ, ถ้าหาไม่เจอ field ไหนก็ปล่อย None
"""
from __future__ import annotations

import re
from typing import Any, Optional

# candidate key fragments (lowercase substring match) — เติมได้เมื่อเห็น response จริง
_KEYS_SESSION = ("session", "five_hour", "5h", "current_window", "rolling")
_KEYS_WEEKLY = ("week", "weekly", "7d", "seven_day")
_KEYS_OPUS = ("opus",)
_KEYS_PCT = ("utilization", "percent", "pct", "used_pct", "usage_pct", "ratio")
_KEYS_RESET = ("reset", "resets_at", "reset_at", "refresh_at", "renews_at", "next_reset")
_KEYS_REMAIN = ("remaining", "remaining_pct", "left")


def _walk(obj: Any):
    """yield (path_lower, key_lower, value) ทุก node ใน dict/list ซ้อนกัน"""
    stack = [("", obj)]
    while stack:
        path, cur = stack.pop()
        if isinstance(cur, dict):
            for k, v in cur.items():
                kl = str(k).lower()
                p = f"{path}.{kl}"
                yield p, kl, v
                if isinstance(v, (dict, list)):
                    stack.append((p, v))
        elif isinstance(cur, list):
            for i, v in enumerate(cur):
                p = f"{path}[{i}]"
                if isinstance(v, (dict, list)):
                    stack.append((p, v))


def _as_pct(v: Any) -> Optional[float]:
    """แปลงค่าเป็นเปอร์เซ็นต์ 0..100 (รองรับ ratio 0..1)"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    if 0 <= f <= 1.0:
        return round(f * 100, 1)
    return round(f, 1)


def _match(key: str, frags: tuple) -> bool:
    return any(fr in key for fr in frags)


def _pick_block(captured: list, scope_keys: tuple, exclude_keys: tuple = ()) -> dict:
    """หา pct + reset ภายใต้ node ที่ path เกี่ยวกับ scope (session/weekly/opus)
    exclude_keys: ตัด path ที่เข้าเงื่อนไขนี้ (เช่น weekly ไม่เอา opus)"""
    pct: Optional[float] = None
    reset: Optional[str] = None
    for data in captured:
        if not isinstance(data, (dict, list)):
            continue
        for path, key, val in _walk(data):
            if not _match(path, scope_keys):
                continue
            if exclude_keys and _match(path, exclude_keys):
                continue
            if pct is None and _match(key, _KEYS_PCT) and isinstance(val, (int, float, str)):
                p = _as_pct(val)
                if p is not None:
                    pct = p
            if pct is None and _match(key, _KEYS_REMAIN):
                p = _as_pct(val)
                if p is not None:
                    pct = round(100 - p, 1)  # remaining → used
            if reset is None and _match(key, _KEYS_RESET) and isinstance(val, (str, int, float)):
                reset = str(val)
    return {"pct": pct, "reset": reset}


def parse_usage(captured: list, page_text: str = "") -> dict:
    """
    captured: list ของ JSON object ที่ดักจาก network responses (usage endpoints)
    page_text: text ของหน้า (fallback)
    คืน dict: session_pct, session_reset_at, weekly_pct, weekly_reset_at, weekly_opus_pct, weekly_opus_reset_at, found
    """
    out = {
        "session_pct": None, "session_reset_at": None,
        "weekly_pct": None, "weekly_reset_at": None,
        "weekly_opus_pct": None, "weekly_opus_reset_at": None,
        "found": False,
    }
    captured = [c for c in (captured or []) if isinstance(c, (dict, list))]
    if captured:
        sess = _pick_block(captured, _KEYS_SESSION, exclude_keys=_KEYS_OPUS)
        out["session_pct"], out["session_reset_at"] = sess["pct"], sess["reset"]
        wk = _pick_block(captured, _KEYS_WEEKLY, exclude_keys=_KEYS_OPUS)
        out["weekly_pct"], out["weekly_reset_at"] = wk["pct"], wk["reset"]
        opus = _pick_block(captured, _KEYS_OPUS)
        out["weekly_opus_pct"], out["weekly_opus_reset_at"] = opus["pct"], opus["reset"]

    if out["session_pct"] is None and out["weekly_pct"] is None and page_text:
        dom = parse_dom_text(page_text)
        out.update({k: v for k, v in dom.items() if v is not None})

    out["found"] = any(out[k] is not None for k in ("session_pct", "weekly_pct", "weekly_opus_pct"))
    return out


def parse_dom_text(text: str) -> dict:
    """fallback หยาบ: หา 'NN%' ใกล้คำว่า session/week จาก text ของหน้า"""
    res = {"session_pct": None, "weekly_pct": None}
    low = (text or "").lower()
    for label, key in (("session", "session_pct"), ("week", "weekly_pct")):
        idx = low.find(label)
        if idx >= 0:
            m = re.search(r"(\d{1,3})\s*%", low[idx:idx + 160])
            if m:
                try:
                    res[key] = float(m.group(1))
                except ValueError:
                    pass
    return res


def compute_status(parsed: dict, threshold_pct: float) -> str:
    """ok | full — full เมื่อ session หรือ weekly แตะ/เกิน threshold หรือ 100%"""
    vals = [parsed.get("session_pct"), parsed.get("weekly_pct"), parsed.get("weekly_opus_pct")]
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals:
        return "ok"
    hi = max(vals)
    if hi >= 100:
        return "full"
    if hi >= float(threshold_pct or 90):
        return "full"
    return "ok"

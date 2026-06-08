# Claude RateLimit — ติดตาม usage/limit ของ Claude.ai subscription

ติดตามสถานะ session/weekly limit ของหลาย Claude.ai account (Pro/Max/Team) แล้วแจ้งเตือนเมื่อใกล้เต็ม
หรือ session หมดอายุ — อยู่ที่ **Platform › Claude RateLimit** (Dashboard + Settings)

> ⚠️ ใช้ส่วนตัวเท่านั้น · เป็น Claude.ai **subscription** (ไม่ใช่ API) → ไม่มี official API
> วิธีอ่าน status ทางเดียวคือ Playwright headless + session ที่ capture เอง

---

## ภาพรวมสถาปัตยกรรม

| ส่วน | ทำอะไร | รันที่ไหน |
|---|---|---|
| **เครื่อง dev** | `scripts/save_session.py` — login มือ แล้ว export `storageState` | local (มีจอ) |
| **web service** (FastAPI) | UI + เก็บ account/session (เข้ารหัส) + settings + alert | Railway (เดิม) |
| **worker service** | `scripts/claude_usage_worker.py` — Playwright เปิด `/settings/usage` อ่าน usage → เขียน snapshot → alert | Railway (service ใหม่, `Dockerfile.worker`) |

web service **ไม่ login เอง** และ **ไม่มี Chromium** — ทำหน้าที่แค่เก็บ session ที่ได้มาแล้ว ให้ worker ไปใช้

---

## ขั้นตอนใช้งาน

### 1) Capture session (ทำที่เครื่อง dev ต่อ 1 account)
```bash
pip install playwright cryptography
python -m playwright install chromium
python scripts/save_session.py --out claude_session_<label>.json
# → เบราว์เซอร์เปิด, login ให้เสร็จ, กลับมากด Enter → ได้ไฟล์ JSON
```

### 2) เพิ่ม account + อัปโหลด session (ในเว็บ)
Platform › Claude RateLimit › **Settings** → `+ เพิ่ม account` → วาง/อัปโหลดไฟล์ JSON → `📤 บันทึก session`
สถานะจะขึ้น `healthy`

### 3) ตั้งค่า alert + worker
- Settings: ใส่ **Webhook URL** (Teams / Power Automate / generic — POST `{"text": ...}`) หรือ **LINE token** + (optional) `LINE to`
- ตั้ง **threshold %** และ **cron** (แนะนำรายชั่วโมง `0 * * * *`)
- กด **🔔 Test alert** เพื่อทดสอบช่อง

### 4) Deploy worker (Railway service ใหม่)
- New service จาก repo เดิม → Dockerfile = `Dockerfile.worker`
- Schedule แบบ **cron รายชั่วโมง** (Railway cron) → รัน `python scripts/claude_usage_worker.py` รอบเดียวจบ
- ENV ที่ต้องตั้งให้ **ตรงกับ web service**:
  - `FCT_DB_PATH` — ชี้ไป SQLite บน **Volume เดียวกับ web** (worker เขียน snapshot ลง DB เดียวกัน)
  - `CLAUDE_RL_KEY` — **Fernet key เดียวกับ web** (ถอดรหัส storage_state) — สร้างด้วย
    `python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`
    แล้วตั้งให้ทั้ง web + worker (ถ้าไม่ตั้ง web จะ gen เก็บไฟล์ `claude_rl.key` ข้าง DB — worker อ่านไฟล์นั้นได้ถ้าแชร์ Volume)

---

## 🔍 ต้อง VERIFY กับของจริง (ห้ามเดา)
`backend/claude_usage_parser.py` มี candidate keys/selectors แบบ defensive แต่โครงสร้าง usage JSON
ของ claude.ai เป็น **undocumented** — ก่อนใช้จริงให้ verify:
1. เปิด `https://claude.ai/settings/usage` (login แล้ว) → DevTools › Network
2. หา response usage (มักมี url `usage`/`rate`/`limit`, JSON 200) → ดู key จริง
3. เติม/ปรับใน `_KEYS_*` / `_pick_block()` ของ parser + `USAGE_RESP_HINTS` ใน worker
4. ถ้า capture JSON ไม่ได้ → ใช้ `parse_dom_text()` (อ่าน % จาก DOM) เป็น fallback
5. เช็คว่า **Team** account แสดง usage ต่างจาก Pro/Max ไหม → ปรับ scope keys

---

## 🔐 Security
- `storageState` = credential เต็มของ session → เก็บแบบ **encrypted** (Fernet) ใน DB, **ไม่ commit**, **ไม่ log cookie ดิบ**, mask ใน UI
- `*.json` session files และ `claude_rl.key` ต้องอยู่ใน `.gitignore`

## ⚠️ Known risks
- IP ของ Railway (datacenter) ต่างจาก IP ตอน login → session อาจ **อายุสั้นลง / ถูกบังคับ verify** → ระบบจะขึ้น `expired` + alert
- ToS gray area → ตั้งความถี่ **รายชั่วโมง** (ไม่ใช่ทุกนาที), ใช้กับ account ของตัวเองเท่านั้น

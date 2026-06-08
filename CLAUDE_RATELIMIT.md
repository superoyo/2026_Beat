# Claude RateLimit — ติดตาม usage/limit ของ Claude.ai subscription

ติดตามสถานะ session(5h)/weekly limit ของหลาย Claude.ai account แล้วแจ้งเตือนเมื่อใกล้เต็ม/หมดอายุ
อยู่ที่ **Platform › Claude RateLimit** (Dashboard + Settings)

> ⚠️ ใช้ส่วนตัวเท่านั้น · เป็น Claude.ai **subscription** (ไม่ใช่ API) → ไม่มี official API

---

## ⛔ ทำไมไม่ดึงบน Railway (server) — ผลทดสอบจริง
claude.ai มี **Cloudflare bot challenge** → **headless บน server โดนบล็อก** และ `cf_clearance`
ผูกกับ **IP + User-Agent** ที่ login → Railway (IP datacenter) จะโดน challenge ซ้ำ ใช้ไม่ได้จริง
(`Dockerfile.worker` + `scripts/claude_usage_worker.py` เก็บไว้เป็น reference แต่ **ไม่แนะนำ**)

→ จึงเช็คจาก **เครื่องคุณเอง** (IP เดียวกับ login, ผ่าน Cloudflare แบบมนุษย์) แล้วส่งแค่ตัวเลขเข้าเว็บ

## สถาปัตยกรรม (Local runner)
| ส่วน | ทำอะไร | รันที่ไหน |
|---|---|---|
| `scripts/save_session.py` | login มือ → capture + **verify** session | เครื่องคุณ (มีจอ) |
| `scripts/claude_usage_local.py` | Playwright stealth เปิด usage → parse → **POST แค่ % เข้าเว็บ** | เครื่องคุณ (cron) |
| web (FastAPI) | รับ `/ingest` → เก็บ snapshot + alert + Dashboard | Railway |

🔐 **session อยู่ในเครื่องคุณ ไม่ออกไปไหน** — ส่งเข้าเว็บแค่ตัวเลข usage (ปลอดภัยกว่าอัปโหลด session)

---

## ขั้นตอนใช้งาน

### 0) เตรียม (ครั้งเดียว)
```bash
python3 -m pip install --user playwright cryptography
python3 -m playwright install chromium
```

### 1) ตั้ง ingest token (เว็บ)
ตั้ง env บน Railway web service: `CLAUDE_RL_INGEST_TOKEN` = สตริงลับสักอัน (เช่น
`python3 -c "import secrets;print(secrets.token_urlsafe(24))"`)

### 2) Capture session (ต่อ 1 account)
```bash
python3 scripts/save_session.py --out claude_<label>.json
# login ให้เห็นหน้าแอป → กด Enter → สคริปต์เช็คว่า "อ่าน usage ได้" แล้วค่อย save
```

### 3) config local runner
สร้าง `scripts/claude_runner_config.json` (gitignore แล้ว):
```json
{
  "web_base": "https://<railway-web-domain>",
  "ingest_token": "<CLAUDE_RL_INGEST_TOKEN เดียวกับเว็บ>",
  "headless": false,
  "accounts": [ {"label": "superoyo@gmail.com", "session_file": "claude_superoyo.json"} ]
}
```

### 4) รัน + ตั้ง cron
```bash
python3 scripts/claude_usage_local.py          # ทดสอบรอบเดียว
# cron รายชั่วโมง (crontab -e):
0 * * * * cd /path/to/2026_Beat && /usr/bin/python3 scripts/claude_usage_local.py >> /tmp/claude_rl.log 2>&1
```
→ ตัวเลขจะขึ้นบน Dashboard · alert ส่งตอน state เปลี่ยน (OK→Full / healthy→expired)

### 5) ตั้ง alert (เว็บ)
Platform › Claude RateLimit › Settings → Webhook URL (Teams/Power Automate) หรือ LINE token →
ตั้ง threshold → **🔔 Test alert**

---

## usage JSON (ยืนยันจริง 2026-06)
endpoint คืน: `{"five_hour":{"utilization":%,"resets_at":..},"seven_day":{..},"seven_day_opus":..|null,
"seven_day_sonnet":..,"extra_usage":{..}}` — `utilization` เป็น % ตรง (0..100)
parser อยู่ที่ `backend/claude_usage_parser.py` (map ตรง + fallback heuristic)

## 🔐 Security
- session/`claude_*.json`, `claude_runner_config.json`, `claude_rl.key` → gitignore แล้ว, ไม่ commit, ไม่ log
- เว็บเก็บแค่ % usage (ไม่มี credential)

## ⚠️ Known risks
- ToS gray area → cron **รายชั่วโมง** (ไม่ใช่ทุกนาที), account ตัวเองเท่านั้น
- เครื่อง local ต้องเปิดอยู่ตอน cron ยิง · headless=false (มีจอ) ผ่าน Cloudflare ได้เสถียรสุด
- session หมดอายุเป็นระยะ → รัน `save_session.py` ใหม่ (Dashboard จะขึ้น ⚠️ expired + alert)

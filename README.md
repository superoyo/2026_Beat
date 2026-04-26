# Freepik Credit Tracker

ติดตามยอดเครดิต Freepik Premium แบบอัตโนมัติ — Chrome extension จะอ่านยอด
จากเบราว์เซอร์ของคุณเอง ส่งให้ FastAPI backend ในเครื่อง แล้วแสดง burn rate
และวันที่คาดว่าจะหมดบน dashboard เดียว ทั้งหมดทำงานบน `localhost` ไม่มี cloud
ไม่มี telemetry

## ทำไมต้องสร้างเอง

Freepik ไม่ได้เปิด API สำหรับเช็คยอดเครดิตคงเหลือ — รู้ได้แค่จากการ login เข้า
หน้าเว็บแล้วดูเอง โปรเจกต์นี้แก้ปัญหานั้นโดย scrape ข้อมูลจาก DOM ของ session
เบราว์เซอร์ของผู้ใช้เอง ซึ่งถูกต้องตาม ToS และไม่ต้องเก็บรหัสผ่าน

## Architecture

```
┌──────────────────────────┐
│  freepik.com (any page)  │
│  user is logged in       │
└────────────┬─────────────┘
             │ DOM
             ▼
┌──────────────────────────┐
│  Chrome Extension (MV3)  │
│  • content.js scrapes    │
│  • background.js relays  │
│  • popup.html shows last │
└────────────┬─────────────┘
             │ HTTP POST /api/snapshot
             ▼
┌──────────────────────────┐
│  FastAPI server          │
│  http://localhost:8765   │
│  ┌────────────────────┐  │
│  │ SQLite             │  │
│  │ snapshots, config  │  │
│  └────────────────────┘  │
└────────────┬─────────────┘
             │ GET /  (serves dashboard.html)
             │ GET /api/summary, /api/history
             ▼
┌──────────────────────────┐
│  Dashboard               │
│  • current balance card  │
│  • burn rate + projection│
│  • 30-day chart          │
│  • snapshots table       │
└──────────────────────────┘
```

## ติดตั้ง Backend

ต้องมี Python 3.11+ (Python 3.9 ใช้ได้เพราะ `from __future__ import annotations`
แต่แนะนำ 3.11 ขึ้นไป)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8765
```

ตรวจสอบว่า server รันแล้ว:

```bash
curl http://localhost:8765/api/health
# → {"status":"ok","version":"1.0.0"}
```

ฐานข้อมูล SQLite จะถูกสร้างไฟล์ `backend/freepik_tracker.db` ให้อัตโนมัติเมื่อ
รันครั้งแรก

## ติดตั้ง Chrome Extension

1. เปิด Chrome ไปที่ `chrome://extensions`
2. เปิด **Developer mode** มุมขวาบน
3. กด **Load unpacked** แล้วเลือกโฟลเดอร์ `extension/`
4. extension จะปรากฏใน toolbar — pin ไว้ใช้สะดวกกว่า

## ใช้งานครั้งแรก

1. ตรวจให้แน่ใจว่า backend ยังรันอยู่ (`curl http://localhost:8765/api/health`)
2. เปิด `https://www.freepik.com` แล้ว login (ถ้ายังไม่ได้ login)
3. ไปยังหน้าใดๆ ที่แสดงยอดเครดิต (เช่น profile, header)
4. extension จะ scrape เลขเครดิตอัตโนมัติและส่งไปยัง backend
5. เปิด `http://localhost:8765` เพื่อดู dashboard

หลังจากเก็บข้อมูลได้อย่างน้อย 2-3 วัน burn rate และวันที่คาดว่าจะหมดจะเริ่มแม่น

## ปรับแต่ง CSS Selector (เมื่ออัตโนมัติหาไม่เจอ)

ถ้า popup แสดง `—` ตลอดแม้จะอยู่บน freepik.com:

1. กดคลิกขวาบนเลขเครดิต → **Inspect**
2. คัดลอก CSS selector ของ element ที่มีตัวเลข (Chrome DevTools มีปุ่ม Copy →
   Copy selector ให้)
3. กดไอคอน extension → **ตั้งค่า** → วาง selector ลงในช่อง Custom CSS Selector
4. กด **ทดสอบ Selector** เพื่อตรวจว่าจับเลขถูกหรือเปล่า
5. กด **บันทึก**

## ปรับโควต้ารายเดือน / รอบบิล

เปิด `http://localhost:8765` → คลิก **ตั้งค่า** ที่ด้านล่างของ dashboard เพื่อ
ปรับ:

- **โควต้ารายเดือน** — เครดิตที่ Freepik ให้ต่อเดือน (default 10,000)
- **วันที่รอบบิลเริ่ม** — วันที่ของเดือนที่รอบใหม่เริ่ม (default 1)

## API endpoints (ไว้ debug หรือสคริปต์เอง)

| Method | Path                    | คำอธิบาย                              |
|--------|-------------------------|----------------------------------------|
| GET    | `/`                     | dashboard HTML                         |
| GET    | `/api/health`           | ping                                   |
| POST   | `/api/snapshot`         | บันทึก snapshot ใหม่                   |
| GET    | `/api/history?days=30`  | ยอดคงเหลือรายวัน                       |
| GET    | `/api/snapshots?limit=20`| snapshots ล่าสุด                       |
| GET    | `/api/summary`          | analytics ทั้งหมด (burn rate, alert)  |
| GET    | `/api/config`           | อ่าน config                            |
| PATCH  | `/api/config`           | แก้ quota / cycle day                  |

## Troubleshooting

**Backend ไม่ทำงาน / popup โชว์ "ติดต่อ backend ไม่ได้"**
- เช็คว่า uvicorn ยังรันอยู่ และ port 8765 ว่าง
- ถ้าใช้ port อื่น เปิด extension options แล้วเปลี่ยน Backend URL

**Extension ไม่ตรวจจับยอดเครดิต**
- เปิด DevTools (F12) บน freepik.com → ดู Console
- มองหาบรรทัดที่ขึ้นต้นด้วย `[FCT]` — จะบอกว่าหา selector เจอหรือไม่
- ถ้าไม่เจอ ให้ตั้ง custom selector ตามขั้นตอนด้านบน

**Dashboard แสดง "ยังไม่มีข้อมูล"**
- ต้องเปิด freepik.com อย่างน้อยหนึ่งครั้ง (และ login) เพื่อให้ extension เก็บ
  snapshot แรก

**ข้อมูลในคิวไม่ถูกส่ง**
- background.js จะ flush คิวอัตโนมัติเมื่อ snapshot ใหม่ POST สำเร็จ
- ถ้าอยากบังคับ flush ทันที: เปิด `chrome://extensions` → กด **service worker**
  ของ extension → ใน console พิมพ์
  ```js
  chrome.runtime.sendMessage({type: 'DRAIN_NOW'})
  ```

## Privacy

ทุกอย่างทำงานบนเครื่องคุณเองทั้งหมด:
- snapshots เก็บใน `backend/freepik_tracker.db` (SQLite local)
- extension settings เก็บใน Chrome sync storage (ของ Google account คุณเอง)
- backend bind ที่ `127.0.0.1` เท่านั้น — เครื่องอื่นในเครือข่ายเห็นไม่ได้
- ไม่ส่งข้อมูลไป cloud ไม่มี telemetry ไม่มี analytics

## License

ใช้ส่วนตัวได้ตามสบาย ไม่รับประกันใดๆ

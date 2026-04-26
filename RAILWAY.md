# Deploy to Railway

## Required environment variables

Set these in Railway → Variables:

| Var | Value | จำเป็น |
|-----|-------|--------|
| `FCT_PUBLIC_DEPLOY` | `true` | ✅ — เปิด CORS + secure cookie + bind 0.0.0.0 |
| `FCT_DB_PATH` | `/data/freepik_tracker.db` | ✅ ถ้ามี volume — ไม่งั้น DB หายทุกครั้ง redeploy |
| `PORT` | (auto) | Railway ใส่ให้เอง |

## Optional: Persistent volume

ถ้าไม่ตั้ง volume → SQLite DB หายทุกครั้ง redeploy = admin password + sites + credentials หายหมด

วิธีตั้ง:
1. Railway dashboard → service → **Volumes** → **+ New Volume**
2. Mount path: `/data`
3. ตั้ง env: `FCT_DB_PATH=/data/freepik_tracker.db`

## After first deploy

1. เปิด `https://<your-app>.railway.app/admin/login`
2. ตั้ง admin username/password
3. คลิก **🔑 API Key** ใน sidebar → คัดลอก
4. ในเครื่อง local → กดไอคอน FEFL Beat extension → **ตั้งค่า**:
   - Backend URL: `https://<your-app>.railway.app`
   - API Key: (paste จาก step 3)
5. Reload extension

## Security checklist

- ✅ `FCT_PUBLIC_DEPLOY=true` ตั้งแล้ว → CORS + cookie secure
- ✅ Admin password แข็งแรง (≥ 12 ตัว)
- ✅ API Key เป็นความลับ — ใส่เฉพาะ extension ของคนในทีม
- ⚠️ Credentials เก็บ plaintext ใน DB — ควรมี volume backup

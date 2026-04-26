# Firebase Phone Auth — Setup Guide

ระบบ member login (เบอร์มือถือ + OTP) ใช้ **Firebase Phone Authentication**
ฝั่ง backend verify ID token ผ่าน Firebase REST API (ไม่มี dep เพิ่ม)

ถ้ายังไม่ตั้งค่า Firebase → หน้า `/login` จะแจ้งว่า "Firebase ยังไม่ได้ตั้งค่า" และ
ปุ่ม "ส่ง OTP" ถูก disable แต่ระบบส่วนอื่น (admin, dashboard, extension) ทำงานปกติ

---

## ขั้นตอน setup

### 1. สร้าง Firebase project

1. ไป https://console.firebase.google.com → **+ Add project**
2. ตั้งชื่อ (เช่น `fefl-beat`) → Continue → ปิด Google Analytics ก็ได้ → Create

### 2. เปิด Phone Authentication

1. Firebase Console → **Authentication** → tab **Sign-in method**
2. เลือก **Phone** → Enable → Save

### 3. เพิ่ม Web app + เอา config

1. หน้า Project Overview → กดไอคอน `</>`  (Web)
2. ตั้งชื่อ app (เช่น `fefl-beat-web`) → Register app
3. จะเห็น JavaScript config — copy ค่า 6 ตัวนี้:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",                  ← FIREBASE_WEB_API_KEY
  authDomain: "fefl-beat.firebaseapp.com",  ← FIREBASE_AUTH_DOMAIN
  projectId: "fefl-beat",               ← FIREBASE_PROJECT_ID
  storageBucket: "fefl-beat.appspot.com",  ← FIREBASE_STORAGE_BUCKET
  messagingSenderId: "1234567890",      ← FIREBASE_MESSAGING_SENDER_ID
  appId: "1:1234:web:abc123..."         ← FIREBASE_APP_ID
};
```

### 4. เพิ่ม Authorized domain

1. Firebase Console → Authentication → Settings → **Authorized domains**
2. กด **Add domain**
3. เพิ่มทั้ง:
   - `2026beat-production.up.railway.app` (Railway URL ของคุณ)
   - `localhost` (สำหรับ test local)

### 5. ตั้ง env vars บน Railway

Railway dashboard → service → **Variables** → เพิ่มทั้ง 6 ตัว:

| Variable | ค่าจาก step 3 |
|----------|---------------|
| `FIREBASE_WEB_API_KEY` | apiKey |
| `FIREBASE_AUTH_DOMAIN` | authDomain |
| `FIREBASE_PROJECT_ID` | projectId |
| `FIREBASE_STORAGE_BUCKET` | storageBucket |
| `FIREBASE_MESSAGING_SENDER_ID` | messagingSenderId |
| `FIREBASE_APP_ID` | appId |

หลัง save → Railway redeploy อัตโนมัติ (~2 นาที)

### 6. ทดสอบ

1. เปิด Railway URL → กด **เข้าสู่ระบบ**
2. ใส่เบอร์มือถือ → **ส่งรหัส OTP**
3. เช็ค SMS → ใส่ OTP 6 หลัก → **ยืนยัน**
4. สำเร็จ → กลับหน้าแรก เห็น user pill มีเบอร์มือถือ

---

## Quotas / Pricing

Firebase Phone Auth (Spark plan / Free):
- **10,000 verifications/เดือน** ฟรีในประเทศ tier-1 (รวม Thailand)
- เกินนั้น → **$0.06/SMS** (Blaze plan)
- เปิด **Test phone numbers** ใน Console เพื่อ test ฟรี (ใส่เลข + OTP fix ไว้)

---

## Troubleshooting

**"auth/invalid-app-credential" ตอนกดส่ง OTP**
- ตรวจ Authorized domains ใน Firebase Console
- ต้องมี domain ของ Railway URL เป๊ะๆ (รวม subdomain)

**"auth/captcha-check-failed"**
- reCAPTCHA ถูก block — ลอง refresh หน้า reload reCAPTCHA ใหม่
- เช็คว่าไม่มี ad blocker block

**ส่ง OTP สำเร็จแต่ไม่ได้ SMS**
- เบอร์ format ผิด → ต้องเป็น `+66...` (มี country code)
- เลขไทยเริ่ม 0 → ระบบจะแปลงให้อัตโนมัติ (เช่น `0812345678` → `+66812345678`)
- เช็ค Test phone numbers ใน Firebase Console (อาจเปิด test mode อยู่)

**Backend แจ้ง "invalid id token: TOKEN_EXPIRED"**
- Firebase ID token หมดอายุใน 1 ชั่วโมง — user ต้อง login ใหม่

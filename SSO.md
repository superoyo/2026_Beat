# Beat SSO — login ด้วย Beat (Identity Provider)

ให้ระบบอื่น authenticate ผู้ใช้ผ่าน Beat โดย**ไม่ต้อง login ใหม่** (ถ้า login Beat อยู่แล้ว)
Beat ออก **id_token (JWT)** พิสูจน์ตัวตน — **ไม่แชร์รหัสผ่าน**

## ตั้งค่า (ฝั่ง Beat)
Setting › 🪪 **SSO** (super admin) → **+ เพิ่ม client** → ได้ `client_id` + `client_secret` →
ใส่ **redirect_uri** ของระบบนั้น (ต้องตรงเป๊ะ, 1 บรรทัด/อัน)

## Endpoints
- Authorize: `https://beat.datafirst.id/sso/authorize`
- Token:     `https://beat.datafirst.id/sso/token`
- UserInfo:  `https://beat.datafirst.id/sso/userinfo`

## Flow (Authorization Code)
1. ระบบอื่น redirect ผู้ใช้ไป:
   ```
   GET /sso/authorize?client_id=<cid>&redirect_uri=<uri>&state=<rand>&response_type=code
   ```
   - ถ้า login Beat อยู่แล้ว → กลับทันที · ถ้ายัง → ให้ login Beat ก่อนแล้วกลับมา
2. Beat redirect กลับ: `<redirect_uri>?code=<code>&state=<rand>`  (เช็ก `state` กัน CSRF)
3. ฝั่ง server แลก code (POST, form หรือ JSON):
   ```
   POST /sso/token
   client_id=<cid>&client_secret=<secret>&code=<code>&redirect_uri=<uri>
   ```
   ได้:
   ```json
   {"id_token":"<JWT>","access_token":"<JWT>","token_type":"Bearer","expires_in":3600,
    "profile":{"sub":"member:5","name":"...","email":"...","role":"member"}}
   ```
4. verify `id_token` (JWT HS256 ด้วย `client_secret`) → เชื่อ claims: `sub, name, email, role, iss, aud, exp`
   (หรือเรียก `GET /sso/userinfo` พร้อม `Authorization: Bearer <id_token>`)

## ตัวอย่าง (Python ฝั่ง RP)
```python
import requests, jwt   # PyJWT
r = requests.post("https://beat.datafirst.id/sso/token", data={
    "client_id": CID, "client_secret": SECRET, "code": code, "redirect_uri": URI})
tok = r.json()["id_token"]
claims = jwt.decode(tok, SECRET, algorithms=["HS256"], audience=CID,
                    issuer="https://beat.datafirst.id")
# claims["sub"], claims["email"], claims["role"] → สร้าง session ฝั่งระบบเอง
```

## หมายเหตุความปลอดภัย
- `redirect_uri` ต้องตรงกับที่ลงทะเบียน (กัน token หลุด)
- `code` ใช้ครั้งเดียว หมดอายุ ~2 นาที · `id_token` อายุ 1 ชม.
- เก็บ `client_secret` ฝั่ง server เท่านั้น · หมุน secret ได้ในหน้า SSO
- `sub` = `admin:<id>` หรือ `member:<id>` (ตัวระบุผู้ใช้ที่ไม่ซ้ำ)

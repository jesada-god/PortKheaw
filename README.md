# PortKheaw

## Analytics providers

When `ALPHA_VANTAGE_API_KEY` is configured, the server-side fundamentals adapter loads Alpha Vantage `INCOME_STATEMENT`, `BALANCE_SHEET`, and `CASH_FLOW` datasets. It normalizes annual and quarterly periods without converting missing values to zero. Trailing P/E requires four complete quarterly diluted-EPS values, matching quote/reporting currencies, positive EPS, and a quote no older than seven days.

Fundamentals are held in a private in-process cache for 24 hours (stale fallback up to seven days after a transient provider failure), with per-provider/symbol/dataset/period keys and in-flight request deduplication. Provider responses are never publicly cached by the authenticated analytics routes. Missing statements produce structured unavailable results; no production fallback financial values are generated.

### Analyst Consensus

Analyst Consensus requests Finnhub `stock/price-target` first and uses `targetMean` as the target. When that endpoint is unavailable, not entitled, or rate limited, the server falls back to Alpha Vantage `OVERVIEW.AnalystTargetPrice`. Provider values are alternatives and are never averaged together. FMP is not part of the Analyst Consensus runtime.

Targets are cached server-side for 24 hours under `analyst-target:v2:{symbol}`. After a provider failure, a previously valid target may be served as explicitly stale data for no more than 48 hours from its original cache time. Current price is loaded through the accepted Nexora quote pipeline and is never stored in the target cache.

For production, configure only server-side keys and confirm the applicable provider display/redistribution license before enabling public access:

```dotenv
FEATURE_ANALYST_CONSENSUS=true
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
```

API keys never enter browser bundles. Finnhub uses the `X-Finnhub-Token` request header, and no provider token is logged. A missing, unentitled, rate-limited, or unavailable provider is displayed truthfully and never replaced with a calculated or fabricated target. The provider responses do not include individual institution names, so the UI does not invent them.

Intelligent Investment Analytics — แพลตฟอร์มวิเคราะห์ ติดตามพอร์ต และจำลองการลงทุนด้วยข้อมูลและ AI

PortKheaw เป็นเว็บแอป Next.js สำหรับติดตาม Watchlist, บันทึกข้อมูลพอร์ตด้วยตนเอง, ตั้ง Price Alert และใช้เครื่องมือ What-If กับ Monte Carlo โดยไม่มีระบบส่งคำสั่งซื้อขายจริง

## เริ่มใช้งาน

ต้องใช้ Node.js รุ่นที่รองรับ Next.js 15

```bash
npm install
npm run dev
```

เปิด `http://localhost:3000`

## ตรวจสอบคุณภาพ

```bash
npm run lint
npm run build
```

คำสั่ง QA หรือ server ที่ต้องมีเส้นตายให้เรียกผ่าน bounded runner เพื่อเก็บ PID/log, แสดง heartbeat ทุก 15 วินาที และปิดเฉพาะ process tree ที่ runner สร้างเมื่อ timeout หรือถูกขัดจังหวะ Logs จะอยู่ที่ `C:\tmp\portkheaw-qa\<run-id>\` และมี lock ป้องกัน QA ซ้อนกัน:

```powershell
npm run qa:bounded -- -Command "npm.cmd test -- src/components/ui/Modal.test.tsx" -TimeoutSeconds 600 -Step targeted-tests
```

กำหนด `-RetryCount 1` ได้เฉพาะคำสั่งที่คืน retryable exit code (ค่าเริ่มต้นคือ `75`) และเพิ่ม `-RetryOnTimeout` เฉพาะ workflow ที่ออกแบบให้ลองใหม่หลัง timeout ได้ ห้ามตั้ง retry เกิน 1 ครั้ง

ข้อมูลตลาด ข่าว ผลวิเคราะห์ พอร์ต และการแจ้งเตือนในเวอร์ชันนี้เป็นข้อมูลจำลองและยังไม่ได้เชื่อมต่อ backend หรือ market-data API จริง

## Authentication

หน้า `/auth/*` ทั้งหมด (welcome, sign-in, sign-up, forgot-password, reset-password, callback) ใช้ shell ของตัวเองโดยไม่มี sidebar/bottom nav และใช้ token ชุด `--auth-*` ใน `src/themes/portkheaw/auth.css` แยกจาก accent ของแอป

### เข้าสู่ระบบด้วย Google

ปุ่ม Google จะแสดง **ก็ต่อเมื่อโปรเจกต์ Supabase เปิด provider นี้จริง** โดยอ่านจาก `GET /auth/v1/settings` ของโปรเจกต์เอง (`src/lib/auth/providers.ts`, cache 5 นาที) ถ้าอ่านไม่ได้หรือปิดอยู่ ปุ่มจะไม่ถูก render และ chunk ของ Supabase browser client จะไม่ถูกดาวน์โหลด จึงไม่มีปุ่มที่กดแล้วพาไปหน้า error ของ provider

ขั้นตอนเปิดใช้งาน — ไม่ต้องแก้โค้ดและไม่ต้อง redeploy:

1. Supabase Dashboard → Authentication → Providers → Google → เปิดใช้งาน แล้วใส่ Client ID/Secret จาก Google Cloud Console
2. ใน Google Cloud Console ตั้ง Authorized redirect URI เป็น `https://<project-ref>.supabase.co/auth/v1/callback`
3. Supabase Dashboard → Authentication → URL Configuration → เพิ่ม Redirect URL ให้ครบทุก environment ที่ใช้จริง:
   - `http://localhost:3000/auth/callback`
   - `https://<production-domain>/auth/callback`
   - URL ของ preview deployment ถ้าต้องทดสอบบน preview

`redirectTo` ถูกสร้างจาก origin ของ request เสมอ ไม่เคยรับมาจาก query parameter และ `next` ถูกกรองด้วย `getSafeReturnPath` ทั้งตอนสร้างลิงก์และตอนกลับเข้า callback

### รหัสผ่านและการตั้งรหัสผ่านใหม่

เงื่อนไขรหัสผ่านมีที่มาที่เดียวคือ `PASSWORD_RULES` ใน `src/lib/auth/password-policy.ts` ซึ่ง checklist บนหน้าจอและ schema ฝั่ง server ใช้ร่วมกัน จึงไม่มีทางที่ checklist จะขึ้นเขียวแต่ server ปฏิเสธ

หน้า `/auth/reset-password` จะแสดงฟอร์มเฉพาะเมื่อ session ปัจจุบันเกิดจากการกดลิงก์ในอีเมลจริง (ตรวจจาก `amr` ของ access token ที่ผ่านการ verify แล้ว) และบัญชีนั้นมี password identity อยู่จริง บัญชีที่สมัครด้วย Google อย่างเดียวจึงตั้งรหัสผ่านผ่านเส้นทางนี้ไม่ได้ แม้จะถือลิงก์ recovery ที่ถูกต้อง

พฤติกรรมที่ gate เหล่านี้อ้างอิงวัดจากโปรเจกต์จริงด้วย:

```bash
npm run probe:auth-recovery
```

สคริปต์สร้าง user ชั่วคราวบนโดเมน `.invalid` อ่านค่า `amr`/`identities` แล้วลบ user ทิ้งใน `finally` ไม่มีการส่งอีเมลและไม่แตะบัญชีที่มีอยู่

## Phase 9: Background alerts และ Web Push

ระบบใช้ HTTP scheduler เรียก `GET /api/cron/alerts` แทน in-process timer จึงใช้ได้กับ deployment แบบ Next.js `standalone`, container และ serverless ปัจจุบัน ตั้ง schedule เริ่มต้นเป็นวันละครั้งเพื่อไม่ใช้ quota ของ market-data provider ถี่เกินไป แต่ละ run ประมวลผล alert ที่ค้างนานที่สุดไม่เกิน 5 รายการ เรียก quote ตาม symbol แบบลำดับ และไม่ retry เมื่อ provider แจ้ง rate limit

ตัวอย่าง scheduler (เวลาทั้งหมดเป็น UTC):

```cron
0 1 * * * curl --fail --silent --show-error \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.example/api/cron/alerts
```

ถ้า deploy บน Vercel สามารถกำหนด path เดียวกันใน `vercel.json`; Vercel จะส่ง `CRON_SECRET` เป็น Bearer header ให้อัตโนมัติ ดู [Vercel Cron documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs) แผน Hobby รองรับ cron ได้เพียงวันละครั้ง ส่วน deployment แบบ container ใช้ scheduler ของ platform หรือ system cron ภายนอก ห้ามใช้ `setInterval` ใน process เพราะ instance อาจหยุดหรือซ้ำกันได้

Environment ฝั่ง server ที่ต้องใช้:

```dotenv
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:ops@example.com
```

สร้าง VAPID key ด้วย `npx web-push generate-vapid-keys` และเก็บ private key, Service Role และ cron secret ใน secret manager ของ deployment เท่านั้น ห้ามเติม prefix `NEXT_PUBLIC_` ให้ค่าเหล่านี้ Public VAPID key ไม่ใช่ secret และส่งให้ browser ผ่าน authenticated endpoint เฉพาะตอนตั้งค่า Push

ก่อนเปิด cron ให้ apply migration `202607180010_phase_9_background_alerts_push.sql` ระบบสร้าง notification ด้วย service-only atomic RPC ที่มี row lock, cooldown และ idempotency; user flow ปกติยังใช้ session/publishable key และ RLS ตามเดิม Delivery queue unique ต่อ notification/device, retry สูงสุด 3 ครั้ง, ลบ subscription ที่หมดอายุหรือ provider ตอบ 404/410 และเก็บ disabled subscription ไม่เกิน 30 วัน

ผู้ใช้ต้องกด “เปิดใช้” ที่หน้า Settings ก่อน browser จึงจะขอ notification permission ผู้ใช้ปิดเป็นรายอุปกรณ์ได้ ตั้ง quiet hours/timezone ได้ และหน้า Settings จะแจ้งเมื่อ browser ไม่รองรับ, permission ถูกบล็อก หรือ server ยังไม่มี VAPID config Web Push ต้องใช้ secure context (HTTPS; localhost ใช้พัฒนาได้) และข้อจำกัด background notification แตกต่างตาม browser/OS

Monitoring ขั้นพื้นฐานอยู่ใน `alert_evaluation_runs` และ structured server logs ชื่อ `background-alerts` ซึ่งบันทึกเฉพาะ status/count/error code ไม่บันทึก user id, symbol, endpoint, push key, message หรือ secret หาก provider quota ต่ำกว่า workload ให้ลดความถี่ cron; implementation นี้ไม่ใช่ high-frequency/realtime alert และ freshness ยังขึ้นกับ Alpha Vantage, cache และเวลาตลาด

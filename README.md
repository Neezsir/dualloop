# DualLoop

Autonomous Dual-AI full-loop builder (`Claude` Backend/DB/Test + `Gemini` Frontend) with **PM2**, **Telegram 2-Way Choice UI**, **Git Auto-Checkpoint**, **Skip-on-Block Queue**, and **Ponytail** brevity.

## Quick Install (`npx` from GitHub)

```bash
# Interactive wizard: install SKILL.md + choose AI models/modes + Auto-Fallback + optional PM2
npx github:Neezsir/dualloop

# Full server setup (.env + Skill + PM2)
npx github:Neezsir/dualloop init

# Or install only the Agent Skill directly
npx skills add Neezsir/dualloop
```

## Run Locally or on External Server (PM2)

```bash
cp .env.example .env
pm2 start ecosystem.config.cjs
```

## Telegram Commands

- `/new <name> | <concept>` — Start clarify -> build -> 4-layer verify loop (queue-safe)
- `/continue <slug> | <instruction>` — Add features with DB migration guard
- `/resume <slug>` — Resume paused/interrupted project
- `/cancel` — Cancel active task and clear queue
- `/questions` — Answer queued blocked decisions
- `/status` — Show project states, job queue & PM2 status
- `/logs <slug>` — Tail PM2 logs
- `/model <backend|frontend> [provider] <model-id>` — Switch provider/model live
- `/export <slug>` — Export project `.zip` to chat or push to GitHub repo
- `/stats` — View build duration, AI call counts & fix loops
- `/update` — Self-update DualLoop via `git pull` & restart PM2
- `/rollback <slug>` — Reset to last Git checkpoint + DB snapshot
- `/delete <slug>` — Stop PM2 and remove project folder

Run `node bin/cli.js doctor` to verify Node, PM2, Git, AI providers, Headless Browser & Telegram.

## CLI Mode

```bash
node bin/cli.js run "todo-app" "Simple task manager with SQLite"
node bin/cli.js continue todo-app "Add dark mode toggle"
```

---

## คู่มือภาษาไทย (Thai Guide)

**DualLoop** คือระบบสร้างโปรแกรมแบบครบลูปด้วย AI สองฝั่งควบคู่กัน (`Claude` ทำ Backend / DB / Process / Test และ `Gemini` ทำ Frontend UI) ทำงานร่วมกับ **PM2**, **Telegram 2-Way**, **Git Auto-Checkpoint**, และกฎ **Ponytail** (โค้ดสั้น ตรงประเด็น ประหยัด Token)

### จุดเด่น
- **ถาม-ตอบแบบเลือกติ๊ก (Choice-Only):** สัมภาษณ์สเปกด้วยตัวเลือกสั้นๆ ทั้งใน Terminal (ใช้ปุ่มลูกศร `↑`/`↓`), IDE และปุ่มกดใน Telegram
- **Skip-on-Block:** งานไหนติดต้องรอคนตัดสินใจ ระบบจะข้ามไปทำส่วนอื่นจนจบก่อน แล้วเก็บคำถามไว้ให้กดเลือกทีหลัง
- **Auto-Fallback & โหมดประหยัดค่า API:** รองรับทั้งบัญชี CLI (`claude` Team/Pro และ `agy` Google AI Ultra / `gemini` CLI) และ API Key พร้อมสลับให้อัตโนมัติเมื่อเปิด `AUTO_FALLBACK=true`
- **สร้างแยกบน Desktop:** ทุกโปรเจกต์ใหม่จะถูกสร้างที่ `~/Desktop/<ชื่อ-slug>` ของเครื่องที่ใช้งาน พร้อม Git Checkpoint, Port แยก และ PM2 ประจำโปรเจกต์

### วิธีติดตั้งและใช้งาน
1. **ติดตั้งผ่าน `npx` (มีเมนูลูกศรให้เลือก Skill และรุ่น AI ทีละขั้น):**
   ```bash
   npx github:Neezsir/dualloop
   ```
   *(หรือติดตั้งเฉพาะ Skill เข้า IDE ด้วย `npx skills add Neezsir/dualloop`)*
2. **ตั้งค่า `.env` (กรณีใช้งาน Telegram + PM2):**
   - ใส่ `TELEGRAM_BOT_TOKEN` จาก `@BotFather`
   - รัน `pm2 start ecosystem.config.cjs` แล้วทัก `/start` ไปหาบอทเพื่อรับ `TELEGRAM_CHAT_ID` มาใส่ใน `.env` จากนั้นสั่ง `pm2 restart dualloop`
3. **คำสั่งหลักใน Telegram:**
   - `/new ชื่อแอป | คอนเซ็ปต์` — เริ่มสร้างโปรเจกต์ใหม่ตั้งแต่ถามสเปกจนรัน PM2 สำเร็จ
   - `/continue ชื่อ-slug | คำสั่งเพิ่มเติม` — สั่งแก้หรือเพิ่มฟีเจอร์ต่อจากโปรเจกต์เดิม
   - `/questions` — กดเลือกตอบคำถามที่ข้ามไว้
   - `/model claude|gemini <model-id>` — สลับรุ่นโมเดลชั่วคราว
   - `/status`, `/logs ชื่อ-slug`, `/rollback ชื่อ-slug` — เช็กสถานะ ดู log หรือย้อนกลับ Checkpoint


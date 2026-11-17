const DICT = {
  th: {
    botReady: 'DualLoop Bot พร้อมทำงานแล้ว (/help)\n🖥️ Dashboard: {url}',
    clarifyStart: '🔎 [Phase 1/4: Clarify] {name}\nกำลังวิเคราะห์ Concept และวางคำถามสเปก...',
    clarifyDone: '✅ [Phase 1/4 เสร็จสิ้น] {name}\nล็อก SPEC.md, DB_SCHEMA.sql, API_CONTRACT.json แล้ว ({count} tasks)\n📂 โฟลเดอร์: {dir}',
    checkpointDone: '💾 [Phase 2/4: Checkpoint] {name}\nGit: {hash} | DB Snapshot: {dbCount} ไฟล์',
    buildStep: '⚙️ [Phase 3/4: Build ({idx}/{total})] {name}\nAI: {aiTag}\nงาน: {title}',
    skipOnBlock: '⏸️ [Phase 3/4: Skip-on-Block] {name}\nงาน "{title}" ติดรอตัดสินใจ -> เก็บคำถามไว้และข้ามไปทำส่วนอื่นต่อ',
    buildDone: '✔️ [Phase 3/4 เสร็จ ({idx}/{total})] {title}\nไฟล์: {files}\nสรุป: {note}',
    schemaGuard: '🔄 [Schema Guard] {name} แก้ Contract/DB -> สั่งอีกฝั่ง Sync ใหม่',
    crossReviewStart: '🔍 [Phase 3.5: Cross-AI Review] {name} ตรวจสอบโค้ดข้ามค่าย...',
    crossReviewFix: '🛠️ [Cross-AI Review] แก้ {count} ไฟล์: {note}',
    verifyStart: '🧪 [Phase 4/4: Verify] {name} เริ่มตรวจ 4 ชั้น (Port {port})...',
    verifyStep1: '1/4 ตรวจ Security Baseline (Secrets & SQL)...',
    verifyStep2: '2/4 รัน PM2 ({pm2Name} บน Port {port})...',
    verifyStep3: '3/4 เทส DB & API ({cmd})...',
    verifyStep4: '4/4 เทส Frontend UI, Assets & Headless Browser...',
    doneMsg:
      '🎉 [เสร็จสมบูรณ์ 4/4] {name}\nPM2: {pm2Name} (online)\n🔗 URL: {url}\n⚡ Load: {load}\n📊 สถิติ: {dur} | Backend AI: {be} | Frontend AI: {fe} | Fix: {fix}\n📐 Docs: architecture.html · api-tester.html · test-report.html · diagram.svg/png · FLOW_DIAGRAM.md · TECHSTACK.txt{pushed}\n📂 Path: {dir}{blocked}',
    blockedHint: '\n\n⚠️ มี {count} คำถามที่ข้ามไว้ (พิมพ์ /questions เพื่อตอบ)',
    verifyFail: '❌ [Phase 4/4: Verify ไม่ผ่าน — รอบแก้ {loop}/{max}]\nLayer: {layer}\nสาเหตุ: {err}\n🔧 ส่งให้ {role} แก้ไข...',
    circuitBreaker: '🛑 [Circuit Breaker — {name}] แก้ครบ {max} รอบแล้วยังไม่ผ่าน ({layer}):\n{err}',
    cbRetry: 'ลองแก้ต่อ (Retry)',
    cbRollback: 'ย้อน Checkpoint + DB (Rollback)',
    cbSkip: 'ข้ามไปก่อน (Skip)',
    cancelled: '🛑 [{name}] ยกเลิกงานแล้ว (พิมพ์ /resume {slug} เพื่อทำต่อทีหลังได้)',
    queued: '📥 รับงานเข้าคิว (#{pos}): {name}',
    langChanged: '🌐 เปลี่ยนภาษาเป็น ไทย (th) แล้ว',
    btnCustom: '✏️ พิมพ์ตอบเอง',
    btnCancel: '❌ ยกเลิกงาน',
    btnSubmit: '✅ ยืนยันคำตอบ (Submit)',
    askCustomPrompt: '✏️ กรุณาพิมพ์คำตอบของคุณส่งมาในแชทได้เลยครับ',
    helpText: [
      'DualLoop Commands:',
      '/new <name> | <concept> — สร้างโปรแกรมใหม่ (ต่อคิวได้)',
      '/new --tpl <tpl> <name> | <concept> — สร้างจาก Template',
      '/templates — ดูรายการ Template',
      '/continue <slug> | <instruction> — ทำต่อจากโปรเจกต์เดิม',
      '/resume <slug> — ทำต่อจากงานที่ค้าง/ยกเลิกไว้',
      '/app <start|stop> <slug> — เปิดหรือหยุดโปรเจกต์รายตัว',
      '/cancel — ยกเลิกงานที่กำลังทำและล้างคิว',
      '/questions — ตอบคำถามที่ข้ามไว้',
      '/status — สถานะโปรเจกต์ + คิว + PM2',
      '/logs <slug> — ดู PM2 logs ล่าสุด',
      '/env <slug> [KEY=VALUE] — ดู/แก้ .env โปรเจกต์ + รีสตาร์ต PM2',
      '/db <slug> — ดูตาราง SQLite + ดาวน์โหลด Backup',
      '/rule <slug> | <rule> — เพิ่มกฎเฉพาะโปรเจกต์ (PROJECT_RULES.md)',
      '/domain <slug> <domain> — สร้าง Nginx/Caddy Reverse Proxy',
      '/tunnel <slug> | /tunnel stop <slug> — เปิด/ปิดลิงก์ HTTPS ชั่วคราว',
      '/health — สรุปสุขภาพระบบ + พื้นที่ Disk + PM2',
      '/model <backend|frontend> [provider] <model-id> — สลับโมเดล/ค่าย',
      '/lang <th|en> — สลับภาษา (ไทย / English)',
      '/export <slug> — ส่งออก .zip หรือขึ้น GitHub',
      '/stats — สรุปเวลาและจำนวนรอบ AI ของแต่ละโปรเจกต์',
      '/update — อัปเดต DualLoop จาก GitHub + รีสตาร์ต PM2',
      '/rollback <slug> — ย้อน Checkpoint + DB Snapshot',
      '/delete <slug> — หยุด PM2 และลบโปรเจกต์',
      '\n*(ส่งรูป UI หรือข้อความเสียงมาในแชทเพื่อสร้างโปรเจกต์ได้ทันที)*'
    ].join('\n')
  },
  en: {
    botReady: 'DualLoop Bot is online (/help)\n🖥️ Dashboard: {url}',
    clarifyStart: '🔎 [Phase 1/4: Clarify] {name}\nAnalyzing concept and preparing spec questions...',
    clarifyDone: '✅ [Phase 1/4 Done] {name}\nLocked SPEC.md, DB_SCHEMA.sql, API_CONTRACT.json ({count} tasks)\n📂 Path: {dir}',
    checkpointDone: '💾 [Phase 2/4: Checkpoint] {name}\nGit: {hash} | DB Snapshot: {dbCount} files',
    buildStep: '⚙️ [Phase 3/4: Build ({idx}/{total})] {name}\nAI: {aiTag}\nTask: {title}',
    skipOnBlock: '⏸️ [Phase 3/4: Skip-on-Block] {name}\n"{title}" needs user decision -> queued question and continuing',
    buildDone: '✔️ [Phase 3/4 Done ({idx}/{total})] {title}\nFiles: {files}\nNote: {note}',
    schemaGuard: '🔄 [Schema Guard] {name} updated Contract/DB -> re-syncing opposite track',
    crossReviewStart: '🔍 [Phase 3.5: Cross-AI Review] {name} reviewing across models...',
    crossReviewFix: '🛠️ [Cross-AI Review] Patched {count} file(s): {note}',
    verifyStart: '🧪 [Phase 4/4: Verify] {name} running 4-layer check (Port {port})...',
    verifyStep1: '1/4 Security Baseline (Secrets & SQLi)...',
    verifyStep2: '2/4 PM2 Runtime ({pm2Name} on Port {port})...',
    verifyStep3: '3/4 DB & API Tests ({cmd})...',
    verifyStep4: '4/4 Frontend UI, Assets & Headless Browser...',
    doneMsg:
      '🎉 [Complete 4/4] {name}\nPM2: {pm2Name} (online)\n🔗 URL: {url}\n⚡ Load: {load}\n📊 Stats: {dur} | Backend AI: {be} | Frontend AI: {fe} | Fix: {fix}\n📐 Docs: architecture.html · api-tester.html · test-report.html · diagram.svg/png · FLOW_DIAGRAM.md · TECHSTACK.txt{pushed}\n📂 Path: {dir}{blocked}',
    blockedHint: '\n\n⚠️ {count} deferred question(s) waiting (send /questions to answer)',
    verifyFail: '❌ [Phase 4/4: Verify Failed — Fix {loop}/{max}]\nLayer: {layer}\nReason: {err}\n🔧 Routing to {role}...',
    circuitBreaker: '🛑 [Circuit Breaker — {name}] Failed after {max} fix attempts ({layer}):\n{err}',
    cbRetry: 'Retry Fix',
    cbRollback: 'Rollback Checkpoint + DB',
    cbSkip: 'Skip for Now',
    cancelled: '🛑 [{name}] Cancelled (send /resume {slug} to continue later)',
    queued: '📥 Queued (#{pos}): {name}',
    langChanged: '🌐 Switched language to English (en)',
    btnCustom: '✏️ Custom Answer',
    btnCancel: '❌ Cancel Job',
    btnSubmit: '✅ Submit',
    askCustomPrompt: '✏️ Please type and send your answer in chat.',
    helpText: [
      'DualLoop Commands:',
      '/new <name> | <concept> — Build new app (queue-safe)',
      '/new --tpl <tpl> <name> | <concept> — Start from template',
      '/templates — List templates',
      '/continue <slug> | <instruction> — Continue existing app',
      '/resume <slug> — Resume paused/interrupted app',
      '/app <start|stop> <slug> — Start or stop specific app',
      '/cancel — Cancel active job & clear queue',
      '/questions — Answer deferred questions',
      '/status — Projects, queue & PM2 status',
      '/logs <slug> — Tail PM2 logs',
      '/env <slug> [KEY=VALUE] — View/update project .env & restart PM2',
      '/db <slug> — Inspect SQLite tables & download backup',
      '/rule <slug> | <rule> — Save project rule (PROJECT_RULES.md)',
      '/domain <slug> <domain> — Generate Nginx/Caddy proxy config',
      '/tunnel <slug> | /tunnel stop <slug> — Open/close HTTPS tunnel',
      '/health — System health, Disk & PM2 summary',
      '/model <backend|frontend> [provider] <model-id> — Switch AI provider/model',
      '/lang <th|en> — Switch language (Thai / English)',
      '/export <slug> — Export .zip or push to GitHub',
      '/stats — Build duration, AI calls & fix stats',
      '/update — Self-update DualLoop via git pull & restart PM2',
      '/rollback <slug> — Reset to last Git checkpoint + DB snapshot',
      '/delete <slug> — Stop PM2 & delete project',
      '\n*(Send a UI photo or voice note directly in chat to start a project!)*'
    ].join('\n')
  }
};

export function normalizeLang(raw) {
  return String(raw || '').toLowerCase().startsWith('en') ? 'en' : 'th';
}

export function t(lang, key, vars = {}) {
  const table = DICT[normalizeLang(lang)] || DICT.th;
  let str = table[key] ?? DICT.th[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return str;
}

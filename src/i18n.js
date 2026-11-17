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
      '⚡ DualLoop (ส่งรูป/เสียงเพื่อสร้างได้เลย)',
      '• /new (หรือ /new ชื่อ คอนเซ็ปต์) — สร้างโปรเจกต์ใหม่',
      '• /continue (หรือ /continue slug คำสั่ง) — ทำต่อจากของเดิม',
      '• /status · /questions · /cancel · /resume <slug>',
      '• /app <start|stop> <slug> · /logs <slug> · /delete <slug>',
      '• /model · /lang <th|en> · /export <slug> · (/help all ดูทั้งหมด)'
    ].join('\n'),
    helpAll: [
      'DualLoop All Commands:',
      '/new <name> | <concept> · /new --tpl <tpl> <name> | <concept> · /templates',
      '/continue <slug> | <instruction> · /resume <slug> · /cancel · /questions',
      '/app <start|stop> <slug> · /status · /logs <slug> · /stats · /health',
      '/env <slug> [KEY=VAL] · /db <slug> · /rule <slug> | <rule>',
      '/domain <slug> <domain> · /tunnel <slug> · /tunnel stop <slug>',
      '/model <backend|frontend> [provider] <model-id> · /lang <th|en>',
      '/export <slug> · /rollback <slug> · /delete <slug> · /update'
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
      '⚡ DualLoop (or send a UI photo / voice note)',
      '• /new (or /new name concept) — New project',
      '• /continue (or /continue slug instruction) — Add feature/fix',
      '• /status · /questions · /cancel · /resume <slug>',
      '• /app <start|stop> <slug> · /logs <slug> · /delete <slug>',
      '• /model · /lang <th|en> · /export <slug> · (/help all for full list)'
    ].join('\n'),
    helpAll: [
      'DualLoop All Commands:',
      '/new <name> | <concept> · /new --tpl <tpl> <name> | <concept> · /templates',
      '/continue <slug> | <instruction> · /resume <slug> · /cancel · /questions',
      '/app <start|stop> <slug> · /status · /logs <slug> · /stats · /health',
      '/env <slug> [KEY=VAL] · /db <slug> · /rule <slug> | <rule>',
      '/domain <slug> <domain> · /tunnel <slug> · /tunnel stop <slug>',
      '/model <backend|frontend> [provider] <model-id> · /lang <th|en>',
      '/export <slug> · /rollback <slug> · /delete <slug> · /update'
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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  appendHistory,
  buildCompressedContext,
  createProjectState,
  ensureMetrics,
  listProjects,
  loadState,
  saveState
} from './state.js';
import { analyzeTelegramMedia, clarifyStep, crossReview, executeTask } from './ai.js';
import {
  allocatePort,
  applyFileChanges,
  autoPushGitOrigin,
  deleteProject,
  exportProjectZip,
  generateDomainProxyConfigs,
  getDiskFreeSummary,
  gitCheckpoint,
  gitRollback,
  inspectProjectDb,
  openTunnel,
  readProjectEnvMasked,
  runCmd,
  snapshotDbs,
  startOrReloadPm2,
  stopProjectPm2,
  updateProjectEnv,
  verifyProject
} from './runner.js';
import { startDashboard } from './dashboard.js';
import { generateProjectDocs } from './docsgen.js';
import { TelegramController } from './telegram.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEMPLATES = {
  'crud-sqlite': [
    { question: 'Tech Stack?', answer: 'Node.js + Express + SQLite (3NF + Foreign Keys) + Vanilla HTML/CSS/JS' },
    { question: 'UI Theme?', answer: 'Clean Light Dashboard' }
  ],
  'auth-app': [
    { question: 'Tech Stack?', answer: 'Node.js + SQLite (users + sessions/JWT + role guards) + HTML/CSS/JS' },
    { question: 'UI Theme?', answer: 'Modern SaaS / Mobile-First' }
  ],
  dashboard: [
    { question: 'Tech Stack?', answer: 'Node.js + SQLite + REST API + Chart/KPI Dashboard HTML/CSS/JS' },
    { question: 'UI Theme?', answer: 'Minimal Dark' }
  ],
  landing: [
    { question: 'Tech Stack?', answer: 'Node.js static + lead-capture SQLite API + Responsive HTML/CSS/JS' },
    { question: 'UI Theme?', answer: 'Modern SaaS / Mobile-First' }
  ]
};

async function checkAiBudget(dir, state, config, askChoice, notify) {
  const m = ensureMetrics(state);
  const limit = state.maxAiCallsOverride || config.maxAiCalls;
  const total = m.aiCalls.backend + m.aiCalls.frontend;
  if (total < limit) return;
  const pick = await askChoice(
    `💰 [Budget Guard — ${state.name}] เรียก AI ครบ ${total}/${limit} ครั้งแล้ว:`,
    ['เพิ่มโควตา +10 ครั้ง', 'พักงานชั่วคราว (Pause)'],
    false,
    { allowCustom: false, allowCancel: false }
  );
  if (pick.includes('Pause')) throw new Error('Cancelled by user');
  state.maxAiCallsOverride = limit + 10;
  saveState(dir, state);
  await notify(`🔓 เพิ่มโควตา AI เป็น ${state.maxAiCallsOverride} ครั้งแล้ว`);
}

function formatDuration(startIso, endIso) {
  const sec = Math.max(1, Math.round((new Date(endIso) - new Date(startIso)) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

function previewUrls(port, config) {
  const local = `http://127.0.0.1:${port}`;
  if (!config.publicHost) return local;
  const pub = config.publicHost.includes('://') ? `${config.publicHost}:${port}` : `http://${config.publicHost}:${port}`;
  return `${local}\n🌐 Public: ${pub}`;
}

function checkAbort(shouldCancel) {
  if (shouldCancel()) throw new Error('Cancelled by user');
}

/**
 * Run one complete clarify -> build (skip-on-block) -> verify/fix loop for a project.
 */
export async function runProjectLoop({
  dir,
  state,
  config,
  notify,
  askChoice,
  sendPhoto = async () => {},
  shouldCancel = () => false
}) {
  try {
    // Phase 1: Clarify (grill-me + ponytail choice-only)
    if (state.phase === 'clarify') {
      await notify(`🔎 [Phase 1/4: Clarify] ${state.name}\nกำลังวิเคราะห์ Concept และวางคำถามสเปก...`);
    }
    while (state.phase === 'clarify') {
      checkAbort(shouldCancel);
      await checkAiBudget(dir, state, config, askChoice, notify);
      ensureMetrics(state).aiCalls.backend += 1;
      const res = await clarifyStep(state, config);
      checkAbort(shouldCancel);

      if (!res.done) {
        const answer = await askChoice(
          `❓ [Phase 1/4: Clarify — ${state.name}]\n${res.question}`,
          res.options,
          Boolean(res.allowMultiple)
        );
        state.clarifyAnswers.push({ question: res.question, answer });
        saveState(dir, state);
        continue;
      }

      const { spec } = res;
      fs.writeFileSync(path.join(dir, 'SPEC.md'), spec.summary || '', 'utf8');
      fs.writeFileSync(path.join(dir, 'DB_SCHEMA.sql'), spec.dbSchema || '', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'API_CONTRACT.json'),
        JSON.stringify(spec.apiContract || {}, null, 2),
        'utf8'
      );

      state.pm2Entry = spec.pm2Entry || 'server.js';
      state.testCommand = spec.testCommand || '';
      state.e2eCommand = spec.e2eCommand || '';
      state.tasks = (spec.tasks || []).map((t) => ({ ...t, status: 'pending' }));
      state.phase = 'build';
      appendHistory(state, 'Spec & contracts locked');
      saveState(dir, state);
      generateProjectDocs(dir, state);
      await notify(
        `✅ [Phase 1/4 เสร็จสิ้น] ${state.name}\n` +
          `ล็อก SPEC.md, DB_SCHEMA.sql, API_CONTRACT.json แล้ว (${state.tasks.length} tasks)\n` +
          `📂 โฟลเดอร์: ${dir}`
      );
    }

    // Phase 2 & 3: Checkpoint + Build (Dual-AI + Skip-on-Block)
    if (state.phase === 'build') {
      checkAbort(shouldCancel);
      const dbCount = snapshotDbs(dir);
      const cp = gitCheckpoint(dir, `checkpoint-${Date.now()}`);
      if (cp.hash) state.lastCheckpoint = cp.hash;
      saveState(dir, state);
      await notify(
        `💾 [Phase 2/4: Checkpoint] ${state.name}\n` +
          `Git: ${cp.hash || 'no-git'} | DB Snapshot: ${dbCount} ไฟล์`
      );

      let guardSynced = false;
      const totalTasks = state.tasks.length;
      while (true) {
        checkAbort(shouldCancel);
        const idx = state.tasks.findIndex((t) => t.status === 'pending');
        if (idx === -1) break;
        const task = state.tasks[idx];
        const isFe = task.role === 'frontend' || task.role === 'gemini';
        const aiTag = isFe
          ? `Frontend (${config.frontendProvider}/${config.frontendModel})`
          : `Backend (${config.backendProvider}/${config.backendModel})`;

        await notify(
          `⚙️ [Phase 3/4: Build (${idx + 1}/${totalTasks})] ${state.name}\n` +
            `AI: ${aiTag}\nงาน: ${task.title}`
        );

        const context = buildCompressedContext(dir, state);
        await checkAiBudget(dir, state, config, askChoice, notify);
        ensureMetrics(state).aiCalls[isFe ? 'frontend' : 'backend'] += 1;
        const res = await executeTask({ task, state, context, config });
        checkAbort(shouldCancel);

        if (res.status === 'blocked') {
          task.status = 'blocked';
          state.blockedQuestions.push({ taskId: task.id, ...res.blockQuestion });
          appendHistory(state, `Blocked task ${task.id}: ${res.blockQuestion?.question}`);
          saveState(dir, state);
          await notify(
            `⏸️ [Phase 3/4: Skip-on-Block] ${state.name}\n` +
              `งาน "${task.title}" ติดรอตัดสินใจ -> เก็บคำถามไว้และข้ามไปทำส่วนอื่นต่อ`
          );
          continue;
        }

        applyFileChanges(dir, res.files, res.deleteFiles);
        for (const cmd of res.setupCommands || []) {
          await notify(`📦 [Phase 3/4: Setup] รันคำสั่ง: ${cmd}`);
          const cmdRes = runCmd(cmd, dir, 120000);
          if (!cmdRes.ok) throw new Error(`Setup command failed (${cmd}): ${cmdRes.output}`);
        }
        if (res.pm2Entry) state.pm2Entry = res.pm2Entry;
        if (res.testCommand) state.testCommand = res.testCommand;
        if (res.e2eCommand) state.e2eCommand = res.e2eCommand;

        const touchedContract = (res.files || []).some((f) =>
          /API_CONTRACT\.json|DB_SCHEMA\.sql/i.test(f.path)
        );
        if (touchedContract && !guardSynced) {
          guardSynced = true;
          let resynced = 0;
          for (const t of state.tasks) {
            if (t.id !== task.id && t.role !== task.role && t.status === 'done') {
              t.status = 'pending';
              resynced++;
            }
          }
          if (resynced) {
            await notify(`🔄 [Schema Guard] ${state.name} แก้ Contract/DB -> สั่งอีกฝั่ง Sync ใหม่`);
          }
        }

        task.status = 'done';
        appendHistory(state, `${task.id}: ${res.note || 'done'}`);
        saveState(dir, state);
        const fileList = (res.files || []).map((f) => f.path).slice(0, 6).join(', ') || '-';
        await notify(
          `✔️ [Phase 3/4 เสร็จ (${idx + 1}/${totalTasks})] ${task.title}\n` +
            `ไฟล์: ${fileList}\nสรุป: ${res.note || 'done'}`
        );
      }

      if (config.enableCrossReview) {
        checkAbort(shouldCancel);
        await notify(`🔍 [Phase 3.5: Cross-AI Review] ${state.name} ตรวจสอบโค้ดข้ามค่าย...`);
        try {
          await checkAiBudget(dir, state, config, askChoice, notify);
          ensureMetrics(state).aiCalls.frontend += 1;
          const rev = await crossReview({ context: buildCompressedContext(dir, state), config });
          if (!rev.ok && rev.fixes?.length) {
            applyFileChanges(dir, rev.fixes);
            await notify(`🛠️ [Cross-AI Review] แก้ ${rev.fixes.length} ไฟล์: ${rev.note || ''}`);
          }
        } catch (err) {
          if (err.message === 'Cancelled by user') throw err;
        }
      }

      state.phase = 'verify';
      state.fixLoops = 0;
      saveState(dir, state);
    }

    // Phase 4: Verify 4-Layer & Fix Loop (PM2 + Security + DB/API + Browser E2E)
    while (state.phase === 'verify') {
      checkAbort(shouldCancel);
      await notify(`🧪 [Phase 4/4: Verify] ${state.name} เริ่มตรวจ 4 ชั้น (Port ${state.port})...`);
      const check = await verifyProject(dir, state, async (stepMsg) => {
        await notify(`🧪 [Phase 4/4] ${stepMsg}`);
      });

      if (check.ok) {
        const m = ensureMetrics(state);
        m.finishedAt = new Date().toISOString();
        state.phase = state.blockedQuestions.length ? 'waiting_decisions' : 'done';
        appendHistory(state, 'Verified & online via PM2');
        saveState(dir, state);
        const docsOut = generateProjectDocs(dir, state, {
          ...(check.report || {}),
          screenshotPath: check.screenshotPath
        });
        const pushed = config.autoPushOrigin ? autoPushGitOrigin(dir, `verified: ${state.slug}`) : { pushed: false };
        const dur = formatDuration(m.startedAt, m.finishedAt);
        const doneMsg =
          `🎉 [เสร็จสมบูรณ์ 4/4] ${state.name}\n` +
          `PM2: ${state.pm2Name} (online)\n` +
          `🔗 URL: ${previewUrls(state.port, config)}\n` +
          `⚡ Load: ${check.report?.load || 'OK'}\n` +
          `📊 สถิติ: ${dur} | Backend AI: ${m.aiCalls.backend} | Frontend AI: ${m.aiCalls.frontend} | Fix: ${m.totalFixLoops}\n` +
          `📐 Docs: architecture.html · api-tester.html · test-report.html · diagram.svg/png · FLOW_DIAGRAM.md · TECHSTACK.txt` +
          (pushed.pushed ? `\n🐙 Git: auto-pushed origin` : '') +
          `\n📂 Path: ${dir}` +
          (state.blockedQuestions.length
            ? `\n\n⚠️ มี ${state.blockedQuestions.length} คำถามที่ข้ามไว้ (พิมพ์ /questions เพื่อตอบ)`
            : '');
        await notify(doneMsg);
        if (check.screenshotPath) {
          await sendPhoto(check.screenshotPath, `📸 ตัวอย่างหน้าเว็บ: ${state.name}`).catch(() => {});
        }
        if (docsOut.pngPath) {
          await sendPhoto(docsOut.pngPath, `🗺️ Architecture Diagram: ${state.name}`).catch(() => {});
        }
        return;
      }

      if (check.screenshotPath) {
        await sendPhoto(check.screenshotPath, `📸 Screenshot ตอนตรวจไม่ผ่าน (${state.name})`).catch(() => {});
      }

      if (state.fixLoops >= config.maxFixLoops) {
        const decision = await askChoice(
          `🛑 [Circuit Breaker — ${state.name}] แก้ครบ ${config.maxFixLoops} รอบแล้วยังไม่ผ่าน (${check.layer}):\n${check.error.slice(0, 400)}`,
          ['ลองแก้ต่อ (Retry)', 'ย้อน Checkpoint + DB (Rollback)', 'ข้ามไปก่อน (Skip)'],
          false
        );

        if (decision.includes('Rollback')) {
          gitRollback(dir, state.lastCheckpoint);
          state.phase = 'paused';
          saveState(dir, state);
          await notify(`⏪ [${state.name}] Rollback โค้ด (${state.lastCheckpoint}) + คืนค่า DB Snapshot แล้ว`);
          return;
        }
        if (decision.includes('Skip')) {
          state.phase = 'paused';
          saveState(dir, state);
          await notify(`⏸️ [${state.name}] พักงานไว้ชั่วคราว`);
          return;
        }
        state.fixLoops = 0;
      }

      state.fixLoops += 1;
      ensureMetrics(state).totalFixLoops += 1;
      saveState(dir, state);
      const targetRole = check.layer === 'frontend' ? 'frontend' : 'backend';
      ensureMetrics(state).aiCalls[targetRole] += 1;
      await notify(
        `❌ [Phase 4/4: Verify ไม่ผ่าน — รอบแก้ ${state.fixLoops}/${config.maxFixLoops}]\n` +
          `Layer: ${check.layer}\nสาเหตุ: ${check.error.slice(0, 350)}\n` +
          `🔧 ส่งให้ ${targetRole.toUpperCase()} แก้ไข...`
      );

      const fixTask = {
        id: `fix-${state.fixLoops}`,
        role: targetRole,
        title: 'Fix verification failure',
        detail: 'Fix root cause of runtime/test/security error without breaking API_CONTRACT.json.'
      };
      const context = buildCompressedContext(dir, state);
      const fixRes = await executeTask({
        task: fixTask,
        state,
        context,
        errorLog: check.error,
        config
      });
      checkAbort(shouldCancel);

      if (fixRes.status === 'ok') {
        applyFileChanges(dir, fixRes.files, fixRes.deleteFiles);
        for (const cmd of fixRes.setupCommands || []) runCmd(cmd, dir, 120000);
        appendHistory(state, `Fix #${state.fixLoops}: ${fixRes.note || 'applied'}`);
        saveState(dir, state);
      }
    }
  } catch (err) {
    if (err.message === 'Cancelled by user') {
      state.phase = 'paused';
      appendHistory(state, 'Cancelled by user');
      saveState(dir, state);
      await notify(`🛑 [${state.name}] ยกเลิกงานแล้ว (พิมพ์ /resume ${state.slug} เพื่อทำต่อทีหลังได้)`);
      return;
    }
    state.phase = 'error';
    appendHistory(state, `Error: ${err.message}`);
    saveState(dir, state);
    await notify(`💥 [${state.name}] Error: ${err.message}`);
  }
}

/**
 * Append a new instruction to an existing project and re-enter build loop.
 */
export async function continueProject(opts) {
  const { dir, state, instruction } = opts;
  state.tasks.push(
    {
      id: `cont-be-${Date.now()}`,
      role: 'backend',
      title: `Backend & DB Migration: ${instruction}`,
      detail: instruction,
      status: 'pending'
    },
    {
      id: `cont-fe-${Date.now()}`,
      role: 'frontend',
      title: `Frontend update: ${instruction}`,
      detail: instruction,
      status: 'pending'
    }
  );
  state.phase = 'build';
  state.fixLoops = 0;
  appendHistory(state, `Continue: ${instruction}`);
  saveState(dir, state);
  return runProjectLoop(opts);
}

async function startDaemon() {
  const config = loadConfig();
  fs.mkdirSync(config.workspacesDir, { recursive: true });

  let running = false;
  let cancelFlag = false;
  const jobQueue = [];
  const tunnels = new Map();
  const mutedWatchdogs = new Set();
  const alertedCrashes = new Set();
  let bot = null;

  const processQueue = async () => {
    if (running || !jobQueue.length) return;
    running = true;
    try {
      while (jobQueue.length) {
        cancelFlag = false;
        const job = jobQueue.shift();
        await job();
      }
    } finally {
      running = false;
      cancelFlag = false;
    }
  };

  const activityFeed = [];
  const feedSubscribers = new Set();
  const broadcast = (payload) => {
    for (const fn of feedSubscribers) fn(payload);
  };
  const pushFeed = (msg) => {
    const item = { ts: new Date().toISOString(), msg: String(msg) };
    activityFeed.push(item);
    if (activityFeed.length > 50) activityFeed.shift();
    broadcast(item);
  };

  const webQuestions = new Map();
  let webQSeq = 0;

  const notify = (m) => {
    pushFeed(m);
    return bot ? bot.send(m) : Promise.resolve(null);
  };
  const sendPhoto = (p, c) => (bot ? bot.sendPhoto(p, c) : Promise.resolve(null));

  const askChoice = (question, options, allowMultiple = false, extra = {}) => {
    const id = `w${++webQSeq}`;
    const { allowCustom = true, allowCancel = true } = extra;
    return new Promise((resolve, reject) => {
      const entry = { id, question, options, allowMultiple, allowCustom, allowCancel, tgQid: null, resolve, reject };
      webQuestions.set(id, entry);
      broadcast({ type: 'question', id });

      if (bot && config.telegramToken && config.telegramChatId) {
        const tg = bot.askChoice(question, options, allowMultiple, extra);
        entry.tgQid = tg.qid;
        tg.promise
          .then((ans) => {
            if (!webQuestions.has(id)) return;
            webQuestions.delete(id);
            broadcast({ type: 'question_resolved', id });
            resolve(ans);
          })
          .catch((err) => {
            if (!webQuestions.has(id)) return;
            webQuestions.delete(id);
            broadcast({ type: 'question_resolved', id });
            reject(err);
          });
      }
    });
  };

  const answerWebQuestion = (id, answer, isCancel = false) => {
    const entry = webQuestions.get(id);
    if (!entry) return false;
    webQuestions.delete(id);
    broadcast({ type: 'question_resolved', id });
    if (entry.tgQid && bot) bot.resolveExternal(entry.tgQid, answer, isCancel);
    if (isCancel) entry.reject(new Error('Cancelled by user'));
    else entry.resolve(answer);
    return true;
  };
  const loopCtx = (dir, state) => ({
    dir,
    state,
    config,
    notify,
    askChoice,
    sendPhoto,
    shouldCancel: () => cancelFlag
  });

  if (config.telegramToken) {
    bot = new TelegramController(config, {
    onMedia: async ({ mediaPath, mimeType, caption }) => {
      try {
        await notify('👁️ กำลังวิเคราะห์รูป/เสียงของคุณ...');
        const extracted = await analyzeTelegramMedia({ mediaPath, mimeType, caption, config });
        const pick = await askChoice(
          `📝 วิเคราะห์ได้:\nชื่อ: ${extracted.name}\nแนวคิด: ${extracted.concept}`,
          ['🚀 สร้างโปรเจกต์ใหม่เลย', '❌ ยกเลิก'],
          false,
          { allowCustom: false, allowCancel: false }
        );
        if (!pick.includes('สร้าง')) return notify('ยกเลิกแล้วครับ');
        const port = await allocatePort(config.workspacesDir, config.basePort);
        const { dir, state } = createProjectState(config.workspacesDir, extracted.name, extracted.concept, port);
        jobQueue.push(() => runProjectLoop(loopCtx(dir, state)));
        processQueue();
      } catch (err) {
        await notify(`❌ วิเคราะห์สื่อไม่สำเร็จ: ${err.message}`);
      } finally {
        try { fs.unlinkSync(mediaPath); } catch {}
      }
    },
    onCommand: async (text) => {
      if (text.startsWith('/start') || text.startsWith('/help')) {
        await notify(
          [
            'DualLoop Commands:',
            '/new <ชื่อ> | <คอนเซ็ปต์> — สร้างโปรแกรมใหม่ (ต่อคิวได้)',
            '/new --tpl <tpl> <ชื่อ> | <คอนเซ็ปต์> — สร้างจาก Template',
            '/templates — ดูรายการ Template',
            '/continue <slug> | <คำสั่งเพิ่มเติม> — ทำต่อจากโปรเจกต์เดิม',
            '/resume <slug> — ทำต่อจากงานที่ค้าง/ยกเลิกไว้',
            '/app <start|stop> <slug> — เปิดหรือหยุดโปรเจกต์รายตัว',
            '/cancel — ยกเลิกงานที่กำลังทำและล้างคิว',
            '/questions — ตอบคำถามที่ข้ามไว้',
            '/status — สถานะโปรเจกต์ + คิว + PM2',
            '/logs <slug> — ดู log ล่าสุด',
            '/env <slug> [KEY=VALUE] — ดู/แก้ .env โปรเจกต์ + รีสตาร์ต PM2',
            '/db <slug> — ดูตาราง SQLite + ดาวน์โหลด Backup',
            '/rule <slug> | <กฎ> — เพิ่มกฎเฉพาะโปรเจกต์ (PROJECT_RULES.md)',
            '/domain <slug> <domain> — สร้าง Nginx/Caddy Reverse Proxy',
            '/tunnel <slug> | /tunnel stop <slug> — เปิด/ปิดลิงก์ HTTPS ชั่วคราว',
            '/health — สรุปสุขภาพระบบ + พื้นที่ Disk + PM2',
            '/model <backend|frontend> [provider] <model-id> — สลับโมเดล/ค่าย',
            '/export <slug> — ส่งออก .zip หรือขึ้น GitHub',
            '/stats — สรุปเวลาและจำนวนรอบ AI ของแต่ละโปรเจกต์',
            '/update — อัปเดต DualLoop จาก GitHub + รีสตาร์ต PM2',
            '/rollback <slug> — ย้อน Checkpoint + DB Snapshot',
            '/delete <slug> — หยุด PM2 และลบโปรเจกต์',
            '\n*(ส่งรูป UI หรือข้อความเสียงมาในแชทเพื่อสร้างโปรเจกต์ได้ทันที)*'
          ].join('\n')
        );
        return;
      }

      if (text.startsWith('/templates')) {
        await notify(`📋 Templates:\n${Object.keys(TEMPLATES).map((k) => `• ${k}`).join('\n')}\nใช้: /new --tpl <name> <app> | <concept>`);
        return;
      }

      if (text.startsWith('/health')) {
        const projects = listProjects(config.workspacesDir);
        const disk = getDiskFreeSummary(config.workspacesDir);
        const pm2 = runCmd('pm2 status --no-color', process.cwd());
        await notify(
          `🩺 System Health\nDisk: ${disk}\nProjects: ${projects.length} | Queue: ${jobQueue.length}\nDashboard: http://127.0.0.1:${config.dashboardPort}\n\n${pm2.output.slice(0, 1200)}`
        );
        return;
      }

      if (text.startsWith('/db')) {
        const slug = text.replace('/db', '').trim();
        const dir = path.join(config.workspacesDir, slug);
        const state = loadState(dir);
        if (!state) return notify(`Not found: ${slug}`);
        const info = await inspectProjectDb(dir);
        if (!info.found) return notify(info.summary);
        await notify(`🗄️ DB (${slug}):\n${info.summary}`);
        const dl = await askChoice(
          `ต้องการดาวน์โหลดไฟล์ Backup (${path.basename(info.dbPath)}) เข้าแชทไหม?`,
          ['📥 ส่งไฟล์ .db', 'ไม่ต้อง'],
          false,
          { allowCustom: false, allowCancel: false }
        );
        if (dl.includes('ส่งไฟล์')) {
          await bot.sendDocument(info.dbPath, path.basename(info.dbPath), `🗄️ DB Backup: ${slug}`, 'application/octet-stream');
        }
        return;
      }

      if (text.startsWith('/rule ')) {
        const raw = text.slice(6).trim();
        const [slug, ...rest] = raw.split('|');
        const dir = path.join(config.workspacesDir, slug.trim());
        const state = loadState(dir);
        const rule = rest.join('|').trim();
        if (!state || !rule) return notify('ใช้: /rule <slug> | <ข้อกำหนดเฉพาะโปรเจกต์>');
        const ruleFile = path.join(dir, 'PROJECT_RULES.md');
        fs.appendFileSync(ruleFile, `- ${rule}\n`, 'utf8');
        await notify(`📜 เพิ่มกฎให้ ${slug} แล้ว:\n${fs.readFileSync(ruleFile, 'utf8')}`);
        return;
      }

      if (text.startsWith('/domain ')) {
        const [, slug, domain] = text.trim().split(/\s+/);
        const dir = path.join(config.workspacesDir, slug || '');
        const state = loadState(dir);
        if (!state || !domain) return notify('ใช้: /domain <slug> <domain.com>');
        const proxy = generateDomainProxyConfigs(dir, state, domain);
        await notify(
          `🌍 สร้าง Reverse Proxy สำหรับ ${proxy.cleanDomain} -> 127.0.0.1:${state.port} แล้ว:\n` +
            `Nginx: ${proxy.nginxPath}\nCaddy: ${proxy.caddyPath}\n\nCaddyfile:\n${proxy.caddy}`
        );
        return;
      }

      if (text.startsWith('/env')) {
        const rest = text.replace('/env', '').trim();
        const [slug, ...kvParts] = rest.split(/\s+/);
        const dir = path.join(config.workspacesDir, slug || '');
        const state = loadState(dir);
        if (!state) return notify('ใช้: /env <slug> [KEY=VALUE]');
        const kv = kvParts.join(' ');
        if (!kv) return notify(`🔐 .env (${slug}):\n${readProjectEnvMasked(dir)}`);
        const eq = kv.indexOf('=');
        if (eq <= 0) return notify('รูปแบบ: /env <slug> KEY=VALUE');
        const res = updateProjectEnv(dir, state, kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
        await notify(res.ok ? `✅ อัปเดต .env และรีสตาร์ต ${state.pm2Name} แล้ว` : res.output);
        return;
      }

      if (text.startsWith('/tunnel')) {
        const arg = text.replace('/tunnel', '').trim();
        if (arg.startsWith('stop ')) {
          const slug = arg.slice(5).trim();
          const proc = tunnels.get(slug);
          if (proc) {
            try { proc.kill(); } catch {}
            tunnels.delete(slug);
            return notify(`🔌 ปิด Tunnel ของ ${slug} แล้ว`);
          }
          return notify(`ไม่พบ Tunnel ของ ${slug}`);
        }
        const dir = path.join(config.workspacesDir, arg);
        const state = loadState(dir);
        if (!state) return notify(`Not found: ${arg}`);
        if (tunnels.has(state.slug)) return notify(`Tunnel ของ ${state.slug} เปิดอยู่แล้ว (/tunnel stop ${state.slug})`);
        try {
          await notify(`🌐 กำลังเปิด Tunnel ให้ ${state.slug} (Port ${state.port})...`);
          const { url, proc } = await openTunnel(state.port);
          tunnels.set(state.slug, proc);
          proc.on('exit', () => tunnels.delete(state.slug));
          await notify(`✅ Public URL (${state.slug}):\n${url}\n(ปิดด้วย /tunnel stop ${state.slug})`);
        } catch {
          await notify('❌ ไม่พบ cloudflared หรือ zrok ในเครื่อง (ติดตั้ง cloudflared ก่อนใช้ /tunnel)');
        }
        return;
      }

      if (text.startsWith('/stats')) {
        const projects = listProjects(config.workspacesDir);
        if (!projects.length) return notify('ยังไม่มีโปรเจกต์ครับ');
        const lines = projects.map(({ state: s }) => {
          const m = ensureMetrics(s);
          const dur = m.finishedAt ? formatDuration(m.startedAt, m.finishedAt) : 'in-progress';
          return `• ${s.slug} (${s.phase}) | ${dur} | BE:${m.aiCalls.backend} FE:${m.aiCalls.frontend} Fix:${m.totalFixLoops}`;
        });
        await notify(`📊 Project Stats:\n${lines.join('\n')}`);
        return;
      }

      if (text.startsWith('/update')) {
        await notify('🔄 กำลังดึงโค้ดล่าสุด (`git pull`)...');
        const pull = runCmd('git pull --ff-only', APP_ROOT, 60000);
        if (!pull.ok) return notify(`❌ git pull failed:\n${pull.output}`);
        if (/Already up to date/i.test(pull.output)) {
          return notify(`✅ เป็นเวอร์ชันล่าสุดอยู่แล้ว\n${pull.output}`);
        }
        await notify(`✅ อัปเดตแล้ว:\n${pull.output}\n⏳ กำลังรีสตาร์ต PM2...`);
        setTimeout(() => runCmd('pm2 restart dualloop --update-env', APP_ROOT), 500);
        return;
      }

      if (text.startsWith('/export')) {
        const slug = text.replace('/export', '').trim();
        const dir = path.join(config.workspacesDir, slug);
        const state = loadState(dir);
        if (!state) return notify(`Not found: ${slug}`);
        const mode = await askChoice(
          `📦 ต้องการส่งออก "${state.name}" แบบไหน?`,
          ['📦 ส่งไฟล์ .zip เข้าแชท', '🐙 สร้าง Private Repo บน GitHub (gh)'],
          false,
          { allowCustom: false, allowCancel: false }
        );
        if (mode.includes('.zip')) {
          const zipPath = exportProjectZip(dir, state.slug);
          try {
            await bot.sendDocument(zipPath, `${state.slug}.zip`, `📦 Export: ${state.name}`);
          } finally {
            try { fs.unlinkSync(zipPath); } catch {}
          }
          return;
        }
        const ghRes = runCmd(`gh repo create ${state.slug} --private --source=. --push`, dir, 60000);
        await notify(ghRes.ok ? `🐙 Push ขึ้น GitHub แล้ว:\n${ghRes.output}` : `❌ GitHub export failed:\n${ghRes.output}`);
        return;
      }

      if (text.startsWith('/cancel')) {
        cancelFlag = true;
        jobQueue.length = 0;
        bot.cancelPending('Cancelled by user');
        await notify('🛑 สั่งยกเลิกงานปัจจุบันและล้างคิวแล้ว');
        return;
      }

      if (text.startsWith('/model ')) {
        const [, roleArg, a, b] = text.trim().split(/\s+/);
        const isBackend = roleArg === 'backend' || roleArg === 'claude';
        const isFrontend = roleArg === 'frontend' || roleArg === 'gemini';
        if ((isBackend || isFrontend) && a) {
          const provider = b ? a.toLowerCase() : null;
          const modelId = b || a;
          if (isBackend) {
            if (provider) config.backendProvider = provider;
            config.backendModel = modelId;
            return notify(`Backend -> ${config.backendProvider} / ${config.backendModel}`);
          }
          if (provider) config.frontendProvider = provider;
          config.frontendModel = modelId;
          return notify(`Frontend -> ${config.frontendProvider} / ${config.frontendModel}`);
        }
        return notify('ใช้: /model <backend|frontend> [provider] <model-id>');
      }

      if (text.startsWith('/status')) {
        const projects = listProjects(config.workspacesDir);
        const list = projects
          .map((p) => `- ${p.state.slug}: ${p.state.phase} (port ${p.state.port})`)
          .join('\n');
        const pm2 = runCmd('pm2 status --no-color', process.cwd());
        await notify(
          `Queue: ${jobQueue.length} waiting | Running: ${running}\n\nProjects:\n${list || '(empty)'}\n\nPM2:\n${pm2.output.slice(0, 1400)}`
        );
        return;
      }

      if (text.startsWith('/logs')) {
        const slug = text.replace('/logs', '').trim();
        const res = runCmd(`pm2 logs dualloop-${slug} --lines 20 --nostream --no-color`, process.cwd());
        await notify(res.output || 'No logs');
        return;
      }

      if (text.startsWith('/rollback')) {
        const slug = text.replace('/rollback', '').trim();
        const dir = path.join(config.workspacesDir, slug);
        const state = loadState(dir);
        if (!state) return notify(`Not found: ${slug}`);
        const res = gitRollback(dir, state.lastCheckpoint);
        await notify(res.ok ? `⏪ Rolled back ${slug} to ${state.lastCheckpoint} (+ DB Snapshot)` : res.output);
        return;
      }

      if (text.startsWith('/delete')) {
        const slug = text.replace('/delete', '').trim();
        const dir = path.join(config.workspacesDir, slug);
        const state = loadState(dir);
        if (!state) return notify(`Not found: ${slug}`);
        const confirm = await askChoice(
          `⚠️ ยืนยันลบโปรเจกต์ "${state.name}" (${dir}) และหยุด PM2?`,
          ['ยืนยันลบ (Delete)', 'ยกเลิก (Cancel)'],
          false,
          { allowCustom: false, allowCancel: false }
        );
        if (!confirm.includes('Delete')) return notify('ยกเลิกการลบแล้ว');
        deleteProject(dir, state);
        await notify(`🗑️ ลบโปรเจกต์ ${slug} และหยุด PM2 แล้ว`);
        return;
      }

      if (text.startsWith('/app ')) {
        const [, action, slug] = text.trim().split(/\s+/);
        const dir = path.join(config.workspacesDir, slug || '');
        const state = loadState(dir);
        if (!state || (action !== 'stop' && action !== 'start')) {
          return notify('ใช้: /app <start|stop> <slug>');
        }
        if (action === 'stop') {
          mutedWatchdogs.add(state.slug);
          const r = stopProjectPm2(dir, state);
          return notify(r.ok ? `⏹️ หยุด ${state.pm2Name} แล้ว` : r.output);
        }
        mutedWatchdogs.delete(state.slug);
        const r = startOrReloadPm2(dir, state);
        return notify(r.ok ? `▶️ เปิด ${state.pm2Name} บน Port ${state.port} แล้ว` : r.output);
      }

      if (text.startsWith('/resume')) {
        const slug = text.replace('/resume', '').trim();
        const dir = path.join(config.workspacesDir, slug);
        const state = loadState(dir);
        if (!state) return notify(`Not found: ${slug}`);
        if (state.phase === 'paused' || state.phase === 'error') {
          const hasPending = state.tasks.some((t) => t.status === 'pending');
          state.phase = !state.tasks.length ? 'clarify' : hasPending ? 'build' : 'verify';
          state.fixLoops = 0;
          saveState(dir, state);
        }
        jobQueue.push(() => runProjectLoop(loopCtx(dir, state)));
        await notify(`▶️ รับงานทำต่อ: ${state.name} (phase: ${state.phase})`);
        processQueue();
        return;
      }

      if (text.startsWith('/questions')) {
        const projects = listProjects(config.workspacesDir).filter(
          (p) => p.state.blockedQuestions.length > 0
        );
        if (!projects.length) return notify('ไม่มีคำถามค้างครับ');
        for (const p of projects) {
          while (p.state.blockedQuestions.length) {
            const q = p.state.blockedQuestions.shift();
            const ans = await askChoice(`[${p.state.name}] ${q.question}`, q.options, q.allowMultiple);
            const task = p.state.tasks.find((t) => t.id === q.taskId);
            if (task) {
              task.detail += `\nUser decision: ${ans}`;
              task.status = 'pending';
            }
          }
          p.state.phase = 'build';
          saveState(p.dir, p.state);
          jobQueue.push(() => runProjectLoop(loopCtx(p.dir, p.state)));
        }
        processQueue();
        return;
      }

      if (text.startsWith('/new ')) {
        let raw = text.slice(5).trim();
        let tplAnswers = [];
        const tplMatch = raw.match(/^--tpl\s+(\S+)\s+([\s\S]+)$/);
        if (tplMatch) {
          const tplName = tplMatch[1].toLowerCase();
          raw = tplMatch[2].trim();
          tplAnswers = TEMPLATES[tplName] || [];
        }
        const [name, ...rest] = raw.split('|');
        const concept = rest.join('|').trim() || name.trim();
        const port = await allocatePort(config.workspacesDir, config.basePort);
        const { dir, state } = createProjectState(config.workspacesDir, name.trim(), concept, port);
        if (tplAnswers.length) {
          state.clarifyAnswers.push(...tplAnswers);
          saveState(dir, state);
        }
        jobQueue.push(() => runProjectLoop(loopCtx(dir, state)));
        if (running || jobQueue.length > 1) {
          await notify(`📥 รับงานเข้าคิว (#${jobQueue.length}): ${state.name}`);
        }
        processQueue();
        return;
      }

      if (text.startsWith('/continue ')) {
        const raw = text.slice(10).trim();
        const [slug, ...rest] = raw.split('|');
        const dir = path.join(config.workspacesDir, slug.trim());
        const state = loadState(dir);
        const instruction = rest.join('|').trim();
        if (!state || !instruction) {
          await notify('รูปแบบ: /continue <slug> | <คำสั่งเพิ่มเติม>');
          return;
        }
        jobQueue.push(() => continueProject({ ...loopCtx(dir, state), instruction }));
        if (running || jobQueue.length > 1) {
          await notify(`📥 รับคำสั่งต่อยอดเข้าคิว (#${jobQueue.length}): ${state.name}`);
        }
        processQueue();
      }
    }
  });
  }

  startDashboard({
    config,
    getQueueInfo: () => ({ queueSize: jobQueue.length, running }),
    getActivityFeed: () => activityFeed,
    getPendingQuestions: () =>
      [...webQuestions.values()].map(({ id, question, options, allowMultiple, allowCustom, allowCancel }) => ({
        id,
        question,
        options,
        allowMultiple,
        allowCustom,
        allowCancel
      })),
    onAnswerQuestion: answerWebQuestion,
    subscribeFeed: (fn) => {
      feedSubscribers.add(fn);
      return () => feedSubscribers.delete(fn);
    },
    onNewProject: async (name, concept) => {
      const port = await allocatePort(config.workspacesDir, config.basePort);
      const { dir, state } = createProjectState(config.workspacesDir, name, concept, port);
      jobQueue.push(() => runProjectLoop(loopCtx(dir, state)));
      processQueue();
      return { dir, state };
    },
    onContinueProject: (slug, instruction) => {
      const dir = path.join(config.workspacesDir, slug);
      const state = loadState(dir);
      if (!state) return null;
      jobQueue.push(() => continueProject({ ...loopCtx(dir, state), instruction }));
      processQueue();
      return { dir, state };
    },
    onResumeProject: (dir, state) => {
      const hasPending = state.tasks.some((t) => t.status === 'pending');
      state.phase = !state.tasks.length ? 'clarify' : hasPending ? 'build' : 'verify';
      state.fixLoops = 0;
      saveState(dir, state);
      jobQueue.push(() => runProjectLoop(loopCtx(dir, state)));
      processQueue();
    },
    onToggleWatchdogMute: (slug, mute) => {
      if (mute) mutedWatchdogs.add(slug);
      else mutedWatchdogs.delete(slug);
    }
  });

  if (bot) {
    console.log('DualLoop Telegram Bot polling started...');
    await bot.send(`DualLoop Bot พร้อมทำงานแล้ว (/help)\n🖥️ Dashboard: http://127.0.0.1:${config.dashboardPort}`);
  } else {
    console.log(`DualLoop Web-only mode running (Dashboard: http://127.0.0.1:${config.dashboardPort})`);
  }

  // Auto-resume interrupted builds/verifications after PM2 restart
  const interrupted = listProjects(config.workspacesDir).filter(
    (p) => p.state.phase === 'build' || p.state.phase === 'verify'
  );
  for (const p of interrupted) {
    await notify(`🔄 พบงานค้างจากรอบก่อน (${p.state.slug}, phase: ${p.state.phase}) -> กำลังทำต่ออัตโนมัติ`);
    jobQueue.push(() => runProjectLoop(loopCtx(p.dir, p.state)));
  }
  if (interrupted.length) processQueue();

  // PM2 Crash Watchdog (every 45s)
  setInterval(async () => {
    if (running) return;
    const jlist = runCmd('pm2 jlist', process.cwd());
    if (!jlist.ok) return;
    let apps = [];
    try { apps = JSON.parse(jlist.output); } catch { return; }

    for (const { dir, state } of listProjects(config.workspacesDir)) {
      if ((state.phase !== 'done' && state.phase !== 'waiting_decisions') || mutedWatchdogs.has(state.slug)) continue;
      const app = apps.find((a) => a.name === state.pm2Name);
      if (app && app.pm2_env?.status !== 'online') {
        if (alertedCrashes.has(state.slug)) continue;
        alertedCrashes.add(state.slug);
        askChoice(
          `🚨 [PM2 Watchdog] "${state.name}" (${state.pm2Name}) หยุดทำงาน (${app.pm2_env?.status})!`,
          ['🔄 Restart PM2', '🔧 ให้ AI วิเคราะห์แก้', '🔇 ปิดแจ้งเตือน'],
          false,
          { allowCustom: false, allowCancel: false }
        )
          .then((pick) => {
            alertedCrashes.delete(state.slug);
            if (pick.includes('Restart')) {
              startOrReloadPm2(dir, state);
              notify(`✅ สั่ง Restart ${state.pm2Name} แล้ว`);
            } else if (pick.includes('AI')) {
              state.phase = 'verify';
              state.fixLoops = 0;
              saveState(dir, state);
              jobQueue.push(() => runProjectLoop(loopCtx(dir, state)));
              processQueue();
            } else {
              mutedWatchdogs.add(state.slug);
            }
          })
          .catch(() => {});
      } else {
        alertedCrashes.delete(state.slug);
      }
    }
  }, 45000);

  // Daily Health & Disk Report (every 24h)
  setInterval(() => {
    const projects = listProjects(config.workspacesDir);
    const disk = getDiskFreeSummary(config.workspacesDir);
    const done = projects.filter((p) => p.state.phase === 'done').length;
    notify(`📆 [Daily Health Report]\nProjects: ${projects.length} (done: ${done})\nDisk: ${disk}`).catch(() => {});
  }, 24 * 60 * 60 * 1000);

  if (bot) await bot.startPolling();
}

const isEntry =
  process.env.DUALLOOP_DAEMON === '1' ||
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) {
  startDaemon().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

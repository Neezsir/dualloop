import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  appendHistory,
  buildCompressedContext,
  createProjectState,
  listProjects,
  loadState,
  saveState
} from './state.js';
import { clarifyStep, executeTask } from './ai.js';
import {
  allocatePort,
  applyFileChanges,
  gitCheckpoint,
  gitRollback,
  runCmd,
  verifyProject
} from './runner.js';
import { TelegramController } from './telegram.js';

/**
 * Run one complete clarify -> build (skip-on-block) -> verify/fix loop for a project.
 */
export async function runProjectLoop({ dir, state, config, notify, askChoice }) {
  try {
    // 1. Clarify phase (grill-me + ponytail choice-only)
    while (state.phase === 'clarify') {
      await notify(`[${state.name}] วิเคราะห์สเปก...`);
      const res = await clarifyStep(state, config);

      if (!res.done) {
        const answer = await askChoice(res.question, res.options, Boolean(res.allowMultiple));
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
      await notify(`[${state.name}] ล็อกสเปกเรียบร้อย (${state.tasks.length} tasks)`);
    }

    // 2. Build phase (Dual-AI + Git Checkpoint + Skip-on-Block)
    if (state.phase === 'build') {
      const cp = gitCheckpoint(dir, `checkpoint-${Date.now()}`);
      if (cp.hash) state.lastCheckpoint = cp.hash;
      saveState(dir, state);

      let guardSynced = false;
      while (true) {
        const task = state.tasks.find((t) => t.status === 'pending');
        if (!task) break;

        await notify(`[${state.name}] ${task.role.toUpperCase()} กำลังทำ: ${task.title}`);
        const context = buildCompressedContext(dir, state);
        const res = await executeTask({ task, state, context, config });

        if (res.status === 'blocked') {
          task.status = 'blocked';
          state.blockedQuestions.push({
            taskId: task.id,
            ...res.blockQuestion
          });
          appendHistory(state, `Blocked task ${task.id}: ${res.blockQuestion?.question}`);
          saveState(dir, state);
          await notify(`[${state.name}] ติดการตัดสินใจใน "${task.title}" -> ข้ามไปทำส่วนอื่นต่อก่อน`);
          continue;
        }

        applyFileChanges(dir, res.files, res.deleteFiles);
        for (const cmd of res.setupCommands || []) {
          const cmdRes = runCmd(cmd, dir, 120000);
          if (!cmdRes.ok) throw new Error(`Setup command failed (${cmd}): ${cmdRes.output}`);
        }
        if (res.pm2Entry) state.pm2Entry = res.pm2Entry;
        if (res.testCommand) state.testCommand = res.testCommand;
        if (res.e2eCommand) state.e2eCommand = res.e2eCommand;

        // Schema Guard: if contract/DB changed, re-sync opposite track once
        const touchedContract = (res.files || []).some((f) =>
          /API_CONTRACT\.json|DB_SCHEMA\.sql/i.test(f.path)
        );
        if (touchedContract && !guardSynced) {
          guardSynced = true;
          for (const t of state.tasks) {
            if (t.id !== task.id && t.role !== task.role && t.status === 'done') {
              t.status = 'pending';
            }
          }
        }

        task.status = 'done';
        appendHistory(state, `${task.id}: ${res.note || 'done'}`);
        saveState(dir, state);
      }

      state.phase = 'verify';
      state.fixLoops = 0;
      saveState(dir, state);
    }

    // 3. Verify & Fix Loop (PM2 + Test + Circuit Breaker)
    while (state.phase === 'verify') {
      await notify(`[${state.name}] รัน PM2 & Test (Port ${state.port})...`);
      const check = await verifyProject(dir, state);
      if (check.ok) {
        state.phase = state.blockedQuestions.length ? 'waiting_decisions' : 'done';
        appendHistory(state, 'Verified & online via PM2');
        saveState(dir, state);
        await notify(
          `[${state.name}] เสร็จสมบูรณ์! รันบน http://127.0.0.1:${state.port} (PM2: ${state.pm2Name})` +
            (state.blockedQuestions.length
              ? `\nมี ${state.blockedQuestions.length} คำถามที่ข้ามไว้ (พิมพ์ /questions เพื่อตอบ)`
              : '')
        );
        return;
      }

      if (state.fixLoops >= config.maxFixLoops) {
        const decision = await askChoice(
          `[${state.name}] แก้บั๊กครบ ${config.maxFixLoops} รอบแล้วยังไม่ผ่าน:\n${check.error.slice(0, 400)}`,
          ['ลองแก้ต่อ (Retry)', 'ย้อน Checkpoint (Rollback)', 'ข้ามไปก่อน (Skip)'],
          false
        );

        if (decision.includes('Rollback')) {
          gitRollback(dir, state.lastCheckpoint);
          state.phase = 'paused';
          saveState(dir, state);
          await notify(`[${state.name}] Rollback กลับ ${state.lastCheckpoint} แล้ว`);
          return;
        }
        if (decision.includes('Skip')) {
          state.phase = 'paused';
          saveState(dir, state);
          await notify(`[${state.name}] พักงานไว้ชั่วคราว`);
          return;
        }
        state.fixLoops = 0;
      }

      state.fixLoops += 1;
      saveState(dir, state);
      await notify(`[${state.name}] พบ Error -> แก้บั๊กรอบที่ ${state.fixLoops}/${config.maxFixLoops}`);

      const targetRole = check.layer === 'frontend' ? 'frontend' : 'backend';
      const fixTask = {
        id: `fix-${state.fixLoops}`,
        role: targetRole,
        title: 'Fix verification failure',
        detail: 'Fix root cause of runtime/test error without breaking API_CONTRACT.json.'
      };
      const context = buildCompressedContext(dir, state);
      const fixRes = await executeTask({
        task: fixTask,
        state,
        context,
        errorLog: check.error,
        config
      });

      if (fixRes.status === 'ok') {
        applyFileChanges(dir, fixRes.files, fixRes.deleteFiles);
        for (const cmd of fixRes.setupCommands || []) runCmd(cmd, dir, 120000);
        appendHistory(state, `Fix #${state.fixLoops}: ${fixRes.note || 'applied'}`);
        saveState(dir, state);
      }
    }
  } catch (err) {
    state.phase = 'error';
    appendHistory(state, `Error: ${err.message}`);
    saveState(dir, state);
    await notify(`[${state.name}] Error: ${err.message}`);
  }
}

/**
 * Append a new instruction to an existing project and re-enter build loop.
 */
export async function continueProject({ dir, state, instruction, config, notify, askChoice }) {
  state.tasks.push(
    {
      id: `cont-be-${Date.now()}`,
      role: 'claude',
      title: `Backend update: ${instruction}`,
      detail: instruction,
      status: 'pending'
    },
    {
      id: `cont-fe-${Date.now()}`,
      role: 'gemini',
      title: `Frontend update: ${instruction}`,
      detail: instruction,
      status: 'pending'
    }
  );
  state.phase = 'build';
  state.fixLoops = 0;
  appendHistory(state, `Continue: ${instruction}`);
  saveState(dir, state);
  return runProjectLoop({ dir, state, config, notify, askChoice });
}

async function startDaemon() {
  const config = loadConfig();
  fs.mkdirSync(config.workspacesDir, { recursive: true });

  if (!config.telegramToken) {
    console.log('DualLoop daemon idle: set TELEGRAM_BOT_TOKEN in .env and `pm2 restart dualloop`, or run `node bin/cli.js run`.');
    setInterval(() => {}, 60000);
    return;
  }

  let busy = false;
  const bot = new TelegramController(config, {
    onCommand: async (text) => {
      const notify = (m) => bot.send(m);
      const askChoice = (q, opts, multi) => bot.askChoice(q, opts, multi);

      if (text.startsWith('/start') || text.startsWith('/help')) {
        await notify(
          [
            'DualLoop Commands:',
            '/new <ชื่อ> | <คอนเซ็ปต์>',
            '/continue <slug> | <คำสั่งเพิ่มเติม>',
            '/questions — ตอบคำถามที่ข้ามไว้',
            '/status — สถานะโปรเจกต์ + PM2',
            '/logs <slug> — ดู log ล่าสุด',
            '/model <backend|frontend> [provider] <model-id> — สลับโมเดล/ค่ายชั่วคราว',
            '/rollback <slug> — ย้อน Checkpoint'
          ].join('\n')
        );
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
        await notify(`Projects:\n${list || '(empty)'}\n\nPM2:\n${pm2.output.slice(0, 1500)}`);
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
        await notify(res.ok ? `Rolled back ${slug} to ${state.lastCheckpoint}` : res.output);
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
          runProjectLoop({ dir: p.dir, state: p.state, config, notify, askChoice });
        }
        return;
      }

      if (busy) {
        await notify('กำลังทำงานอื่นอยู่ รอสักครู่ครับ');
        return;
      }

      if (text.startsWith('/new ')) {
        const raw = text.slice(5).trim();
        const [name, ...rest] = raw.split('|');
        const concept = rest.join('|').trim() || name.trim();
        const port = allocatePort(config.workspacesDir, config.basePort);
        const { dir, state } = createProjectState(config.workspacesDir, name.trim(), concept, port);
        busy = true;
        runProjectLoop({ dir, state, config, notify, askChoice }).finally(() => {
          busy = false;
        });
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
        busy = true;
        continueProject({ dir, state, instruction, config, notify, askChoice }).finally(() => {
          busy = false;
        });
      }
    }
  });

  console.log('DualLoop Telegram Bot polling started...');
  await bot.send('DualLoop Bot พร้อมทำงานแล้ว (/help)');
  await bot.startPolling();
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

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createProjectState, loadState } from '../src/state.js';
import { allocatePort, runCmd } from '../src/runner.js';
import { continueProject, runProjectLoop } from '../src/orchestrator.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKILL_TARGETS = {
  agents: '.agents/skills/dualloop/SKILL.md',
  antigravity: '.gemini/antigravity/skills/dualloop/SKILL.md',
  claude: '.claude/skills/dualloop/SKILL.md'
};

function installSkills(target = 'all') {
  const src = path.join(PKG_ROOT, 'skills', 'dualloop', 'SKILL.md');
  const keys = target === 'all' ? Object.keys(SKILL_TARGETS) : [target];
  for (const k of keys) {
    const rel = SKILL_TARGETS[k];
    if (!rel) continue;
    const dest = path.resolve(process.cwd(), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`Installed skill -> ${rel}`);
  }
}

async function askText(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function askCliChoice(question, options, allowMultiple = false) {
  if (!process.stdin.isTTY) {
    console.log(`\n? ${question}`);
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
    const raw = (await askText('เลือกหมายเลข: ')).trim();
    const picks = raw.split(',').map((s) => options[Number(s.trim()) - 1]).filter(Boolean);
    return picks.length ? picks.join(', ') : options[0];
  }

  let cursor = 0;
  const selected = new Set();
  const linesCount = options.length + 1;

  const draw = (first) => {
    if (!first) process.stdout.write(`\x1b[${linesCount}A\r\x1b[J`);
    const hint = allowMultiple ? '(↑/↓ เลื่อน, Space ติ๊ก, Enter ยืนยัน)' : '(↑/↓ เลื่อน, Enter เลือก)';
    process.stdout.write(`\x1b[36m?\x1b[0m \x1b[1m${question}\x1b[0m \x1b[90m${hint}\x1b[0m\n`);
    options.forEach((opt, i) => {
      const active = i === cursor;
      const pointer = active ? '\x1b[36m❯\x1b[0m' : ' ';
      const box = allowMultiple ? (selected.has(i) ? '\x1b[32m[✓]\x1b[0m ' : '[ ] ') : '';
      const label = active ? `\x1b[36m${opt}\x1b[0m` : opt;
      process.stdout.write(`  ${pointer} ${box}${label}\n`);
    });
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?25l');
  draw(true);

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
    };

    const onKey = (_, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        process.exit(0);
      }
      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + options.length) % options.length;
        return draw(false);
      }
      if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % options.length;
        return draw(false);
      }
      if (allowMultiple && key.name === 'space') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        return draw(false);
      }
      if (key.name === 'return' || key.name === 'enter') {
        const answer = allowMultiple
          ? ([...selected].sort((a, b) => a - b).map((i) => options[i]).join(', ') || options[cursor])
          : options[cursor];
        process.stdout.write(`\x1b[${linesCount}A\r\x1b[J`);
        process.stdout.write(`\x1b[32m✓\x1b[0m ${question} \x1b[36m${answer}\x1b[0m\n`);
        cleanup();
        resolve(answer);
      }
    };

    process.stdin.on('keypress', onKey);
  });
}

async function pickModel(label, choices) {
  const picked = await askCliChoice(label, [...choices, 'กำหนดเอง (Custom)'], false);
  if (!picked.startsWith('กำหนดเอง')) return picked;
  return (await askText('ระบุ Model ID: ')).trim() || choices[0];
}

async function runInit(onlySkill = false) {
  console.log('\x1b[1m=== DualLoop Setup ===\x1b[0m');

  const skillTarget = await askCliChoice(
    '1) ต้องการติดตั้ง SKILL.md ลงโฟลเดอร์ใด?',
    ['all', 'antigravity', 'claude', 'agents', 'skip'],
    false
  );
  if (skillTarget !== 'skip') installSkills(skillTarget);

  if (onlySkill) {
    const configToo = await askCliChoice(
      'ต้องการตั้งค่าเลือก Model AI และโหมดสลับอัตโนมัติ (.env) ด้วยไหม?',
      ['Yes', 'No (ติดตั้งเฉพาะ Skill)'],
      false
    );
    if (configToo !== 'Yes') return;
  }

  const claudeModePick = await askCliChoice(
    '2) เลือกโหมด Claude (Backend/DB/Test):',
    ['cli (Claude Team/Pro - ไม่เสียค่า API)', 'api (ใช้ ANTHROPIC_API_KEY)'],
    false
  );
  const claudeMode = claudeModePick.startsWith('api') ? 'api' : 'cli';
  const claudeModel = await pickModel('3) เลือกรุ่น Claude:', [
    'claude-opus-5-5',
    'claude-sonnet-4-20250514'
  ]);

  const geminiModePick = await askCliChoice(
    '4) เลือกโหมด Gemini (Frontend):',
    ['agy (Google AI Ultra - ไม่เสียค่า API)', 'cli (gemini CLI)', 'api (Google AI Studio)'],
    false
  );
  const geminiMode = geminiModePick.split(' ')[0];
  const geminiModel = await pickModel('5) เลือกรุ่น Gemini:', [
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'gemini-3.8-flash'
  ]);

  const fallbackPick = await askCliChoice(
    '6) โหมดสลับ AI อัตโนมัติ (Auto-Fallback) เมื่อตัวหลักติด/หมดโควตา:',
    ['เปิด (แนะนำ: สลับ CLI <-> API อัตโนมัติ)', 'ปิด (ใช้เฉพาะโหมดที่เลือก)'],
    false
  );
  const autoFallback = fallbackPick.startsWith('เปิด');

  const claudeKey =
    claudeMode === 'api' || autoFallback
      ? await askText('ANTHROPIC_API_KEY (เว้นว่างถ้าใช้เฉพาะ CLI): ')
      : '';
  const geminiKey =
    geminiMode === 'api' || autoFallback
      ? await askText('GEMINI_API_KEY (เว้นว่างถ้าใช้เฉพาะ agy/CLI): ')
      : '';

  const tgToken = await askText('TELEGRAM_BOT_TOKEN (เว้นว่างถ้าไม่ใช้ Telegram): ');
  const tgChat = tgToken.trim() ? await askText('TELEGRAM_CHAT_ID (เว้นว่างแล้วทักบอทเพื่อเอาทีหลังได้): ') : '';

  const envContent = [
    `CLAUDE_MODE=${claudeMode}`,
    `ANTHROPIC_API_KEY=${claudeKey.trim()}`,
    `CLAUDE_MODEL=${claudeModel}`,
    `GEMINI_MODE=${geminiMode}`,
    `GEMINI_API_KEY=${geminiKey.trim()}`,
    `GEMINI_MODEL=${geminiModel}`,
    `TELEGRAM_BOT_TOKEN=${tgToken.trim()}`,
    `TELEGRAM_CHAT_ID=${tgChat.trim()}`,
    `WORKSPACES_DIR=~/Desktop`,
    `BASE_PORT=4100`,
    `MAX_FIX_LOOPS=4`,
    `PONYTAIL_LEVEL=full`,
    `AUTO_FALLBACK=${autoFallback}`
  ].join('\n');

  fs.writeFileSync(path.resolve(process.cwd(), '.env'), envContent + '\n', 'utf8');
  console.log('\x1b[32m✓\x1b[0m Created .env');

  const startPm2 = await askCliChoice('7) เริ่มรัน Daemon ด้วย PM2 เลยไหม?', ['Yes', 'No'], false);
  if (startPm2 === 'Yes') {
    const res = runCmd(`pm2 start "${path.join(PKG_ROOT, 'ecosystem.config.cjs')}"`, process.cwd());
    console.log(res.output);
  }
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (cmd === '--help' || cmd === '-h') {
    console.log(
      [
        'dualloop CLI',
        '  dualloop                                ติดตั้ง Skill + เลือก Model AI ทีละขั้นตอน',
        '  dualloop init                           ตั้งค่าเต็มรูปแบบ (.env + Skill + PM2)',
        '  dualloop install-skill [all|antigravity|claude|agents]',
        '  dualloop run "<name>" "<concept>"       เริ่มสร้างโปรแกรม 1 ลูปเต็ม',
        '  dualloop continue <slug> "<instruction>" สั่งต่อยอดโปรเจกต์เดิม',
        '  dualloop start                          รัน Telegram Daemon ผ่าน PM2'
      ].join('\n')
    );
    return;
  }

  if (!cmd) return runInit(true);
  if (cmd === 'init') return runInit(false);
  if (cmd === 'install-skill') return args[0] ? installSkills(args[0]) : runInit(true);
  if (cmd === 'start') {
    const res = runCmd(`pm2 start "${path.join(PKG_ROOT, 'ecosystem.config.cjs')}"`, process.cwd());
    console.log(res.output);
    return;
  }

  const config = loadConfig();
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  const notify = async (m) => console.log(m);
  const askChoice = (q, opts, multi) => askCliChoice(q, opts, multi);

  if (cmd === 'run') {
    const name = args[0] || (await askText('ชื่อโปรแกรม: '));
    const concept = args.slice(1).join(' ') || (await askText('อธิบาย Concept: '));
    const port = allocatePort(config.workspacesDir, config.basePort);
    const { dir, state } = createProjectState(config.workspacesDir, name, concept, port);
    await runProjectLoop({ dir, state, config, notify, askChoice });
    return;
  }

  if (cmd === 'continue') {
    const slug = args[0];
    const instruction = args.slice(1).join(' ');
    const dir = path.join(config.workspacesDir, slug || '');
    const state = loadState(dir);
    if (!state || !instruction) {
      console.error('Usage: dualloop continue <slug> "<instruction>"');
      process.exit(1);
    }
    await continueProject({ dir, state, instruction, config, notify, askChoice });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createProjectState, loadState } from '../src/state.js';
import { allocatePort, findBrowserBinary, runCmd } from '../src/runner.js';
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

  emitKeypressEvents(process.stdin);
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

const PROVIDER_MODELS = {
  'claude-cli': ['claude-opus-5-5', 'claude-sonnet-4-20250514'],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-4-20250514'],
  agy: ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash'],
  'gemini-cli': ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash'],
  gemini: ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash'],
  'codex-cli': ['gpt-5-codex', 'o3'],
  openai: ['gpt-5', 'o3', 'gpt-4o'],
  openrouter: ['anthropic/claude-opus-5-5', 'google/gemini-4-hydrogen', 'deepseek/deepseek-r1'],
  ollama: ['qwen2.5-coder:14b', 'llama3.3', 'deepseek-r1'],
  custom: ['deepseek-chat', 'grok-3']
};

const PROVIDER_OPTIONS = [
  'claude-cli (Claude Team/Pro - ไม่เสียค่า API)',
  'agy (Google AI Ultra - ไม่เสียค่า API)',
  'gemini-cli (Gemini CLI)',
  'codex-cli (OpenAI Codex CLI)',
  'anthropic (Anthropic API Key)',
  'gemini (Google AI Studio API Key)',
  'openai (OpenAI API Key)',
  'openrouter (OpenRouter - ใช้ได้ทุกค่ายใน 1 คีย์)',
  'ollama (Local ฟรี ออฟไลน์)',
  'custom (OpenAI-Compatible URL: DeepSeek/Groq/vLLM)'
];

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

  const bePick = await askCliChoice('2) เลือก AI ฝั่ง Backend / DB / Test:', PROVIDER_OPTIONS, false);
  const backendProvider = bePick.split(' ')[0];
  const backendModel = await pickModel(
    `3) เลือกรุ่น Backend (${backendProvider}):`,
    PROVIDER_MODELS[backendProvider] || ['custom']
  );

  const feDefaults = [PROVIDER_OPTIONS[1], ...PROVIDER_OPTIONS.filter((_, i) => i !== 1)];
  const fePick = await askCliChoice('4) เลือก AI ฝั่ง Frontend UI:', feDefaults, false);
  const frontendProvider = fePick.split(' ')[0];
  const frontendModel = await pickModel(
    `5) เลือกรุ่น Frontend (${frontendProvider}):`,
    PROVIDER_MODELS[frontendProvider] || ['custom']
  );

  const fallbackPick = await askCliChoice(
    '6) โหมดสลับ AI อัตโนมัติ (Auto-Fallback) เมื่อตัวหลักติด/หมดโควตา:',
    ['เปิด (แนะนำ: สลับ CLI <-> API อัตโนมัติ)', 'ปิด (ใช้เฉพาะโหมดที่เลือก)'],
    false
  );
  const autoFallback = fallbackPick.startsWith('เปิด');

  const used = new Set([backendProvider, frontendProvider]);
  const anthropicKey = used.has('anthropic') ? await askText('ANTHROPIC_API_KEY: ') : '';
  const geminiKey = used.has('gemini') ? await askText('GEMINI_API_KEY: ') : '';
  const openaiKey = used.has('openai') ? await askText('OPENAI_API_KEY: ') : '';
  const openrouterKey = used.has('openrouter') ? await askText('OPENROUTER_API_KEY: ') : '';
  const ollamaUrl = used.has('ollama')
    ? (await askText('OLLAMA_BASE_URL (Enter = http://127.0.0.1:11434/v1): ')).trim() ||
      'http://127.0.0.1:11434/v1'
    : 'http://127.0.0.1:11434/v1';
  const customUrl = used.has('custom') ? await askText('CUSTOM_BASE_URL (e.g. https://api.deepseek.com/v1): ') : '';
  const customKey = used.has('custom') ? await askText('CUSTOM_API_KEY: ') : '';

  const useTelegram = await askCliChoice(
    '7) ต้องการเปิดใช้บอทสั่งงานผ่าน Telegram ด้วยไหม?',
    ['No (ใช้เฉพาะ IDE / Terminal)', 'Yes (ตั้งค่า Telegram Bot + PM2)'],
    false
  );

  let tgToken = '';
  let tgChat = '';
  if (useTelegram.startsWith('Yes')) {
    tgToken = await askText('TELEGRAM_BOT_TOKEN: ');
    tgChat = tgToken.trim() ? await askText('TELEGRAM_CHAT_ID (เว้นว่างแล้วทักบอทเพื่อเอาทีหลังได้): ') : '';
  }

  const envContent = [
    `BACKEND_PROVIDER=${backendProvider}`,
    `BACKEND_MODEL=${backendModel}`,
    `FRONTEND_PROVIDER=${frontendProvider}`,
    `FRONTEND_MODEL=${frontendModel}`,
    `ANTHROPIC_API_KEY=${anthropicKey.trim()}`,
    `GEMINI_API_KEY=${geminiKey.trim()}`,
    `OPENAI_API_KEY=${openaiKey.trim()}`,
    `OPENAI_BASE_URL=https://api.openai.com/v1`,
    `OPENROUTER_API_KEY=${openrouterKey.trim()}`,
    `OLLAMA_BASE_URL=${ollamaUrl}`,
    `CUSTOM_BASE_URL=${customUrl.trim()}`,
    `CUSTOM_API_KEY=${customKey.trim()}`,
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

  if (useTelegram.startsWith('Yes') && tgToken.trim()) {
    const startPm2 = await askCliChoice('8) เริ่มรัน Telegram Daemon ด้วย PM2 เลยไหม?', ['Yes', 'No'], false);
    if (startPm2 === 'Yes') {
      const res = runCmd(`pm2 start "${path.join(PKG_ROOT, 'ecosystem.config.cjs')}"`, process.cwd());
      runCmd('pm2 save', process.cwd());
      console.log(res.output);
    }
  }
}

function runDoctor() {
  const cfg = loadConfig();
  const has = (cmd) => runCmd(cmd, process.cwd()).ok;
  const browser = findBrowserBinary();
  const rows = [
    ['Node.js', process.version, true],
    ['PM2', has('pm2 -v') ? 'installed' : 'missing (npm i -g pm2)', has('pm2 -v')],
    ['Git', has('git --version') ? 'installed' : 'missing (checkpoint disabled)', has('git --version')],
    ['Backend AI', `${cfg.backendProvider} / ${cfg.backendModel}`, true],
    ['Frontend AI', `${cfg.frontendProvider} / ${cfg.frontendModel}`, true],
    ['Auto-Fallback', String(cfg.autoFallback), true],
    ['Headless Browser', browser || 'not found (HTML/asset smoke only)', Boolean(browser)],
    ['Telegram Bot', cfg.telegramToken ? (cfg.telegramChatId ? 'configured' : 'missing TELEGRAM_CHAT_ID') : 'disabled', Boolean(cfg.telegramToken)]
  ];
  console.log('\n=== DualLoop Doctor ===');
  for (const [k, v, ok] of rows) {
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[33m!\x1b[0m'} ${k.padEnd(17)}: ${v}`);
  }
  console.log('\nTip (24/7 server): run `pm2 startup` then `pm2 save` to auto-boot services.');
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (cmd === '--help' || cmd === '-h') {
    console.log(
      [
        'dualloop CLI',
        '  dualloop                                ติดตั้ง Skill + เลือก Model AI ทีละขั้นตอน',
        '  dualloop init                           ตั้งค่าเต็มรูปแบบ (.env + Skill + PM2)',
        '  dualloop doctor                         เช็กความพร้อมเครื่อง (PM2, Git, AI, Browser, Telegram)',
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
  if (cmd === 'doctor') return runDoctor();
  if (cmd === 'install-skill') return args[0] ? installSkills(args[0]) : runInit(true);
  if (cmd === 'start') {
    const res = runCmd(`pm2 start "${path.join(PKG_ROOT, 'ecosystem.config.cjs')}"`, process.cwd());
    runCmd('pm2 save', process.cwd());
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
    const port = await allocatePort(config.workspacesDir, config.basePort);
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

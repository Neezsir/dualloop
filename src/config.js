import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveWorkspacesDir(raw) {
  const val = raw || '~/Desktop';
  if (val === '~') return os.homedir();
  if (val.startsWith('~/') || val.startsWith('~\\')) {
    return path.join(os.homedir(), val.slice(2));
  }
  return path.resolve(process.cwd(), val);
}

/**
 * Parse a .env file into process.env without overriding existing variables.
 * @param {string} envPath
 */
export function loadEnvFile(envPath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/**
 * Return normalized runtime configuration.
 */
export function loadConfig() {
  loadEnvFile();
  return {
    claudeMode: (process.env.CLAUDE_MODE || 'cli').toLowerCase(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    geminiMode: (process.env.GEMINI_MODE || 'agy').toLowerCase(),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    workspacesDir: resolveWorkspacesDir(process.env.WORKSPACES_DIR),
    basePort: Number(process.env.BASE_PORT || 4100),
    maxFixLoops: Number(process.env.MAX_FIX_LOOPS || 4),
    ponytailLevel: process.env.PONYTAIL_LEVEL || 'full',
    autoFallback: process.env.AUTO_FALLBACK !== 'false'
  };
}

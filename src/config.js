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

function mapLegacyMode(mode, kind) {
  const m = (mode || '').toLowerCase();
  if (kind === 'backend') {
    if (m === 'cli') return 'claude-cli';
    if (m === 'api') return 'anthropic';
    return m || 'claude-cli';
  }
  if (m === 'cli') return 'gemini-cli';
  if (m === 'api') return 'gemini';
  return m || 'agy';
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
 * Return normalized runtime configuration supporting all AI providers & models.
 */
export function loadConfig() {
  loadEnvFile();
  return {
    backendProvider: (
      process.env.BACKEND_PROVIDER || mapLegacyMode(process.env.CLAUDE_MODE || 'cli', 'backend')
    ).toLowerCase(),
    backendModel: process.env.BACKEND_MODEL || process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    frontendProvider: (
      process.env.FRONTEND_PROVIDER || mapLegacyMode(process.env.GEMINI_MODE || 'agy', 'frontend')
    ).toLowerCase(),
    frontendModel: process.env.FRONTEND_MODEL || process.env.GEMINI_MODEL || 'gemini-4-hydrogen',

    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    customBaseUrl: process.env.CUSTOM_BASE_URL || '',
    customApiKey: process.env.CUSTOM_API_KEY || '',

    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    workspacesDir: resolveWorkspacesDir(process.env.WORKSPACES_DIR),
    publicHost: (process.env.PUBLIC_HOST || '').replace(/\/+$/, ''),
    dashboardPort: Number(process.env.DASHBOARD_PORT || 4099),
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    basePort: Number(process.env.BASE_PORT || 4100),
    maxFixLoops: Number(process.env.MAX_FIX_LOOPS || 4),
    maxAiCalls: Number(process.env.MAX_AI_CALLS || 20),
    enableCrossReview: process.env.ENABLE_CROSS_REVIEW !== 'false',
    autoPushOrigin: process.env.AUTO_PUSH_ORIGIN !== 'false',
    cliTimeoutMs: Number(process.env.CLI_TIMEOUT_MS || 180000),
    ponytailLevel: process.env.PONYTAIL_LEVEL || 'full',
    autoFallback: process.env.AUTO_FALLBACK !== 'false'
  };
}

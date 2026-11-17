import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function ponytailDirective(level) {
  return [
    `PONYTAIL MODE (${level}):`,
    '- Simplest, shortest working code. Stdlib/native features first.',
    '- Tech stack preference: Node.js, Python, HTML, CSS, JS. Service must run cleanly via PM2 on process.env.PORT.',
    '- No boilerplate, no speculative abstractions, no long prose.',
    '- Always respond with valid JSON matching the exact schema requested.'
  ].join('\n');
}

const RELATIONAL_DB_RULES = [
  'RELATIONAL DATABASE & MIGRATION RULES (STRICT):',
  '- Proper 3NF relational schema: every table MUST have an explicit PRIMARY KEY.',
  '- Enforce relationships with FOREIGN KEY (...) REFERENCES ... ON DELETE CASCADE/RESTRICT.',
  '- For SQLite: always execute PRAGMA foreign_keys = ON; on every DB connection.',
  '- Add NOT NULL, UNIQUE, CHECK constraints and CREATE INDEX on all foreign key & lookup columns.',
  '- Never store relational arrays/lists as comma-separated strings or unvalidated JSON blobs when a join/child table belongs.',
  '- MIGRATION GUARD: When modifying an existing DB/project, NEVER DROP existing tables or wipe user data; add idempotent ALTER TABLE / migration steps checking column/table existence first.'
].join('\n');

/**
 * Extract the first JSON object from an LLM response (fenced or raw).
 */
export function extractJson(text) {
  const cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Model did not return JSON:\n${cleaned.slice(0, 400)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function resolveBin(bin) {
  if (bin === 'agy' && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const localAgy = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(localAgy)) return localAgy;
  }
  return bin;
}

function runCli(bin, args, promptText, timeoutMs = 180000) {
  const res = spawnSync(resolveBin(bin), args, {
    input: promptText,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32',
    maxBuffer: 10 * 1024 * 1024
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      throw new Error(`${bin} CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`${bin} CLI failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${bin} CLI error: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

async function callAnthropic(prompt, system, model, config) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(data)}`);
  return data.content?.map((b) => b.text || '').join('\n') || '';
}

async function callGeminiApi(prompt, system, model, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${JSON.stringify(data)}`);
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
}

async function callOpenAICompat({ baseUrl, apiKey, model, prompt, system }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI-compat API ${res.status}: ${JSON.stringify(data)}`);
  return data.choices?.[0]?.message?.content || '';
}

const PROVIDERS = {
  'claude-cli': {
    ready: () => true,
    run: (prompt, system, model, c) =>
      runCli('claude', model ? ['-p', '--output-format', 'text', '--model', model] : ['-p', '--output-format', 'text'], `${system}\n\n${prompt}`, c.cliTimeoutMs)
  },
  anthropic: {
    ready: (c) => Boolean(c.anthropicApiKey),
    run: callAnthropic
  },
  agy: {
    ready: () => true,
    run: (prompt, system, model, c) =>
      runCli('agy', model ? ['--model', model, '-p', 'Follow the prompt from stdin.'] : ['-p', 'Follow the prompt from stdin.'], `${system}\n\n${prompt}`, c.cliTimeoutMs)
  },
  'gemini-cli': {
    ready: () => true,
    run: (prompt, system, model, c) =>
      runCli('gemini', model ? ['-m', model, '-p', 'Follow the prompt from stdin.'] : ['-p', 'Follow the prompt from stdin.'], `${system}\n\n${prompt}`, c.cliTimeoutMs)
  },
  gemini: {
    ready: (c) => Boolean(c.geminiApiKey),
    run: callGeminiApi
  },
  'codex-cli': {
    ready: () => true,
    run: (prompt, system, model, c) =>
      runCli('codex', model ? ['exec', '-m', model, '-'] : ['exec', '-'], `${system}\n\n${prompt}`, c.cliTimeoutMs)
  },
  openai: {
    ready: (c) => Boolean(c.openaiApiKey),
    run: (prompt, system, model, c) =>
      callOpenAICompat({ baseUrl: c.openaiBaseUrl, apiKey: c.openaiApiKey, model, prompt, system })
  },
  openrouter: {
    ready: (c) => Boolean(c.openrouterApiKey),
    run: (prompt, system, model, c) =>
      callOpenAICompat({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: c.openrouterApiKey, model, prompt, system })
  },
  ollama: {
    ready: (c) => Boolean(c.ollamaBaseUrl),
    run: (prompt, system, model, c) =>
      callOpenAICompat({ baseUrl: c.ollamaBaseUrl, apiKey: 'ollama', model, prompt, system })
  },
  custom: {
    ready: (c) => Boolean(c.customBaseUrl),
    run: (prompt, system, model, c) =>
      callOpenAICompat({ baseUrl: c.customBaseUrl, apiKey: c.customApiKey, model, prompt, system })
  }
};

/**
 * Dispatch prompt to any configured AI provider with optional auto-fallback.
 */
async function callRole(role, prompt, system, config) {
  const isFrontend = role === 'frontend' || role === 'gemini';
  const primary = isFrontend ? config.frontendProvider : config.backendProvider;
  const model = isFrontend ? config.frontendModel : config.backendModel;

  const fallbackOrder = isFrontend
    ? [primary, 'agy', 'gemini-cli', 'gemini', 'openrouter', 'openai', 'custom']
    : [primary, 'claude-cli', 'anthropic', 'codex-cli', 'openrouter', 'openai', 'custom'];

  const order = (config.autoFallback ? fallbackOrder : [primary]).filter(
    (v, i, a) => v && PROVIDERS[v] && a.indexOf(v) === i
  );

  let lastErr;
  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider.ready(config)) {
      if (name === primary) {
        lastErr = new Error(`Provider "${name}" missing required API key or URL in .env`);
      }
      continue;
    }
    try {
      return await provider.run(prompt, system, model, config);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`No provider available for ${role}`);
}

/**
 * Grill-me clarification step: returns clickable options only, or final Spec + Contract + Tasks.
 */
export async function clarifyStep(state, config) {
  const system = `${ponytailDirective(config.ponytailLevel)}
${RELATIONAL_DB_RULES}
You are the System Architect running a strict choice-only grill-me interview.
Ask ONLY concise questions with 2-4 clickable options (in the user's language) until Tech Stack, Relational DB tables/FKs, Core Flow, and UI Theme Preset (e.g. Clean Light Dashboard, Minimal Dark, Mobile-First SaaS, Dense Admin) are clear.
Limit to at most 4 questions total before finalizing.`;

  const prompt = `
Project: ${state.name}
Concept: ${state.concept}
Answers so far:
${state.clarifyAnswers.map((a, i) => `${i + 1}. Q: ${a.question} -> A: ${a.answer}`).join('\n') || '(none)'}

Return JSON ONLY in one of these 2 forms:
Form A (still clarifying):
{
  "done": false,
  "question": "Short question?",
  "options": ["Option 1 (Recommended)", "Option 2", "Option 3"],
  "allowMultiple": false
}

Form B (ready to build):
{
  "done": true,
  "spec": {
    "summary": "Short SPEC markdown",
    "dbSchema": "-- 3NF relational SQL schema with PKs, FKs, ON DELETE, NOT NULL, CHECK, and indexes",
    "apiContract": { "baseUrl": "http://127.0.0.1:${state.port}", "endpoints": [] },
    "pm2Entry": "server.js",
    "testCommand": "node test.js",
    "e2eCommand": "",
    "tasks": [
      { "id": "db-backend", "role": "backend", "title": "Build DB, backend API & tests", "detail": "..." },
      { "id": "frontend-ui", "role": "frontend", "title": "Build HTML/CSS/JS frontend matching API_CONTRACT.json", "detail": "..." }
    ]
  }
}`;

  const raw = await callRole('backend', prompt, system, config);
  return extractJson(raw);
}

/**
 * Execute a build or bug-fix task using configured Backend or Frontend AI provider.
 */
export async function executeTask({ task, state, context, errorLog, config }) {
  const isFrontend = task.role === 'frontend' || task.role === 'gemini';
  const roleDesc = isFrontend
    ? [
        'You are the Frontend Engineer. Build clean, responsive HTML/CSS/JS UI strictly matching API_CONTRACT.json and served by the backend or static dir.',
        'Ensure zero runtime JS exceptions, zero console.error logs, graceful error handling on failed fetches, and real interactive DOM rendering.',
        'If the UI has interactive forms/CRUD, also create a runnable e2e.test.js (set e2eCommand: "node e2e.test.js") verifying form submission -> API -> DB persistence -> reload.'
      ].join('\n')
    : [
        'You are the Backend/DB/Process/Test Engineer. Build Node.js/Python backend, strict relational DB setup, process entrypoint listening on process.env.PORT, and an automated full-stack test script (test.js).',
        RELATIONAL_DB_RULES,
        'AUTO SEED DATA: Include an idempotent seed step (or auto-seed when tables are empty) inserting realistic sample records respecting all Foreign Keys so the UI shows live data immediately.',
        'SECURITY BASELINE: Always use parameterized SQL queries (? / $1), never hardcode API keys/secrets in source code, never return password/secret fields in API JSON responses, and enforce auth guards on protected routes.',
        'Your testCommand (e.g. node test.js) MUST start cleanly against the live server or isolated test DB and verify: (1) DB schema & Foreign Key constraint rejection, (2) API CRUD round-trips matching API_CONTRACT.json, and (3) invalid-input 4xx validation.'
      ].join('\n');

  const system = `${ponytailDirective(config.ponytailLevel)}
${roleDesc}
If an essential product decision or external secret is missing and cannot be defaulted, return status "blocked" with a short choice question so the orchestrator can skip to other tasks.`;

  const prompt = `
Current Task: [${task.id}] ${task.title}
Detail: ${task.detail}
${errorLog ? `\nPREVIOUS VERIFICATION ERROR (fix root cause):\n${errorLog}\n` : ''}
Project Context:
${context}

Return JSON ONLY:
{
  "status": "ok" | "blocked",
  "note": "1-line summary",
  "files": [{ "path": "relative/path.js", "content": "full file content" }],
  "deleteFiles": [],
  "setupCommands": ["npm install ... (only if strictly needed)"],
  "pm2Entry": "server.js",
  "testCommand": "node test.js",
  "e2eCommand": "",
  "blockQuestion": {
    "question": "Short decision?",
    "options": ["Option A", "Option B"],
    "allowMultiple": false
  }
}`;

  const raw = await callRole(isFrontend ? 'frontend' : 'backend', prompt, system, config);
  return extractJson(raw);
}

/**
 * Cross-AI review: opposite AI inspects project contracts & key files before verification.
 */
export async function crossReview({ context, config }) {
  const system = `${ponytailDirective(config.ponytailLevel)}
You are the Cross-AI Reviewer. Check API_CONTRACT.json vs frontend/backend integration, SQL FK integrity, security, and obvious bugs. Only suggest minimal surgical file fixes if a real bug exists.`;

  const prompt = `
Review this project snapshot:
${context}

Return JSON ONLY:
{
  "ok": true | false,
  "note": "1-line finding",
  "fixes": [{ "path": "relative/path.js", "content": "full updated file content" }]
}`;

  const raw = await callRole('frontend', prompt, system, config);
  return extractJson(raw);
}

/**
 * Analyze a Telegram photo (UI sketch) or voice note into an actionable app name & concept.
 */
export async function analyzeTelegramMedia({ mediaPath, mimeType, caption, config }) {
  const instruction = `Extract a concise software project specification from this ${mimeType.startsWith('audio') ? 'voice request' : 'UI/diagram image'}${caption ? ` (caption: "${caption}")` : ''}.
Return JSON ONLY: { "name": "short-slug-name", "concept": "concise Thai/English description of features & UI" }`;

  if (config.geminiApiKey && (config.frontendProvider === 'gemini' || config.autoFallback)) {
    const b64 = fs.readFileSync(mediaPath).toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.frontendModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: instruction }, { inlineData: { mimeType, data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    const data = await res.json();
    if (res.ok) {
      const txt = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
      return extractJson(txt);
    }
  }

  const raw = await callRole(
    'frontend',
    `${instruction}\nMedia file saved locally at: ${mediaPath}`,
    ponytailDirective(config.ponytailLevel),
    config
  );
  return extractJson(raw);
}

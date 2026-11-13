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

function runCli(bin, args, promptText) {
  const res = spawnSync(resolveBin(bin), args, {
    input: promptText,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 10 * 1024 * 1024
  });
  if (res.error) throw new Error(`${bin} CLI failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${bin} CLI error: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

async function callClaudeApi(prompt, system, config) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${JSON.stringify(data)}`);
  return data.content?.map((b) => b.text || '').join('\n') || '';
}

async function callClaude(prompt, system, config) {
  const fullPrompt = `${system}\n\n${prompt}`;
  if (config.claudeMode === 'cli') {
    try {
      const args = ['-p', '--output-format', 'text'];
      if (config.claudeModel) args.push('--model', config.claudeModel);
      return runCli('claude', args, fullPrompt);
    } catch (err) {
      if (!config.autoFallback || !config.anthropicApiKey) throw err;
    }
  }
  if (!config.anthropicApiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY in .env (or login via `claude`)');
  }
  return callClaudeApi(prompt, system, config);
}

async function callGeminiApi(prompt, system, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
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

async function callGemini(prompt, system, config) {
  const fullPrompt = `${system}\n\n${prompt}`;
  const candidates = config.autoFallback ? [config.geminiMode, 'agy', 'cli', 'api'] : [config.geminiMode];
  const order = candidates.filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr;

  for (const mode of order) {
    try {
      if (mode === 'agy') {
        const args = ['-p', 'Follow the prompt from stdin.'];
        if (config.geminiModel) args.unshift('--model', config.geminiModel);
        return runCli('agy', args, fullPrompt);
      }
      if (mode === 'cli') {
        const args = ['-p', 'Follow the prompt from stdin.'];
        if (config.geminiModel) args.unshift('-m', config.geminiModel);
        return runCli('gemini', args, fullPrompt);
      }
      if (mode === 'api' && config.geminiApiKey) {
        return await callGeminiApi(prompt, system, config);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No Gemini provider succeeded (install agy/gemini CLI or set GEMINI_API_KEY)');
}

/**
 * Grill-me clarification step: returns clickable options only, or final Spec + Contract + Tasks.
 */
export async function clarifyStep(state, config) {
  const system = `${ponytailDirective(config.ponytailLevel)}
You are the System Architect running a strict choice-only grill-me interview.
Ask ONLY concise questions with 2-4 clickable options (in the user's language) until Tech Stack, DB, Core Flow, and UI style are clear.
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
    "dbSchema": "-- SQL schema or JSON schema",
    "apiContract": { "baseUrl": "http://127.0.0.1:${state.port}", "endpoints": [] },
    "pm2Entry": "server.js",
    "testCommand": "node test.js",
    "tasks": [
      { "id": "db-backend", "role": "claude", "title": "Build DB, backend API & tests", "detail": "..." },
      { "id": "frontend-ui", "role": "gemini", "title": "Build HTML/CSS/JS frontend matching API_CONTRACT.json", "detail": "..." }
    ]
  }
}`;

  const raw = await callClaude(prompt, system, config);
  return extractJson(raw);
}

/**
 * Execute a build or bug-fix task using Claude (Backend/DB/Process/Test) or Gemini (Frontend).
 */
export async function executeTask({ task, state, context, errorLog, config }) {
  const isFrontend = task.role === 'gemini';
  const roleDesc = isFrontend
    ? 'You are the Frontend Engineer (Gemini). Build clean, responsive HTML/CSS/JS UI strictly matching API_CONTRACT.json and served by the backend or static dir.'
    : 'You are the Backend/DB/Process/Test Engineer (Claude). Build Node.js/Python backend, DB setup, process entrypoint listening on process.env.PORT, and an automated smoke/API test script.';

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
  "blockQuestion": {
    "question": "Short decision?",
    "options": ["Option A", "Option B"],
    "allowMultiple": false
  }
}`;

  const raw = isFrontend
    ? await callGemini(prompt, system, config)
    : await callClaude(prompt, system, config);

  return extractJson(raw);
}

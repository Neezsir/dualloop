import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = 'STATE.json';

export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9ก-๙_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `app-${Date.now()}`;
}

/**
 * Initialize a new project workspace and persist STATE.json.
 */
export function createProjectState(workspacesDir, name, concept, port) {
  const slug = slugify(name);
  const dir = path.join(workspacesDir, slug);
  fs.mkdirSync(dir, { recursive: true });

  const state = {
    name,
    slug,
    concept,
    phase: 'clarify',
    port,
    pm2Name: `dualloop-${slug}`,
    pm2Entry: 'server.js',
    testCommand: '',
    clarifyAnswers: [],
    spec: null,
    tasks: [],
    blockedQuestions: [],
    fixLoops: 0,
    lastCheckpoint: null,
    metrics: {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      aiCalls: { backend: 0, frontend: 0 },
      totalFixLoops: 0
    },
    history: [],
    updatedAt: new Date().toISOString()
  };

  saveState(dir, state);
  return { dir, state };
}

export function ensureMetrics(state) {
  if (!state.metrics) {
    state.metrics = {
      startedAt: state.updatedAt || new Date().toISOString(),
      finishedAt: null,
      aiCalls: { backend: 0, frontend: 0 },
      totalFixLoops: state.fixLoops || 0
    };
  }
  return state.metrics;
}

export function loadState(dir) {
  const file = path.join(dir, STATE_FILE);
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  ensureMetrics(state);
  return state;
}

export function saveState(dir, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

export function appendHistory(state, entry) {
  state.history.push(`[${new Date().toISOString()}] ${entry}`);
  if (state.history.length > 25) {
    state.history = state.history.slice(-25);
  }
}

export function listProjects(workspacesDir) {
  if (!fs.existsSync(workspacesDir)) return [];
  return fs
    .readdirSync(workspacesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(workspacesDir, d.name);
      const state = loadState(dir);
      return state ? { dir, state } : null;
    })
    .filter(Boolean);
}

/**
 * Build a token-compact project snapshot instead of replaying chat logs.
 */
export function buildCompressedContext(dir, state) {
  const files = listFilesCompact(dir);
  const contract = readIfExists(path.join(dir, 'API_CONTRACT.json'), 4000);
  const schema = readIfExists(path.join(dir, 'DB_SCHEMA.sql'), 3000);
  const spec = readIfExists(path.join(dir, 'SPEC.md'), 3000);

  return [
    `Project: ${state.name} | Port: ${state.port} | Phase: ${state.phase}`,
    `Concept: ${state.concept}`,
    spec ? `SPEC:\n${spec}` : '',
    schema ? `DB_SCHEMA:\n${schema}` : '',
    contract ? `API_CONTRACT:\n${contract}` : '',
    `Files:\n${files.join('\n') || '(empty)'}`,
    state.history.length ? `Recent:\n${state.history.slice(-6).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}

function readIfExists(filePath, maxChars) {
  if (!fs.existsSync(filePath)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...(truncated)' : text;
}

function listFilesCompact(dir, prefix = '', acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      listFilesCompact(path.join(dir, entry.name), rel, acc);
    } else {
      acc.push(rel);
    }
    if (acc.length >= 80) break;
  }
  return acc;
}

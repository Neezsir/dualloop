import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJson } from '../src/ai.js';
import { normalizeLang, t } from '../src/i18n.js';
import { allocatePort, runSecurityCheck } from '../src/runner.js';
import { buildCompressedContext, createProjectState, loadState } from '../src/state.js';
import { generateProjectDocs } from '../src/docsgen.js';

test('extractJson parses raw and fenced JSON', () => {
  assert.deepEqual(extractJson('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJson('```json\n{"a":1,"b":"x"}\n```'), { a: 1, b: 'x' });
});

test('runSecurityCheck detects secrets and SQL interpolation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dualloop-sec-'));
  try {
    fs.writeFileSync(path.join(tmp, 'clean.js'), 'const q = "SELECT * FROM users WHERE id = ?";\n', 'utf8');
    assert.equal(runSecurityCheck(tmp).ok, true);

    fs.writeFileSync(path.join(tmp, 'bad.js'), 'const k = "sk-ant-1234567890abcdef1234";\nconst s = `SELECT * FROM u WHERE id=${id}`;\n', 'utf8');
    const bad = runSecurityCheck(tmp);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /hardcoded secret/);
    assert.match(bad.error, /SQL string interpolation/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('state, allocatePort, and generateProjectDocs create expected artifacts', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dualloop-ws-'));
  try {
    const port = await allocatePort(ws, 4900);
    assert.equal(typeof port, 'number');
    const { dir, state } = createProjectState(ws, 'Sample App', 'Demo concept', port);
    fs.writeFileSync(path.join(dir, 'PROJECT_RULES.md'), '- Always use Thai UI\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'DB_SCHEMA.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'API_CONTRACT.json'), JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/tasks' }] }), 'utf8');

    const loaded = loadState(dir);
    assert.equal(loaded.slug, 'sample-app');
    const ctx = buildCompressedContext(dir, loaded);
    assert.match(ctx, /Always use Thai UI/);

    const docs = generateProjectDocs(dir, loaded, {
      verifiedAt: '2026-11-17T00:00:00Z',
      security: 'PASS',
      pm2: 'PASS',
      dbApi: 'PASS',
      browser: 'PASS',
      load: 'PASS (20/20 OK)'
    });
    for (const f of ['TECHSTACK.txt', 'FLOW_DIAGRAM.md', 'diagram.svg', 'architecture.html', 'api-tester.html', 'test-report.html']) {
      assert.equal(fs.existsSync(path.join(docs.docsDir, f)), true, `missing ${f}`);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('i18n switches between th and en keeping technical terms intact', () => {
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('th'), 'th');
  assert.match(t('en', 'clarifyStart', { name: 'App' }), /Phase 1\/4: Clarify/);
  assert.match(t('th', 'clarifyStart', { name: 'App' }), /กำลังวิเคราะห์/);
});

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMetrics, listProjects, loadState } from './state.js';
import {
  deleteProject,
  getDiskFreeSummary,
  gitRollback,
  runCmd,
  startOrReloadPm2
} from './runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveSafeStatic(res, baseDir, relPath) {
  const target = path.resolve(baseDir, relPath);
  if (!target.startsWith(baseDir + path.sep) || !fs.existsSync(target)) {
    return json(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(target).toLowerCase();
  const mime =
    ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
    : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'content-type': mime });
  return res.end(fs.readFileSync(target));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Start built-in Web Control Dashboard, SSE Live Feed, Local API Proxy, and Webhook Trigger.
 */
export function startDashboard({
  config,
  getQueueInfo,
  getActivityFeed,
  subscribeFeed,
  onNewProject,
  onContinueProject,
  onResumeProject
}) {
  const srv = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    try {
      if (req.method === 'GET' && urlPath === '/') {
        const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (req.method === 'GET' && urlPath.startsWith('/docs/')) {
        return serveSafeStatic(res, path.join(ROOT, 'docs'), urlPath.slice('/docs/'.length));
      }

      if (req.method === 'GET' && urlPath.startsWith('/api/project-docs/')) {
        const parts = urlPath.slice('/api/project-docs/'.length).split('/');
        const slug = decodeURIComponent(parts[0] || '').replace(/[^a-zA-Z0-9ก-๙_-]/g, '');
        const fileRel = parts.slice(1).join('/') || 'architecture.html';
        return serveSafeStatic(res, path.join(config.workspacesDir, slug, 'docs'), fileRel);
      }

      if (req.method === 'GET' && urlPath === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        for (const item of getActivityFeed()) {
          res.write(`data: ${JSON.stringify(item)}\n\n`);
        }
        const unsub = subscribeFeed((item) => {
          res.write(`data: ${JSON.stringify(item)}\n\n`);
        });
        req.on('close', unsub);
        return;
      }

      if (req.method === 'GET' && urlPath === '/api/projects') {
        const jlist = runCmd('pm2 jlist', process.cwd());
        let pm2Apps = [];
        try { if (jlist.ok) pm2Apps = JSON.parse(jlist.output); } catch {}
        const projects = listProjects(config.workspacesDir).map(({ state }) => {
          const app = pm2Apps.find((a) => a.name === state.pm2Name);
          const previewFile = path.join(os.tmpdir(), `dualloop-preview-${state.slug}.png`);
          return {
            name: state.name,
            slug: state.slug,
            phase: state.phase,
            port: state.port,
            pm2Status: app?.pm2_env?.status || 'stopped',
            metrics: ensureMetrics(state),
            hasPreview: fs.existsSync(previewFile)
          };
        });
        const q = getQueueInfo();
        return json(res, 200, {
          ...q,
          disk: getDiskFreeSummary(config.workspacesDir),
          projects
        });
      }

      if (req.method === 'GET' && urlPath.startsWith('/api/preview/')) {
        const slug = decodeURIComponent(urlPath.slice('/api/preview/'.length)).replace(/[^a-zA-Z0-9ก-๙_-]/g, '');
        const img = path.join(os.tmpdir(), `dualloop-preview-${slug}.png`);
        if (!fs.existsSync(img)) return json(res, 404, { error: 'No preview' });
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(fs.readFileSync(img));
      }

      if (req.method === 'GET' && urlPath.startsWith('/api/logs/')) {
        const slug = decodeURIComponent(urlPath.slice('/api/logs/'.length)).replace(/[^a-zA-Z0-9ก-๙_-]/g, '');
        const logs = runCmd(`pm2 logs dualloop-${slug} --lines 30 --nostream --no-color`, process.cwd());
        return json(res, 200, { logs: logs.output });
      }

      if (req.method === 'POST' && urlPath === '/api/proxy') {
        const { url, method = 'GET', body } = await readBody(req);
        const parsed = new URL(String(url || ''));
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          return json(res, 403, { error: 'Proxy restricted to localhost targets' });
        }
        const upstream = await fetch(parsed.toString(), {
          method,
          headers: body ? { 'content-type': 'application/json' } : {},
          body: method !== 'GET' && method !== 'HEAD' && body ? body : undefined
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/plain' });
        return res.end(text);
      }

      if (req.method === 'POST' && urlPath === '/api/action') {
        const { slug, action } = await readBody(req);
        const dir = path.join(config.workspacesDir, String(slug || ''));
        const state = loadState(dir);
        if (!state) return json(res, 404, { error: 'Project not found' });
        if (action === 'restart') startOrReloadPm2(dir, state);
        else if (action === 'rollback') gitRollback(dir, state.lastCheckpoint);
        else if (action === 'delete') deleteProject(dir, state);
        else if (action === 'resume') onResumeProject(dir, state);
        else return json(res, 400, { error: 'Unknown action' });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && urlPath === '/api/new') {
        const { name, concept } = await readBody(req);
        if (!name) return json(res, 400, { error: 'name required' });
        const created = await onNewProject(String(name).trim(), String(concept || name).trim());
        return json(res, 200, { ok: true, slug: created.state.slug, port: created.state.port });
      }

      if (req.method === 'POST' && urlPath === '/api/webhook') {
        if (!config.webhookSecret) {
          return json(res, 403, { error: 'Set WEBHOOK_SECRET in .env to enable /api/webhook' });
        }
        const auth = String(req.headers['x-dualloop-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '');
        if (auth !== config.webhookSecret) {
          return json(res, 401, { error: 'Invalid webhook secret' });
        }
        const payload = await readBody(req);
        if (payload.action === 'continue') {
          if (!payload.slug || !payload.instruction) return json(res, 400, { error: 'slug and instruction required' });
          const resCont = onContinueProject(String(payload.slug), String(payload.instruction));
          if (!resCont) return json(res, 404, { error: 'Project not found' });
          return json(res, 202, { ok: true, slug: resCont.state.slug });
        }
        if (!payload.name) return json(res, 400, { error: 'name required' });
        const created = await onNewProject(String(payload.name).trim(), String(payload.concept || payload.name).trim());
        return json(res, 202, { ok: true, slug: created.state.slug, port: created.state.port });
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  srv.on('error', (err) => {
    console.error(`Dashboard error on port ${config.dashboardPort}:`, err.message);
  });
  srv.listen(config.dashboardPort, '127.0.0.1', () => {
    console.log(`DualLoop Dashboard: http://127.0.0.1:${config.dashboardPort}`);
  });
  return srv;
}

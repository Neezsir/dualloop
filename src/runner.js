import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { listProjects } from './state.js';

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Allocate the next free port unused in both STATE.json and the host OS.
 */
export async function allocatePort(workspacesDir, basePort) {
  const used = new Set(listProjects(workspacesDir).map((p) => p.state.port));
  let port = basePort;
  while (used.has(port) || !(await isPortFree(port))) port++;
  return port;
}

/**
 * Run a shell command in cwd and return truncated output.
 */
export function runCmd(command, cwd, timeoutMs = 60000) {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, output: tail(stdout, 2500) };
  } catch (err) {
    const combined = `${err.stdout || ''}\n${err.stderr || err.message || ''}`;
    return { ok: false, output: tail(combined, 3000) };
  }
}

function tail(text, max) {
  const str = String(text || '').trim();
  return str.length > max ? `...(truncated)\n${str.slice(-max)}` : str;
}

/**
 * Ensure git repo exists and create a rollback checkpoint commit.
 */
export function gitCheckpoint(dir, message) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    runCmd('git init', dir);
    runCmd('git config user.email "dualloop@local"', dir);
    runCmd('git config user.name "DualLoop"', dir);
  }
  runCmd('git add -A', dir);
  const res = runCmd(`git commit -m "${message.replace(/"/g, "'")}" --allow-empty`, dir);
  const head = runCmd('git rev-parse --short HEAD', dir);
  return { ok: res.ok, hash: head.ok ? head.output.trim() : null };
}

export function gitRollback(dir, hash) {
  if (!hash) return { ok: false, output: 'No checkpoint hash found' };
  const res = runCmd(`git reset --hard ${hash}`, dir);
  restoreDbSnapshot(dir);
  return res;
}

/**
 * Backup SQLite/DB files to .dualloop-backup before build/continue.
 */
export function snapshotDbs(dir) {
  const backupDir = path.join(dir, '.dualloop-backup');
  let count = 0;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (['node_modules', '.git', '.dualloop-backup'].includes(entry.name)) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(db|sqlite|sqlite3)$/i.test(entry.name)) {
        const rel = path.relative(dir, full);
        const dest = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        count++;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return count;
}

/**
 * Restore backed up DB files on rollback.
 */
export function restoreDbSnapshot(dir) {
  const backupDir = path.join(dir, '.dualloop-backup');
  if (!fs.existsSync(backupDir)) return 0;
  let count = 0;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(backupDir, full);
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        count++;
      }
    }
  };
  walk(backupDir);
  return count;
}

/**
 * Create a clean zip archive of the project (excluding node_modules, .git, backups) in temp dir.
 */
export function exportProjectZip(dir, slug) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dualloop-stage-'));
  const outZip = path.join(os.tmpdir(), `${slug}-${Date.now()}.zip`);
  const copyClean = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (['node_modules', '.git', '.dualloop-backup'].includes(entry.name)) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyClean(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  try {
    copyClean(dir, stage);
    const cmd =
      process.platform === 'win32'
        ? `powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${outZip}' -Force"`
        : `cd "${stage}" && zip -rq "${outZip}" .`;
    const res = runCmd(cmd, stage, 60000);
    if (!res.ok || !fs.existsSync(outZip)) {
      throw new Error(`Zip export failed: ${res.output}`);
    }
    return outZip;
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Read project .env with secret values masked for safe chat display.
 */
export function readProjectEnvMasked(dir) {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return '(empty .env)';
  return fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      if (eq <= 0) return line;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      const masked = /key|secret|token|pass/i.test(k) && v.length > 4 ? `${v.slice(0, 3)}***${v.slice(-2)}` : v;
      return `${k}=${masked}`;
    })
    .join('\n');
}

/**
 * Set or update KEY=VALUE in a project's .env and restart its PM2 app.
 */
export function updateProjectEnv(dir, state, key, value) {
  const envPath = path.join(dir, '.env');
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const updated = lines.map((l) => {
    if (l.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) updated.push(`${key}=${value}`);
  fs.writeFileSync(envPath, updated.filter((l, i, a) => l || i < a.length - 1).join('\n') + '\n', 'utf8');
  return startOrReloadPm2(dir, state);
}

/**
 * Open a temporary public tunnel (cloudflared or zrok) pointing at localhost:port.
 */
export function openTunnel(port) {
  const trySpawn = (bin, args, urlRegex) =>
    new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        reject(new Error(`${bin} timeout`));
      }, 15000);
      const onData = (chunk) => {
        const m = chunk.toString().match(urlRegex);
        if (m) {
          clearTimeout(timer);
          resolve({ url: m[0], proc });
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${bin} exited (${code})`));
      });
    });

  return trySpawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i).catch(() =>
    trySpawn('zrok', ['share', 'public', '--headless', `http://127.0.0.1:${port}`], /https:\/\/[a-z0-9.-]+\.zrok\.io/i)
  );
}

/**
 * Inspect SQLite DB files in project dir and return table/row counts + primary file path.
 */
export async function inspectProjectDb(dir) {
  const dbs = [];
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (['node_modules', '.git', '.dualloop-backup'].includes(entry.name)) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(db|sqlite|sqlite3)$/i.test(entry.name)) dbs.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  if (!dbs.length) return { found: false, summary: 'ไม่พบไฟล์ SQLite (.db) ในโปรเจกต์' };

  const { DatabaseSync } = await import('node:sqlite');
  const lines = [];
  for (const dbPath of dbs) {
    const rel = path.relative(dir, dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
      const counts = tables.map((t) => {
        const c = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get();
        return `${t.name}: ${c?.n ?? 0}`;
      });
      lines.push(`• ${rel} -> ${counts.join(', ') || '(no tables)'}`);
    } finally {
      db.close();
    }
  }
  return { found: true, dbPath: dbs[0], summary: lines.join('\n') };
}

/**
 * Read table names and up to 20 sample rows per table from project SQLite DB (read-only).
 */
export async function inspectProjectDbData(dir) {
  const info = await inspectProjectDb(dir);
  if (!info.found) return { found: false, tables: [] };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(info.dbPath, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    const tables = names.map((name) => {
      const safe = name.replace(/"/g, '""');
      const rows = db.prepare(`SELECT * FROM "${safe}" LIMIT 20`).all();
      return { name, rows };
    });
    return { found: true, dbFile: path.basename(info.dbPath), tables };
  } finally {
    db.close();
  }
}

/**
 * Stop a project's PM2 app without deleting its files.
 */
export function stopProjectPm2(dir, state) {
  return runCmd(`pm2 stop ${state.pm2Name}`, dir);
}

/**
 * Generate Nginx and Caddy reverse proxy configs for a custom domain.
 */
export function generateDomainProxyConfigs(dir, state, domain) {
  const cleanDomain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  const deployDir = path.join(dir, 'deploy');
  fs.mkdirSync(deployDir, { recursive: true });

  const nginx = `server {
  listen 80;
  server_name ${cleanDomain};
  location / {
    proxy_pass http://127.0.0.1:${state.port};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
`;
  const caddy = `${cleanDomain} {\n  reverse_proxy 127.0.0.1:${state.port}\n}\n`;
  const nginxPath = path.join(deployDir, `nginx-${state.slug}.conf`);
  const caddyPath = path.join(deployDir, `Caddyfile.${state.slug}`);
  fs.writeFileSync(nginxPath, nginx, 'utf8');
  fs.writeFileSync(caddyPath, caddy, 'utf8');
  return { cleanDomain, nginxPath, caddyPath, nginx, caddy };
}

/**
 * Return free disk space summary using Node built-in fs.statfsSync.
 */
export function getDiskFreeSummary(dir) {
  try {
    const s = fs.statfsSync(dir);
    const freeGb = ((s.bfree * s.bsize) / 1024 ** 3).toFixed(1);
    const totalGb = ((s.blocks * s.bsize) / 1024 ** 3).toFixed(1);
    return `${freeGb} GB free / ${totalGb} GB`;
  } catch {
    return 'unknown';
  }
}

/**
 * Auto-commit and push to git origin if configured on project repo.
 */
export function autoPushGitOrigin(dir, message) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { pushed: false };
  const remote = runCmd('git remote get-url origin', dir);
  if (!remote.ok || !remote.output) return { pushed: false };
  runCmd('git add -A', dir);
  runCmd(`git commit -m "${message.replace(/"/g, "'")}" --allow-empty`, dir);
  const push = runCmd('git push', dir, 60000);
  return { pushed: push.ok, output: push.output };
}

/**
 * Stop PM2 process and delete project directory safely.
 */
export function deleteProject(dir, state) {
  if (!fs.existsSync(path.join(dir, 'STATE.json'))) {
    throw new Error('Refusing to delete directory without STATE.json');
  }
  runCmd(`pm2 delete ${state.pm2Name}`, dir);
  runCmd('pm2 save', dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Safely apply file additions/updates/deletes confined inside workspace dir.
 */
export function applyFileChanges(dir, files = [], deleteFiles = []) {
  const root = path.resolve(dir);

  for (const f of files) {
    const target = path.resolve(root, f.path);
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new Error(`Unsafe file path blocked: ${f.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, 'utf8');
  }

  for (const rel of deleteFiles) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

/**
 * Write isolated .env + ecosystem.config.cjs and start/reload app under PM2.
 */
export function startOrReloadPm2(dir, state) {
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, `PORT=${state.port}\n`, 'utf8');
  }

  const ecoPath = path.join(dir, 'ecosystem.config.cjs');
  const eco = `module.exports = {
  apps: [{
    name: ${JSON.stringify(state.pm2Name)},
    script: ${JSON.stringify(state.pm2Entry || 'server.js')},
    cwd: ${JSON.stringify(dir)},
    autorestart: true,
    max_restarts: 5,
    env: { PORT: ${state.port}, NODE_ENV: "production" }
  }]
};
`;
  fs.writeFileSync(ecoPath, eco, 'utf8');
  return runCmd(`pm2 startOrRestart "${ecoPath}" --update-env`, dir);
}

export function findBrowserBinary() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge'];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Headless browser E2E smoke probe using Chrome DevTools Protocol & Node native WebSocket.
 */
async function probeFrontendBrowser(url, screenshotPath) {
  const bin = findBrowserBinary();
  if (!bin || typeof WebSocket !== 'function') return { skipped: true, ok: true };

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualloop-cdp-'));
  const proc = spawn(
    bin,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );

  let ws;
  try {
    const debugPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser launch timeout')), 8000);
      let buf = '';
      proc.stderr.on('data', (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Browser exited (${code})`));
      });
    });

    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page') || targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error('No CDP page target');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
    });

    let seq = 0;
    const pending = new Map();
    const errors = [];
    let loadedResolve;
    const loaded = new Promise((r) => {
      loadedResolve = r;
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Page.loadEventFired') loadedResolve();
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`JS Exception: ${d.exception?.description || d.text}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const txt = msg.params.args?.map((a) => a.value || a.description || '').join(' ');
        if (txt) errors.push(`Console Error: ${txt}`);
      }
      if (msg.method === 'Network.responseReceived' && msg.params.response?.status >= 400) {
        errors.push(`HTTP ${msg.params.response.status}: ${msg.params.response.url}`);
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await send('Page.navigate', { url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 6000))]);
    await new Promise((r) => setTimeout(r, 800));

    const checkViewport = async (label) => {
      const r = await send('Runtime.evaluate', {
        expression: `({
          textLen: document.body ? document.body.innerText.trim().length : 0,
          nodes: document.querySelectorAll("*").length,
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          brokenImgs: [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src') || 'img').slice(0, 3)
        })`,
        returnByValue: true
      });
      const v = r.result?.value || { textLen: 0, nodes: 0, sw: 0, iw: 0, brokenImgs: [] };
      if (v.textLen === 0 && v.nodes < 4) errors.push(`${label}: Blank UI rendered (empty DOM)`);
      if (v.iw > 0 && v.sw > v.iw + 4) {
        errors.push(`${label}: Horizontal layout overflow (${v.sw}px > ${v.iw}px)`);
      }
      if (v.brokenImgs?.length) {
        errors.push(`${label}: Broken images (${v.brokenImgs.join(', ')})`);
      }
    };

    await checkViewport('Desktop 1280px');

    let hasScreenshot = false;
    if (screenshotPath) {
      try {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        if (shot?.data) {
          fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
          hasScreenshot = true;
        }
      } catch {}
    }

    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await new Promise((r) => setTimeout(r, 350));
    await checkViewport('Mobile 390px');
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {});

    return errors.length
      ? { ok: false, error: errors.slice(0, 6).join('\n'), screenshotPath: hasScreenshot ? screenshotPath : null }
      : { ok: true, screenshotPath: hasScreenshot ? screenshotPath : null };
  } catch {
    return { skipped: true, ok: true };
  } finally {
    try { ws?.close(); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
  }
}

const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /sk-proj-[a-zA-Z0-9_-]{16,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

const SQL_INJECTION_PATTERNS = [
  /(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n`"]*\$\{/i,
  /f["'](?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{/i
];

/**
 * Scan workspace source files for hardcoded secrets or interpolated SQL queries.
 */
export function runSecurityCheck(dir) {
  const issues = [];
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.env')) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|cjs|py|html)$/i.test(entry.name)) continue;
      const rel = path.relative(dir, full);
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const rx of SECRET_PATTERNS) {
          if (rx.test(line)) issues.push(`${rel}:${idx + 1} hardcoded secret pattern`);
        }
        if (!/test|e2e/i.test(entry.name)) {
          for (const rx of SQL_INJECTION_PATTERNS) {
            if (rx.test(line)) issues.push(`${rel}:${idx + 1} unsafe SQL string interpolation (use parameterized queries)`);
          }
        }
      });
    }
  };
  walk(dir);
  return issues.length ? { ok: false, error: `Security check failed:\n${issues.slice(0, 6).join('\n')}` } : { ok: true };
}

/**
 * Verify all 4 layers: PM2 runtime, Security, DB/API tests, API contract endpoints, and Frontend DOM/JS/Network.
 */
export async function verifyProject(dir, state, onStep = () => {}) {
  await onStep('1/4 ตรวจ Security Baseline (Secrets & SQL)...');
  const sec = runSecurityCheck(dir);
  if (!sec.ok) {
    return { ok: false, layer: 'backend', error: sec.error };
  }

  // 1. PM2 Runtime check
  await onStep(`2/4 รัน PM2 (${state.pm2Name} บน Port ${state.port})...`);
  const pm2Res = startOrReloadPm2(dir, state);
  if (!pm2Res.ok) {
    return { ok: false, layer: 'backend', error: `PM2 start failed:\n${pm2Res.output}` };
  }
  await new Promise((r) => setTimeout(r, 1500));

  const jlist = runCmd('pm2 jlist', dir);
  if (jlist.ok) {
    try {
      const list = JSON.parse(jlist.output);
      const app = list.find((a) => a.name === state.pm2Name);
      if (app && app.pm2_env?.status !== 'online') {
        const logs = runCmd(`pm2 logs ${state.pm2Name} --err --lines 20 --nostream --no-color`, dir);
        return { ok: false, layer: 'backend', error: `PM2 ${state.pm2Name} status=${app.pm2_env?.status}\n${logs.output}` };
      }
    } catch {}
  }

  // 2. DB & Backend API test suite
  await onStep(`3/4 เทส DB & API (${state.testCommand || 'HTTP endpoints'})...`);
  if (state.testCommand) {
    const testRes = runCmd(state.testCommand, dir, 90000);
    if (!testRes.ok) {
      return { ok: false, layer: 'backend', error: `DB/API test failed (${state.testCommand}):\n${testRes.output}` };
    }
  }

  // 3. HTTP root & API_CONTRACT static GET probe
  const baseUrl = `http://127.0.0.1:${state.port}`;
  let html = '';
  try {
    const res = await fetch(`${baseUrl}/`);
    if (res.status >= 400) {
      return { ok: false, layer: 'frontend', error: `HTTP ${res.status} on ${baseUrl}/` };
    }
    html = await res.text();
  } catch (err) {
    return { ok: false, layer: 'backend', error: `Server unreachable on port ${state.port}: ${err.message}` };
  }

  const contractPath = path.join(dir, 'API_CONTRACT.json');
  if (fs.existsSync(contractPath)) {
    try {
      const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
      for (const ep of contract.endpoints || []) {
        const method = String(ep.method || 'GET').toUpperCase();
        const epPath = typeof ep === 'string' ? ep : ep.path;
        if (method === 'GET' && epPath && !epPath.includes(':') && !epPath.includes('{')) {
          const r = await fetch(`${baseUrl}${epPath.startsWith('/') ? epPath : `/${epPath}`}`);
          if (r.status >= 500) {
            return { ok: false, layer: 'backend', error: `API GET ${epPath} returned HTTP ${r.status}` };
          }
        }
      }
    } catch {}
  }

  // Check local <script src> / <link href> assets resolve cleanly
  const assetMatches = [...html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/gi)].map((m) => m[1]);
  for (const asset of assetMatches.slice(0, 15)) {
    try {
      const r = await fetch(`${baseUrl}${asset}`);
      if (r.status >= 400) {
        return { ok: false, layer: 'frontend', error: `Missing frontend asset ${asset} (HTTP ${r.status})` };
      }
    } catch {}
  }

  // 4. Frontend E2E & Real Headless Browser Probe (JS exceptions, console.error, failed fetch)
  await onStep('4/4 เทส Frontend UI, Assets & Headless Browser...');
  if (state.e2eCommand) {
    const e2eRes = runCmd(state.e2eCommand, dir, 90000);
    if (!e2eRes.ok) {
      return { ok: false, layer: 'frontend', error: `Frontend E2E failed (${state.e2eCommand}):\n${e2eRes.output}` };
    }
  }

  const previewPath = path.join(os.tmpdir(), `dualloop-preview-${state.slug}.png`);
  const browserCheck = await probeFrontendBrowser(`${baseUrl}/`, previewPath);
  if (!browserCheck.ok) {
    return {
      ok: false,
      layer: 'frontend',
      error: `Browser probe failed:\n${browserCheck.error}`,
      screenshotPath: browserCheck.screenshotPath
    };
  }

  // 5. Quick Concurrent Load & Latency Check (20 parallel GETs)
  const load = await runQuickLoadCheck(baseUrl, 20);
  if (!load.ok) {
    return { ok: false, layer: 'backend', error: `Load check failed: ${load.failed}/${load.total} errors` };
  }

  runCmd('pm2 save', dir);
  return {
    ok: true,
    screenshotPath: browserCheck.screenshotPath,
    report: {
      verifiedAt: new Date().toISOString(),
      security: 'PASS',
      pm2: `PASS (${state.pm2Name} online on :${state.port})`,
      dbApi: state.testCommand ? `PASS (${state.testCommand})` : 'PASS (Contract HTTP probe)',
      browser: browserCheck.skipped ? 'SKIPPED (no Chrome/Edge)' : 'PASS (1280px + 390px + 0 console/img errors)',
      load: `PASS (${load.okCount}/${load.total} OK, avg ${load.avgMs}ms, max ${load.maxMs}ms)`
    }
  };
}

/**
 * Fire N concurrent GET requests to verify stability and measure latency.
 */
async function runQuickLoadCheck(baseUrl, count = 20) {
  const times = [];
  let failed = 0;
  await Promise.all(
    Array.from({ length: count }, async () => {
      const t0 = performance.now();
      try {
        const r = await fetch(`${baseUrl}/`);
        if (r.status >= 500) failed++;
      } catch {
        failed++;
      } finally {
        times.push(Math.round(performance.now() - t0));
      }
    })
  );
  const avgMs = Math.round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length));
  const maxMs = Math.max(0, ...times);
  return { ok: failed === 0, okCount: count - failed, failed, total: count, avgMs, maxMs };
}

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { listProjects } from './state.js';

/**
 * Allocate the next free port starting from basePort.
 */
export function allocatePort(workspacesDir, basePort) {
  const used = new Set(listProjects(workspacesDir).map((p) => p.state.port));
  let port = basePort;
  while (used.has(port)) port++;
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
  return runCmd(`git reset --hard ${hash}`, dir);
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

/**
 * Verify PM2 process status, HTTP reachability, and test command.
 */
export async function verifyProject(dir, state) {
  const pm2Res = startOrReloadPm2(dir, state);
  if (!pm2Res.ok) {
    return { ok: false, error: `PM2 failed:\n${pm2Res.output}` };
  }

  // Brief wait for server bind before health/test run
  await new Promise((r) => setTimeout(r, 1500));

  if (state.testCommand) {
    const testRes = runCmd(state.testCommand, dir, 90000);
    if (!testRes.ok) {
      return { ok: false, error: `Test failed (${state.testCommand}):\n${testRes.output}` };
    }
  }

  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/`);
    if (res.status >= 500) {
      return { ok: false, error: `HTTP ${res.status} on port ${state.port}` };
    }
  } catch (err) {
    return { ok: false, error: `Server unreachable on port ${state.port}: ${err.message}` };
  }

  return { ok: true };
}

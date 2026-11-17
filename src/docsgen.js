import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { findBrowserBinary } from './runner.js';

function esc(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function parseSqlTables(sql) {
  const tables = [];
  const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = regex.exec(sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const fks = [];
    const fkRegex = /REFERENCES\s+[`"[]?(\w+)[`"\]]?/gi;
    let fm;
    while ((fm = fkRegex.exec(body)) !== null) fks.push(fm[1]);
    tables.push({ name, fks: [...new Set(fks)] });
  }
  return tables;
}

function parseEndpoints(contract) {
  return (contract?.endpoints || []).map((ep) => {
    if (typeof ep === 'string') return ep;
    return `${String(ep.method || 'GET').toUpperCase()} ${ep.path || '/'}`;
  });
}

/**
 * Generate per-project flow, diagram (SVG/PNG), interactive HTML, and TECHSTACK.txt inside <dir>/docs.
 */
export function generateProjectDocs(dir, state) {
  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  const spec = fs.existsSync(path.join(dir, 'SPEC.md'))
    ? fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8')
    : '';
  const sql = fs.existsSync(path.join(dir, 'DB_SCHEMA.sql'))
    ? fs.readFileSync(path.join(dir, 'DB_SCHEMA.sql'), 'utf8')
    : '';
  let contract = {};
  try {
    contract = JSON.parse(fs.readFileSync(path.join(dir, 'API_CONTRACT.json'), 'utf8'));
  } catch {}

  const tables = parseSqlTables(sql);
  const endpoints = parseEndpoints(contract);
  const answers = (state.clarifyAnswers || []).map((a) => `- ${a.question} => ${a.answer}`).join('\n');

  // 1. TECHSTACK.txt
  const techTxt = [
    `============================================================`,
    `PROJECT TECHSTACK & ARCHITECTURE: ${state.name} (${state.slug})`,
    `============================================================`,
    `Concept     : ${state.concept}`,
    `Runtime     : PM2 (${state.pm2Name}) · Entry: ${state.pm2Entry || 'server.js'} · Port: ${state.port}`,
    `Test Cmd    : ${state.testCommand || 'N/A'}`,
    `E2E Cmd     : ${state.e2eCommand || 'N/A'}`,
    ``,
    `1. DECISIONS & STACK`,
    answers || '- Default stack',
    ``,
    `2. RELATIONAL DATABASE TABLES (${tables.length})`,
    tables.length
      ? tables.map((t) => `- ${t.name}${t.fks.length ? ` (FK -> ${t.fks.join(', ')})` : ''}`).join('\n')
      : '- (see DB_SCHEMA.sql)',
    ``,
    `3. API ENDPOINTS (${endpoints.length})`,
    endpoints.length ? endpoints.map((e) => `- ${e}`).join('\n') : '- (see API_CONTRACT.json)',
    ``,
    `4. SPEC SUMMARY`,
    spec || state.concept,
    `============================================================`
  ].join('\n');
  fs.writeFileSync(path.join(docsDir, 'TECHSTACK.txt'), techTxt, 'utf8');

  // 2. FLOW_DIAGRAM.md (Mermaid Architecture + ER Diagram)
  const erLines = ['erDiagram'];
  for (const t of tables) {
    erLines.push(`  ${t.name} { int id PK }`);
    for (const fk of t.fks) {
      erLines.push(`  ${fk} ||--o{ ${t.name} : references`);
    }
  }
  const flowMd = [
    `# ${state.name} — System Flow & Diagrams`,
    ``,
    `## Architecture Flow`,
    '```mermaid',
    `flowchart LR`,
    `  UI["Frontend UI (HTML/CSS/JS)"] --> API["Backend API (Port ${state.port})"]`,
    `  API --> DB["Relational DB (${tables.map((t) => t.name).join(', ') || 'SQLite'})"]`,
    `  PM2["PM2 (${state.pm2Name})"] --> API`,
    '```',
    ``,
    `## Database Relations`,
    '```mermaid',
    tables.length ? erLines.join('\n') : 'erDiagram\n  APP_DATA { int id PK }',
    '```',
    ``,
    `## API Endpoints`,
    endpoints.length ? endpoints.map((e) => `- \`${e}\``).join('\n') : '- See `API_CONTRACT.json`'
  ].join('\n');
  fs.writeFileSync(path.join(docsDir, 'FLOW_DIAGRAM.md'), flowMd, 'utf8');

  // 3. diagram.svg (Vector System Diagram)
  const epLines = (endpoints.length ? endpoints : ['GET /', 'GET /api/health']).slice(0, 6);
  const tbLines = (tables.length ? tables.map((t) => `${t.name}${t.fks.length ? ` -> ${t.fks.join(',')}` : ''}`) : ['Relational SQLite DB']).slice(0, 6);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 520" width="1120" height="520">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"/>
    </marker>
  </defs>
  <rect width="1120" height="520" fill="#0b1020"/>
  <text x="36" y="46" fill="#f8fafc" font-family="Segoe UI,Arial,sans-serif" font-size="24" font-weight="700">${esc(state.name)} — Architecture &amp; Flow</text>
  <text x="36" y="72" fill="#94a3b8" font-family="Segoe UI,Arial,sans-serif" font-size="13">${esc(state.concept).slice(0, 110)}</text>

  <rect x="36" y="110" width="290" height="320" rx="12" fill="#131c31" stroke="#38bdf8" stroke-width="2"/>
  <text x="56" y="142" fill="#38bdf8" font-family="Segoe UI,Arial,sans-serif" font-size="16" font-weight="700">1. Frontend UI</text>
  <text x="56" y="172" fill="#e2e8f0" font-family="Segoe UI,Arial,sans-serif" font-size="13">• HTML / CSS / JS</text>
  <text x="56" y="196" fill="#e2e8f0" font-family="Segoe UI,Arial,sans-serif" font-size="13">• http://127.0.0.1:${state.port}</text>
  <text x="56" y="220" fill="#94a3b8" font-family="Segoe UI,Arial,sans-serif" font-size="12">• Responsive 1280px &amp; 390px</text>

  <rect x="415" y="110" width="310" height="320" rx="12" fill="#131c31" stroke="#818cf8" stroke-width="2"/>
  <text x="435" y="142" fill="#818cf8" font-family="Segoe UI,Arial,sans-serif" font-size="16" font-weight="700">2. Backend API (PM2: ${esc(state.pm2Name)})</text>
  ${epLines.map((e, i) => `<text x="435" y="${174 + i * 26}" fill="#e2e8f0" font-family="Consolas,monospace" font-size="12">${esc(e.slice(0, 36))}</text>`).join('\n  ')}

  <rect x="810" y="110" width="274" height="320" rx="12" fill="#131c31" stroke="#22c55e" stroke-width="2"/>
  <text x="830" y="142" fill="#22c55e" font-family="Segoe UI,Arial,sans-serif" font-size="16" font-weight="700">3. Relational DB (3NF)</text>
  ${tbLines.map((t, i) => `<text x="830" y="${174 + i * 26}" fill="#e2e8f0" font-family="Consolas,monospace" font-size="12">${esc(t.slice(0, 32))}</text>`).join('\n  ')}

  <line x1="326" y1="270" x2="412" y2="270" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#arr)"/>
  <line x1="725" y1="270" x2="807" y2="270" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#arr)"/>
  <text x="36" y="478" fill="#64748b" font-family="Segoe UI,Arial,sans-serif" font-size="12">Generated by DualLoop · Entry: ${esc(state.pm2Entry)} · Test: ${esc(state.testCommand || 'smoke')}</text>
</svg>`;
  const svgPath = path.join(docsDir, 'diagram.svg');
  fs.writeFileSync(svgPath, svg, 'utf8');

  // 4. architecture.html (Interactive HTML Flow & Techstack Viewer)
  const html = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${esc(state.name)} — Architecture &amp; Flow</title>
  <style>
    body { margin:0; font-family:system-ui,sans-serif; background:#0b1020; color:#e7edf8; padding:24px; }
    .wrap { max-width:1140px; margin:0 auto; }
    .card { background:#131b31; border:1px solid #243258; border-radius:12px; padding:16px; margin-bottom:16px; }
    pre { background:#070b14; padding:12px; border-radius:8px; overflow:auto; font-size:12px; color:#cbd5e1; white-space:pre-wrap; }
    img { max-width:100%; height:auto; border-radius:8px; }
    a.btn { display:inline-block; background:#0284c7; color:#fff; padding:7px 12px; border-radius:8px; text-decoration:none; font-size:13px; font-weight:600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <h1>⚡ ${esc(state.name)} — Flow &amp; Techstack</h1>
      <a class="btn" href="./api-tester.html">🧪 Open Interactive API Tester ↗</a>
    </div>
    <p style="color:#94a3b8;">${esc(state.concept)}</p>
    <div class="card"><h3>System Diagram</h3><img src="./diagram.svg" alt="diagram"/></div>
    <div class="card"><h3>Techstack &amp; Contract Summary</h3><pre>${esc(techTxt)}</pre></div>
  </div>
</body>
</html>`;
  fs.writeFileSync(path.join(docsDir, 'architecture.html'), html, 'utf8');

  // 5. Interactive API Tester (api-tester.html)
  const rawEndpoints = (contract?.endpoints || []).map((ep) =>
    typeof ep === 'string'
      ? { method: 'GET', path: ep, body: '' }
      : {
          method: String(ep.method || 'GET').toUpperCase(),
          path: ep.path || '/',
          body: ep.request || ep.body ? JSON.stringify(ep.request || ep.body, null, 2) : ''
        }
  );
  if (!rawEndpoints.length) rawEndpoints.push({ method: 'GET', path: '/', body: '' });

  const testerHtml = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${esc(state.name)} — API Tester</title>
  <style>
    body { margin:0; font-family:system-ui,sans-serif; background:#0b1020; color:#e7edf8; padding:24px; }
    .wrap { max-width:960px; margin:0 auto; }
    .card { background:#131b31; border:1px solid #243258; border-radius:12px; padding:16px; margin-bottom:16px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
    input, select, textarea, button { background:#070b14; color:#e7edf8; border:1px solid #243258; border-radius:8px; padding:8px 10px; font-size:13px; }
    button { background:#0284c7; border-color:#0284c7; font-weight:600; cursor:pointer; }
    button.ep { background:#1c294a; border-color:#2c3e6b; text-align:left; }
    textarea { width:100%; min-height:110px; font-family:Consolas,monospace; }
    pre { background:#070b14; border:1px solid #243258; border-radius:8px; padding:12px; overflow:auto; max-height:360px; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🧪 ${esc(state.name)} — Interactive API Tester</h1>
    <div class="card">
      <div class="row" id="epList"></div>
      <div class="row">
        <input id="baseUrl" value="http://127.0.0.1:${state.port}" style="flex:1;min-width:200px;" />
        <select id="method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
        <input id="epPath" value="${esc(rawEndpoints[0].path)}" style="flex:2;min-width:220px;" />
        <button onclick="sendReq()">Send</button>
      </div>
      <textarea id="reqBody" placeholder="JSON body (optional)"></textarea>
    </div>
    <div class="card">
      <div id="respMeta" style="color:#94a3b8;font-size:13px;margin-bottom:8px;">Ready</div>
      <pre id="respOut"></pre>
    </div>
  </div>
  <script>
    const ENDPOINTS = ${JSON.stringify(rawEndpoints)};
    document.getElementById('epList').innerHTML = ENDPOINTS.map((e, i) =>
      '<button class="ep" onclick="pick(' + i + ')">' + e.method + ' ' + e.path + '</button>'
    ).join('');
    function pick(i) {
      const e = ENDPOINTS[i];
      document.getElementById('method').value = e.method;
      document.getElementById('epPath').value = e.path;
      document.getElementById('reqBody').value = e.body || '';
    }
    async function sendReq() {
      const base = document.getElementById('baseUrl').value.replace(/\\/+$/, '');
      const method = document.getElementById('method').value;
      const p = document.getElementById('epPath').value;
      const body = document.getElementById('reqBody').value.trim();
      const targetUrl = base + (p.startsWith('/') ? p : '/' + p);
      const t0 = performance.now();
      let statusText = '';
      let text = '';
      try {
        const useProxy = location.port && location.port !== '${state.port}';
        const res = useProxy
          ? await fetch('/api/proxy', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url: targetUrl, method, body: body || undefined })
            })
          : await fetch(targetUrl, {
              method,
              headers: body ? { 'content-type': 'application/json' } : {},
              body: method !== 'GET' && method !== 'HEAD' && body ? body : undefined
            });
        statusText = 'HTTP ' + res.status;
        text = await res.text();
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      } catch (err) {
        statusText = 'Error';
        text = err.message;
      }
      document.getElementById('respMeta').textContent = statusText + ' · ' + Math.round(performance.now() - t0) + 'ms';
      document.getElementById('respOut').textContent = text;
    }
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(docsDir, 'api-tester.html'), testerHtml, 'utf8');

  // 5. Render diagram.png if Chrome/Edge binary exists
  const pngPath = path.join(docsDir, 'diagram.png');
  const bin = findBrowserBinary();
  if (bin) {
    try {
      const fileUrl = `file:///${svgPath.replace(/\\/g, '/')}`;
      execSync(`"${bin}" --headless=new --disable-gpu --screenshot="${pngPath}" --window-size=1120,520 "${fileUrl}"`, {
        stdio: 'ignore',
        timeout: 12000
      });
    } catch {}
  }

  return { docsDir, svgPath, pngPath: fs.existsSync(pngPath) ? pngPath : null };
}

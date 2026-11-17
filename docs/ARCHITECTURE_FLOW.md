# DualLoop System Architecture & Full-Loop Flow

## 1. High-Level System Architecture

```mermaid
flowchart LR
  User["User (Telegram / IDE / CLI / Web Dashboard)"] --> Entry["Orchestrator & Job Queue\nsrc/orchestrator.js"]
  Entry --> State["State & Rules\nSTATE.json · PROJECT_RULES.md"]
  Entry --> AI["Universal Dual-AI Adapter\nsrc/ai.js"]
  AI --> BE["Backend AI\n(claude-cli / anthropic / openai / openrouter / ollama)"]
  AI --> FE["Frontend AI\n(agy / gemini-cli / gemini / custom)"]
  Entry --> Runner["Runner & 4-Layer Verifier\nsrc/runner.js"]
  Runner --> GitDB["Git Checkpoint + DB Snapshot"]
  Runner --> PM2["PM2 Isolated App\n(127.0.0.1:4100+)"]
  Runner --> CDP["Headless Chrome/Edge CDP\n(1280px + 390px + Screenshot)"]
  PM2 --> Watchdog["45s Crash Watchdog + 24h Health"]
  Watchdog --> User
```

## 2. Full-Loop Execution Flow (4 Phases)

```mermaid
flowchart TD
  Start["Input: /new, /new --tpl, Photo/Voice, or Web Dashboard"] --> P1["Phase 1/4: Clarify (grill-me + Ponytail)\nChoice-only Q&A + UI Theme Preset"]
  P1 -->|More questions| Ask["Ask via Telegram Inline Buttons / CLI Arrows"]
  Ask --> P1
  P1 -->|Done| Lock["Lock SPEC.md + DB_SCHEMA.sql (3NF) + API_CONTRACT.json"]

  Lock --> P2["Phase 2/4: Checkpoint\nGit Commit + SQLite DB Snapshot"]
  P2 --> P3["Phase 3/4: Build Loop (Task Queue)"]

  P3 --> Budget{"AI Calls < MAX_AI_CALLS?"}
  Budget -->|No| AskBudget["Ask User: +10 Calls or Pause"]
  AskBudget --> P3
  Budget -->|Yes| Exec["Execute Task (Backend or Frontend AI + Fallback)"]

  Exec -->|Blocked| Defer["Skip-on-Block: Save to blockedQuestions[]"]
  Defer --> P3
  Exec -->|OK| Apply["Write Files + Schema Guard Sync"]
  Apply -->|Pending tasks left| P3

  Apply -->|All unblocked done| Review["Phase 3.5: Cross-AI Review"]
  Review --> P4["Phase 4/4: Verify (4 Layers)"]
  P4 --> V1["1. Security Scan -> 2. PM2 Online -> 3. DB/API Tests -> 4. Browser CDP + Screenshot"]

  V1 -->|Pass| Done["Done: pm2 save + git push (if origin) + Send URL & Screenshot"]
  V1 -->|Fail & Loops < MAX| Fix["Route to Failing Track (Backend/Frontend) & Fix"]
  Fix --> P4
  V1 -->|Max Loops Reached| CB["Circuit Breaker: Retry / Rollback + DB Restore / Skip"]
```

## 3. File Map

| File | Responsibility |
|------|----------------|
| `bin/cli.js` | `npx` arrow-key installer, `init`, `doctor`, `run`, `continue` |
| `src/config.js` | `.env` loader, provider normalization, `~/Desktop` resolution |
| `src/state.js` | `STATE.json`, metrics, `PROJECT_RULES.md`, compressed context |
| `src/ai.js` | 10-provider adapter, Auto-Fallback, 3NF DB rules, Cross-Review, Media |
| `src/runner.js` | Port check, Git/DB backup, 4-Layer Verify, CDP, Security, Zip/Proxy/Tunnel |
| `src/telegram.js` | 2-way Telegram bot, inline buttons, custom text, cancel, media/docs |
| `src/dashboard.js` | Built-in Web Control Server (`127.0.0.1:4099`) |
| `public/dashboard.html` | Real-time Web Control Panel UI |
| `skills/dualloop/SKILL.md` | Agent Skill for Antigravity, Claude Code, Codex, `.agents` |

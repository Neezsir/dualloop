---
name: dualloop
description: >
  Full-loop Dual-AI builder (Claude Backend/DB/Test + Gemini Frontend) with
  PM2 runtime, Git checkpoints, Skip-on-Block queue, and Ponytail brevity.
  Use when building a program end-to-end from a name and concept, running
  choice-only clarification, or continuing an existing dualloop project.
argument-hint: "<project-name> <concept>"
license: MIT
---

# DualLoop

Build complete software in tight, low-token loops: clarify via clickable choices, lock contracts, build Backend + Frontend in parallel roles, verify under PM2, and queue blockers without stalling.

## Core Rules (Ponytail Enforced)

- **Short questions, choice-first:** Ask via structured multiple-choice (`ask_question` in IDE or inline buttons in Telegram). One decision per prompt, 2–4 concise options.
- **Minimal code:** Stdlib and native platform features first (Node.js, Python, HTML/CSS/JS). Zero unrequested abstractions or boilerplate.
- **PM2 runtime:** Run all built services via `pm2` with isolated ports and `.env`.
- **Relational DB integrity:** Always design 3NF relational tables with explicit `PRIMARY KEY`, `FOREIGN KEY ... REFERENCES ... ON DELETE`, `NOT NULL`/`UNIQUE`/`CHECK` constraints, indexes on FKs, `PRAGMA foreign_keys = ON` (SQLite), and idempotent seed data so the UI renders live records immediately. On updates, use idempotent `ALTER TABLE` migrations — never drop existing data.
- **Security baseline:** Always parameterize SQL queries, never hardcode secrets/keys, never expose `password`/secret fields in JSON APIs, and guard protected routes.
- **Isolated project folder:** Create and work inside a dedicated folder named after `<project-name>` on Desktop (unless another path is specified).
- **Single source of truth:** Keep `STATE.json` and `API_CONTRACT.json` concise; read state files instead of replaying long history.

## Loop Sequence

1. **Clarify (`grill-me` + Ponytail):**
   - Receive `<project-name>` and `<concept>`.
   - If AI mode/models are not yet set in `.env`, ask once via choices (e.g. `Claude Opus 5.5` vs `Sonnet`, `Gemini 4 Hydrogen` vs `Argon`, and `Auto-fallback On/Off`).
   - Ask short choice questions until Tech Stack, DB, Core Process, and Auth/Scope are unambiguous.
   - Output compact `SPEC.md`, `DB_SCHEMA.sql`, and `API_CONTRACT.json`.
   - *Done when:* Contracts exist and zero open ambiguity remains for the first task.

2. **Checkpoint & Isolate:**
   - Initialize/commit a Git checkpoint before every build loop (`git add -A && git commit`).
   - Assign an isolated port and PM2 app name in `ecosystem.config.cjs`.

3. **Dual-Track Build:**
   - **Backend / DB / Process / Tests (Claude role):** Implement data layer, API endpoints matching `API_CONTRACT.json`, business logic, and runnable smoke/API tests.
   - **Frontend (Gemini role):** Implement clean HTML/CSS/JS UI consuming `API_CONTRACT.json` strictly.
   - **Schema Guard:** Any `API_CONTRACT.json` or `DB_SCHEMA` change triggers re-sync and re-test of the opposite track.

4. **Skip-on-Block Queue:**
   - Break work into independent tasks (`db`, `backend`, `frontend`, `integration`).
   - If a task requires human judgment or external credentials, mark it `blocked`, push a short choice question to `blockedQuestions`, and continue remaining unblocked tasks.

5. **Verify & Circuit Breaker (4-Layer Full-Stack):**
   - Start/reload service with `pm2`, confirm `online` status, and run `pm2 save`.
   - Run security baseline check (no hardcoded secrets, no SQL string interpolation).
   - Run DB + API tests (verify FK constraints, CRUD round-trips, 4xx validation, `API_CONTRACT.json` endpoints).
   - Run Frontend browser/E2E verification (zero JS/console errors, zero 4xx/5xx asset or API requests, non-blank DOM, and form -> API -> DB -> reload flow).
   - On failure: route to the failing track (`backend` or `frontend`), fix root cause, and re-test up to `MAX_FIX_LOOPS` (default 4).
   - If still failing: stop, keep last working Git checkpoint available for rollback, and ask user via concise choice options (`Retry`, `Rollback`, `Skip`).

6. **Deliver & Continue:**
   - Present final PM2 status, URL/port, and any remaining `blockedQuestions`.
   - Future requests read `STATE.json` and append new tasks into the same loop.

# DualLoop

Autonomous Dual-AI full-loop builder (`Claude` Backend/DB/Test + `Gemini` Frontend) with **PM2**, **Telegram 2-Way Choice UI**, **Git Auto-Checkpoint**, **Skip-on-Block Queue**, and **Ponytail** brevity.

## Quick Install (`npx` from GitHub)

```bash
# Interactive wizard: install SKILL.md + choose AI models/modes + Auto-Fallback + optional PM2
npx github:Neezsir/dualloop

# Full server setup (.env + Skill + PM2)
npx github:Neezsir/dualloop init

# Or install only the Agent Skill directly
npx skills add Neezsir/dualloop
```

## Run Locally or on External Server (PM2)

```bash
cp .env.example .env
pm2 start ecosystem.config.cjs
```

## Telegram Commands

- `/new <name> | <concept>` — Start clarify (clickable buttons) -> build -> PM2 test loop
- `/continue <slug> | <instruction>` — Add features on top of `STATE.json`
- `/questions` — Answer queued blocked decisions
- `/status` — Show project states & PM2 status
- `/logs <slug>` — Tail PM2 logs
- `/rollback <slug>` — Reset to last Git checkpoint

## CLI Mode

```bash
node bin/cli.js run "todo-app" "Simple task manager with SQLite"
node bin/cli.js continue todo-app "Add dark mode toggle"
```

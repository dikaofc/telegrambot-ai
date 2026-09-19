# TeleAgent — Telegram Autonomous Coding Agent (super-harness edition)

Telegram is only the interface (input / output / approval / status / control).
Intelligence and execution live in the backend: session manager → agent
orchestrator → multi-provider brain → real tool executor (45+ tools: filesystem,
PTY-backed shell + background sessions, git, knowledge graph, web, archives,
checkpoints, memory, processes) inside a sandboxed workspace.

No commands needed: send natural language, e.g. `cek kenapa build gagal`,
`bikin auth yang aman`, `refactor database supaya lebih cepat`.

## Quick start

```bash
git clone <repo> && cd teleagent
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN + provider key
npm install
npm run setup
npm run dev            # bot (polling) + API + dashboard on :49374
```

Production:

```bash
docker compose up -d
```

Open the dashboard: **http://localhost:49374** (status, sessions, runs,
approvals with approve/reject buttons, workspaces, providers, usage, audit,
settings, knowledge-graph explorer).

Terminal UI (same data, works over SSH / Termux):

```bash
npm run tui
```

## Configuration

See `.env.example`. Hierarchy: `environment > config file > provider defaults > system defaults`.
Per-scope overrides: user > session > workspace > global.

Providers: satu config universal — `PROVIDER=9router|openai|xai|anthropic|ollama|custom`
+ satu `PROVIDER_API_KEY` untuk semua. Endpoint & model bawaan mengikuti
`PROVIDER`; isi `PROVIDER_BASE_URL` hanya untuk override atau endpoint sendiri
(`PROVIDER=custom`). `model: auto` routes per task dengan fallback.

## Architecture

```text
Telegram → Gateway → Session Manager → Agent Orchestrator → Providers
→ NativeRuntime (understand→plan→tools→execute→verify→retry)
→ Tool Executor (45+ tools) → Workspace/Sandbox (PTY, git, graph)
→ Dashboard :49374 + Terminal UI (same live data)
```

- `src/config`, `src/database` (SQLite single-node; Postgres via compose)
- `src/providers` (OpenAI-compat streaming + Anthropic native + router/fallback)
- `src/tools` (filesystem/search/shell+PTY/**background sessions**/git/http/fetch/
  archives/process/pm/browser/docker + todos/checkpoint/memory/profile)
- `src/integrations` (graphify knowledge-graph harness, GitHub)
- `src/runtime` (NativeRuntime + CLI adapters: opencode/codex/claude/gemini/generic)
- `src/agent` (orchestrator, state machine, context, skills, memory, verification, checkpoint, recovery, multi-agent)
- `src/security` (risk/policy, command parser, SSRF, upload validation, access, rate-limit, audit, secrets)
- `src/telegram` (gateway, renderer/status engine, keyboards, settings UI, archive auto-extract)
- `src/dashboard` (dependency-free web UI), `src/tui` (readline terminal UI)
- `src/sandbox`, `src/workspace`, `src/api` (REST + WS + OpenAI gateway + webhook), `src/observability`, `src/plugins`
- `apps/bot|api|worker|tui`, `skills/*`, `migrations/001_init.sql`

## Agent tools (auto-approved by risk, MEDIUM+ asks on Telegram)

| group | tools |
|---|---|
| files | `read_file write_file edit_file apply_patch delete_file move_file copy_file list_directory tree read_many file_exists file_info` |
| search | `glob find_files grep search_code` |
| shell | `shell shell_start shell_poll shell_input shell_kill` (background sessions for dev servers/watch mode) |
| git | `git_status git_diff git_log git_show git_branch git_checkout git_commit` |
| verify | `npm_test npm_build npm_install detect_pm` (deterministic per project) |
| graph | `graphify_status graphify_build graphify_query graphify_path graphify_explain` |
| web | `http_get http_post fetch_text` (SSRF-protected) |
| archives | `archive_extract` (traversal + zip-bomb guarded; Telegram uploads auto-extract) |
| plan/memory | `todo_write todo_list memory_remember memory_recall project_profile env_info checkpoint_create checkpoint_restore` |
| system | `process_list process_kill` (+ browser tools when a worker is configured) |

## Knowledge-graph harness (Graphify)

Optional but recommended — the agent queries the graph instead of grepping:

```bash
uv tool install graphifyy   # or: pipx install graphifyy  (Python 3.10+)
```

Code indexing is fully local (tree-sitter, no API key). The agent auto-detects
the CLI: `graphify_status` → `graphify_build` → `graphify_query/path/explain`.
Without the CLI every graph tool fails honestly with install instructions and
the agent falls back to `search_code`/`grep`. Dashboard → Graphify tab and
`npm run tui` → `graphify <workspace>` expose the same status.

## API

- `GET /` dashboard · `GET /api/status` (public) · `GET /health /ready /metrics`
- `GET /api/sessions /api/runs /api/approvals/pending /api/workspaces /api/providers /api/usage /api/audit /api/settings /api/memory`
- `POST /api/settings` (secrets refused) · `POST /api/approvals/:id` · `POST /api/runs/:id/stop`
- `POST /api/graphify/build|query|path|explain` · `GET /api/graphify/status`
- `POST /v1/sessions`, `GET /v1/sessions/:id`, `POST /v1/sessions/:id/messages|stop|pause|resume`
- `GET /v1/workspaces`, `GET /v1/providers`, `GET /v1/models`, `GET /v1/runs/:id`
- `WS /v1/ws/sessions/:id`, `POST /v1/chat/completions` (OpenAI-compatible)
- `POST /telegram/webhook` (production, secret-token validated)

## Platform guides (lightweight: zero native deps, pure JS + Node ≥ 22)

**VPS / Linux server**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git
git clone <repo> && cd teleagent && cp .env.example .env && npm install && npm run setup
npm run dev          # or: docker compose up -d   (adds postgres/redis/sandbox worker)
```
systemd: run `npm start` under a unit with `Restart=always`, keep `/data` + `/workspaces` on a volume.

**Linux desktop** — same as above; dashboard at http://localhost:49374.

**Android (Termux)**
```bash
pkg update && pkg install nodejs git python -y
git clone <repo> && cd teleagent && cp .env.example .env && npm install && npm run setup
npm run dev
```
Notes: use `npm run tui` for control (no browser needed); sandbox runs in
boundary-enforced local mode (Docker unavailable on Android); keep
`WORKSPACE_ROOT` on internal storage; Termux may kill background processes —
run inside `termux-wake-lock` or a `tmux` session.

**Windows (10/11)**
```powershell
winget install OpenJS.NodeJS.LTS Git.Git
git clone <repo>; cd teleagent; copy .env.example .env; npm install; npm run setup
npm run dev
```
`tar`/`Expand-Archive` ship with Windows so archive tools work; `shell_start`
uses PowerShell on win32 automatically; use WSL2 + Docker Desktop for the
docker sandbox and `docker compose up -d`.

**macOS** — `brew install node git`, then the standard quick start.

Resource profile: idle ~60–120 MB RAM, no background threads except active
runs; SQLite WAL for single-node (no extra services required); Redis/Postgres
only for scaled deployments.

## Safety

Risk levels SAFE→CRITICAL; SAFE/LOW auto, MEDIUM/HIGH ask (inline Approve/Reject
+ dashboard buttons), CRITICAL deny. Command parser blocks `rm -rf /`, mkfs,
shutdown, credential paths, host escapes — including `shell_start`/`shell_input`.
SSRF blocks localhost/private/link-local. Uploads validate name/size/ext/traversal
and auto-extract into isolated folders. Owner/private/public/allowlist modes +
per-tool authorization, audit log with secret redaction, rate limits + token quota,
workspace isolation, sandbox (docker when available, boundary-enforced local
otherwise), checkpoints before big changes.

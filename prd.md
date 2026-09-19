iya, dika. model yang kamu maksud lebih tepat kalau dibuat sebagai **agent runtime yang Telegram cuma jadi interface**, bukan bot Telegram yang sekadar meneruskan prompt ke API.

dan karena kamu ingin **tanpa command**, UX-nya harus seperti ini:

```text
dika:
"tolong cek project ini, cari kenapa build gagal,
perbaiki, jalankan test, kalau masih error lanjut perbaiki."

agent:
🧠 analyzing workspace...
🔎 inspecting package.json
📂 reading 7 files
🛠 editing src/...
▶️ running npm test
❌ 2 tests failed
🔧 fixing failures
▶️ running tests again
✅ 24/24 tests passed
📦 build completed

"selesai. aku menemukan ... dan memperbaiki ..."
```

jadi `/run`, `/exec`, `/model`, `/approve`, dan command lain **tidak diperlukan untuk penggunaan normal**.

berikut PRD production-grade yang bisa langsung kamu kasih ke coding agent.

---

# telegram autonomous coding agent

**project name:** `teleagent`
**type:** autonomous multi-provider coding agent
**interface:** Telegram Bot
**runtime:** local server / VPS / container / cloud VM
**architecture:** event-driven, persistent sessions, PTY-backed execution

## 1. product vision

membangun agent coding autonomous yang dapat melakukan pekerjaan software engineering melalui Telegram dengan pengalaman yang sedekat mungkin dengan coding agent CLI modern.

Telegram bukan agent-nya.

Telegram hanya:

```text
INPUT
OUTPUT
APPROVAL
STATUS
CONTROL
```

sedangkan intelligence dan execution berada di backend.

```text
                    TELEGRAM
                       │
                       ▼
              ┌─────────────────┐
              │ Telegram Gateway│
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Session Manager │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Agent Orchestr. │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      OpenAI       9Router         xAI
      provider     provider       provider
          │            │            │
          └────────────┼────────────┘
                       ▼
               Model / Agent Brain
                       │
                       ▼
              ┌─────────────────┐
              │ Tool Executor   │
              └────────┬────────┘
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
   filesystem        shell             git
       │               │                │
       ▼               ▼                ▼
   workspace        PTY/process       repository
```

---

# 2. core requirement

agent harus bisa menerima **pesan natural language apa pun**.

contoh:

```text
bikin authentication system yang aman di project ini
```

```text
cek kenapa server kadang crash
```

```text
refactor bagian database supaya lebih cepat
```

```text
baca semua source code project ini dan jelaskan architecture-nya
```

```text
implementasikan fitur dark mode, test semuanya, dan jangan berhenti
sampai build berhasil
```

```text
cari bug yang menyebabkan memory leak lalu perbaiki
```

agent sendiri menentukan:

```text
intent
→ plan
→ tools
→ execution
→ verification
→ retry
→ final response
```

user tidak perlu mengetahui tool atau command internal.

---

# 3. autonomous agent loop

core loop:

```text
MESSAGE
   ↓
UNDERSTAND
   ↓
CONTEXT DISCOVERY
   ↓
PLAN
   ↓
TOOL SELECTION
   ↓
EXECUTE
   ↓
OBSERVE
   ↓
VERIFY
   ↓
ERROR?
 ┌─┴─┐
YES  NO
 │    │
 ▼    ▼
FIX  COMPLETE
 │
 └──────→ VERIFY
```

agent tidak boleh langsung menjawab:

```text
"sepertinya sudah diperbaiki"
```

jika task membutuhkan perubahan filesystem.

harus ada evidence:

```text
file modified
test executed
test result
build result
```

---

# 4. agent state machine

state:

```ts
type AgentState =
  | "idle"
  | "thinking"
  | "planning"
  | "reading"
  | "editing"
  | "executing"
  | "testing"
  | "waiting_approval"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
```

Telegram harus mendapatkan perubahan state secara realtime.

contoh:

```text
🧠 thinking

🔎 inspecting workspace

📖 reading:
src/auth/index.ts

🛠 modifying:
src/auth/index.ts

▶️ executing:
npm test

❌ test failed

🔧 diagnosing failure

🔁 retrying

✅ tests passed
```

---

# 5. tidak menggunakan command

normal UX:

```text
user → message
```

bukan:

```text
user → /run
user → /model
user → /exec
```

agent harus memahami natural language.

misalnya:

```text
pakai model minimax untuk task ini
```

agent dapat mengubah model.

atau:

```text
jangan jalankan command berbahaya tanpa izin
```

agent mengubah policy session.

settings juga dapat dilakukan melalui UI Telegram.

gunakan:

```text
Inline Keyboard
Reply Keyboard
Telegram Menu
Telegram WebApp
```

bukan command sebagai primary interface.

---

# 6. Telegram interface

main conversation:

```text
┌──────────────────────────┐
│ 🤖 TeleAgent             │
│                          │
│ ● connected              │
│ model: auto              │
│ workspace: my-project    │
└──────────────────────────┘
```

setiap task menggunakan live status message.

Telegram tidak boleh mengirim 1000 message untuk 1000 event.

gunakan:

```text
message aggregation
debounce
editMessageText
```

contoh:

```text
🧠 Agent working...

phase: testing
tool: shell
command: npm test

progress:
██████████████░░░░ 78%

files changed: 6
tests: 18 passed
errors: 2
```

message di-update daripada membuat spam.

---

# 7. Telegram interaction

gunakan inline buttons:

```text
[ Stop ] [ Pause ]

[ Approve ] [ Reject ]

[ Details ]

[ Retry ]
```

setelah selesai:

```text
✅ task completed

files changed: 8
tests: 31 passed
build: successful

[ View Diff ] [ View Logs ]
```

---

# 8. approval system

agent tidak boleh memiliki unrestricted execution secara default.

risk level:

```ts
enum RiskLevel {
  SAFE,
  LOW,
  MEDIUM,
  HIGH,
  CRITICAL
}
```

contoh:

```text
read_file              SAFE
write_file             LOW
git_diff               SAFE
npm_test               LOW
npm_install             MEDIUM
git_commit              MEDIUM
git_push                HIGH
rm -rf                  CRITICAL
system_shutdown        CRITICAL
```

policy:

```yaml
permissions:
  filesystem: true
  shell: true
  network: true
  git: true

approval:
  safe: automatic
  low: automatic
  medium: ask
  high: ask
  critical: deny
```

user menerima:

```text
⚠️ approval required

agent wants to execute:

npm install some-package

risk: MEDIUM

reason:
required dependency for requested feature

[ Approve ] [ Reject ]
```

---

# 9. public/private bot

configuration:

```env
BOT_ACCESS_MODE=owner
OWNER_IDS=123456789
```

mode:

```text
owner
private
public
allowlist
```

### owner

hanya:

```env
OWNER_IDS=123456789,987654321
```

### allowlist

```env
ALLOWED_USER_IDS=
ALLOWED_CHAT_IDS=
```

### public

siapa pun dapat mengakses bot.

tetapi public mode wajib memiliki:

```text
rate limit
quota
sandbox
workspace isolation
resource limit
concurrency limit
abuse detection
```

---

# 10. security boundary

ini sangat penting.

jangan menjalankan shell agent langsung sebagai root.

architecture production:

```text
Telegram
   ↓
Agent API
   ↓
Sandbox Manager
   ↓
Container
   ↓
Agent
```

setiap workspace idealnya:

```text
container/project/
```

dengan:

```text
CPU limit
RAM limit
disk limit
process limit
network policy
timeout
filesystem boundary
```

contoh:

```yaml
sandbox:
  runtime: docker
  memory: 4g
  cpus: 2
  pidsLimit: 256
  timeout: 30m

network:
  enabled: true
```

---

# 11. workspace management

agent harus mengetahui workspace aktif secara otomatis.

misalnya backend:

```text
/workspaces/
├── project-a/
├── project-b/
└── project-c/
```

user dapat mengatakan:

```text
kerjakan project website portfolio
```

agent mencari workspace yang sesuai.

atau:

```text
buka project 9router
```

agent memilih:

```text
/workspaces/9router
```

workspace metadata:

```ts
interface Workspace {
  id: string
  name: string
  path: string
  git?: GitInfo
  createdAt: Date
  updatedAt: Date
}
```

---

# 12. filesystem tools

minimum:

```text
read_file
write_file
edit_file
delete_file
move_file
copy_file

list_directory
find_files
glob
grep
search_code

file_exists
file_info
```

agent harus memiliki context awareness.

jangan membaca seluruh repository secara membabi buta.

gunakan:

```text
tree
search
targeted reads
dependency graph
git diff
```

---

# 13. shell / PTY

ini bagian penting supaya CLI benar-benar usable.

jangan hanya:

```ts
child_process.exec()
```

gunakan PTY layer.

contoh:

```text
node-pty
```

architecture:

```text
Agent
 ↓
PTY Manager
 ↓
PTY Process
 ↓
stdout/stderr
 ↓
event parser
 ↓
Telegram
```

support:

```text
interactive stdin
stdout
stderr
exit code
signals
Ctrl+C
environment variables
working directory
long-running process
streaming output
```

sehingga agent dapat menjalankan:

```text
npm
pnpm
yarn
bun
python
pip
git
cargo
go
java
gradle
maven
docker
```

dan command lainnya yang tersedia di environment.

---

# 14. interactive CLI compatibility

target compatibility:

```text
OpenCode
Codex CLI
Claude Code
Gemini CLI
Aider
custom CLI agents
```

jangan mengasumsikan semua CLI punya interface yang sama.

buat adapter:

```ts
interface CLIAdapter {
  id: string

  detect(): Promise<boolean>

  start(options: StartOptions): Promise<PTYSession>

  sendInput(input: string): Promise<void>

  interrupt(): Promise<void>

  stop(): Promise<void>

  parseOutput(output: string): AgentEvent[]
}
```

adapter:

```text
OpenCodeAdapter
CodexAdapter
ClaudeCodeAdapter
GeminiAdapter
GenericCLIAdapter
```

---

# 15. agent runtime abstraction

core interface:

```ts
interface AgentRuntime {
  initialize(context: AgentContext): Promise<void>

  run(input: string): AsyncIterable<AgentEvent>

  interrupt(): Promise<void>

  pause(): Promise<void>

  resume(): Promise<void>

  shutdown(): Promise<void>
}
```

implementasi:

```text
NativeRuntime
OpenCodeRuntime
CodexRuntime
ClaudeRuntime
GenericCLIRuntime
```

dengan begitu Telegram tidak peduli agent yang digunakan.

---

# 16. provider abstraction

jangan hardcode 9router.

```ts
interface LLMProvider {
  id: string
  name: string

  chat(
    request: ChatRequest
  ): AsyncIterable<LLMEvent>
}
```

support:

```text
OpenAI
Anthropic
xAI
Google
Ollama
OpenRouter
9router
custom OpenAI-compatible
```

generic provider:

```env
PROVIDER_NAME=custom
PROVIDER_BASE_URL=https://example.com/v1
PROVIDER_API_KEY=
PROVIDER_MODEL=
```

---

# 17. `.env`

minimum:

```env
# telegram
TELEGRAM_BOT_TOKEN=

# access
BOT_ACCESS_MODE=owner
OWNER_IDS=

# agent
DEFAULT_AGENT=auto
DEFAULT_MODEL=auto
DEFAULT_PROVIDER=9router

# 9router
NINEROUTER_BASE_URL=http://localhost:20128/v1
NINEROUTER_API_KEY=

# openai compatible
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=

# xAI
XAI_BASE_URL=https://api.x.ai/v1
XAI_API_KEY=

# anthropic
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=

# ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama

# workspace
WORKSPACE_ROOT=/workspaces

# sandbox
SANDBOX_ENABLED=true

# database
DATABASE_URL=./data/teleagent.db

# logging
LOG_LEVEL=info
```

secret tidak boleh dikirim ke Telegram.

---

# 18. config hierarchy

prioritas:

```text
environment
↓
config file
↓
provider defaults
↓
system defaults
```

per-user override:

```text
user settings
↓
session settings
↓
workspace settings
↓
global settings
```

---

# 19. persistent database

gunakan SQLite untuk single-node deployment.

production multi-instance:

```text
PostgreSQL
```

tables:

```text
users
chats
sessions
messages
agent_runs
tool_calls
approvals
workspaces
providers
models
settings
usage
audit_logs
```

session:

```ts
interface Session {
  id: string
  userId: string
  chatId: string
  workspaceId: string
  provider: string
  model: string
  runtime: string
  status: string
}
```

---

# 20. conversation persistence

jika server restart:

```text
agent state
workspace
conversation
tool history
pending approvals
```

harus bisa dipulihkan.

contoh:

```text
server restarted.

restoring session...

workspace: 9router
task: refactor authentication
last state: testing

resuming...
```

---

# 21. context management

jangan memasukkan seluruh conversation ke model selamanya.

gunakan:

```text
short-term context
long-term session summary
workspace index
tool history
git state
important decisions
```

context manager:

```ts
interface ContextManager {
  buildContext(session: Session): Promise<AgentContext>

  summarize(messages: Message[]): Promise<string>

  compact(session: Session): Promise<void>
}
```

---

# 22. skills system

support skill directory:

```text
skills/
├── coding/
├── debugging/
├── git/
├── frontend/
├── backend/
├── python/
├── node/
├── android/
├── docker/
└── custom/
```

skill:

```yaml
name: debugging
description: systematic debugging workflow

instructions: |
  inspect logs
  reproduce issue
  identify root cause
  patch
  test
  verify
```

agent memilih skill berdasarkan task.

user tidak perlu memanggil skill secara manual.

---

# 23. tool discovery

agent memiliki tool registry:

```text
filesystem
shell
git
search
browser
http
docker
process
database
package-manager
```

tool harus memiliki schema.

LLM hanya melihat tools yang tersedia.

---

# 24. browser tool

optional tetapi architecture harus mendukung:

```text
navigate
click
type
extract
screenshot
```

gunakan browser worker terisolasi.

agent dapat mengatakan:

```text
cek dokumentasi library ini
```

dan browser/search tool digunakan jika tersedia.

---

# 25. network tool

support:

```text
HTTP GET
POST
REST API
download
documentation search
```

dengan SSRF protection.

block:

```text
localhost
127.0.0.1
169.254.169.254
private networks
```

kecuali explicit trusted policy.

---

# 26. git integration

agent harus memahami:

```text
git status
git diff
git log
git branch
git checkout
git add
git commit
git push
git pull
```

contoh final:

```text
✅ completed

commit:
a8f31d2 fix: repair authentication middleware

changed:
7 files

tests:
24 passed

build:
successful
```

git push harus approval secara default.

---

# 27. error recovery

agent tidak boleh berhenti pada error pertama.

workflow:

```text
command failed
↓
capture stderr
↓
classify error
↓
inspect relevant files
↓
generate fix
↓
apply fix
↓
rerun
```

max retry:

```env
AGENT_MAX_RETRIES=5
```

retry strategy:

```text
same command
↓
diagnostic command
↓
targeted fix
↓
verification
```

setelah retry limit:

```text
❌ unable to complete automatically

attempts: 5

root cause:
...

last error:
...

recommended next step:
...
```

---

# 28. Telegram status engine

event:

```ts
type AgentEvent =
  | ThinkingEvent
  | ToolStartEvent
  | ToolOutputEvent
  | FileChangeEvent
  | CommandEvent
  | TestEvent
  | ApprovalEvent
  | ErrorEvent
  | CompletedEvent
```

Telegram renderer:

```ts
interface TelegramRenderer {
  render(event: AgentEvent): Promise<void>
}
```

jangan expose internal chain-of-thought.

Telegram hanya menerima operational progress:

```text
🧠 analyzing
🔎 searching files
🛠 editing
▶️ running tests
❌ command failed
🔧 fixing
✅ verified
```

---

# 29. live logs

user dapat membuka detail dari inline button:

```text
[ Details ]
```

yang menampilkan:

```text
tool:
shell

status:
completed

duration:
3.8s

exit code:
0
```

jangan mengirim raw log besar ke chat.

gunakan pagination / document attachment.

---

# 30. large output handling

Telegram message limit tidak boleh menyebabkan crash.

renderer:

```text
< 3500 chars
→ message

> 3500 chars
→ truncate + file

very large output
→ .txt attachment
```

code diff:

```text
small diff
→ Telegram

large diff
→ document
```

---

# 31. files

agent dapat mengirim:

```text
.zip
.patch
.diff
.log
.txt
.json
```

dan menerima:

```text
.zip
.tar.gz
.py
.js
.ts
.md
```

workflow:

```text
user uploads project.zip
↓
sandbox
↓
extract
↓
workspace
↓
agent analyzes
```

archive extraction wajib mencegah path traversal.

---

# 32. concurrency

satu chat default:

```text
1 active agent run
```

user dapat mengirim pesan baru ketika agent bekerja.

behavior:

```text
current task running

new message:
"stop, jangan lanjut bagian database"
```

agent harus menginterpretasikan itu sebagai control/update, bukan membuat task kedua.

global:

```env
MAX_CONCURRENT_RUNS=10
```

---

# 33. cancellation

Telegram:

```text
[ Stop ]
```

harus:

```text
cancel model generation
↓
interrupt tool
↓
SIGINT
↓
SIGTERM
↓
SIGKILL
```

dengan graceful timeout.

---

# 34. pause/resume

support:

```text
pause
resume
```

agent state disimpan.

---

# 35. multi-user isolation

setiap user:

```text
user
 ↓
chat
 ↓
session
 ↓
workspace
 ↓
sandbox
```

user A tidak boleh mengakses:

```text
user B workspace
user B session
user B files
user B secrets
```

---

# 36. owner mode

default production:

```env
BOT_ACCESS_MODE=owner
```

owner IDs wajib.

tambahkan authorization middleware di **setiap** endpoint/tool, bukan hanya Telegram handler.

---

# 37. audit logging

catat:

```text
user
chat
session
timestamp
tool
arguments hash
risk level
approval
result
exit code
duration
```

secret harus redacted.

contoh:

```text
api_key=********
token=********
password=********
```

---

# 38. secret management

jangan pernah memasukkan:

```text
.env
API keys
SSH private keys
Telegram token
credentials
```

ke LLM context kecuali policy secara eksplisit mengizinkan.

default:

```text
.env → protected
.ssh → protected
.git/config → protected
credentials → protected
```

---

# 39. environment isolation

setiap agent run mendapatkan:

```text
HOME
PATH
WORKSPACE
TEMP
```

yang terkontrol.

jangan menggunakan host environment secara penuh.

---

# 40. production deployment

support:

```text
Docker
Docker Compose
VPS
Linux server
Codespaces
Kubernetes
```

minimum compose:

```text
teleagent
postgres
redis
sandbox-worker
```

redis digunakan untuk:

```text
queue
locks
events
distributed state
```

single-node dapat:

```text
SQLite
in-memory queue
```

---

# 41. architecture

repository:

```text
teleagent/
│
├── apps/
│   ├── bot/
│   ├── worker/
│   └── api/
│
├── packages/
│   ├── agent-core/
│   ├── provider-core/
│   ├── tool-core/
│   ├── runtime-core/
│   ├── telegram/
│   ├── sandbox/
│   ├── workspace/
│   ├── security/
│   ├── database/
│   └── config/
│
├── skills/
│
├── migrations/
│
├── tests/
│
├── docker/
│
├── scripts/
│
├── .env.example
├── docker-compose.yml
├── package.json
└── README.md
```

---

# 42. recommended stack

kalau implementasinya Node.js/TypeScript:

```text
Node.js
TypeScript
grammY
Fastify
Zod
Drizzle ORM
SQLite/PostgreSQL
Redis
node-pty
Docker
Pino
Vitest
```

agent runtime jangan terlalu bergantung kepada framework Telegram.

---

# 43. API internal

REST:

```text
POST /v1/sessions
GET  /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/messages
POST /v1/sessions/:id/stop
POST /v1/sessions/:id/pause
POST /v1/sessions/:id/resume

GET /v1/workspaces
POST /v1/workspaces

GET /v1/providers
GET /v1/models

GET /v1/runs/:id
GET /v1/runs/:id/events
```

WebSocket:

```text
/v1/ws/sessions/:id
```

---

# 44. OpenAI-compatible gateway

backend sendiri sebaiknya juga expose:

```text
POST /v1/chat/completions
```

sehingga aplikasi lain dapat menggunakan agent.

contoh:

```env
TELEAGENT_API_KEY=
```

request:

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "user",
      "content": "fix the build"
    }
  ]
}
```

---

# 45. provider routing

support routing:

```text
model:
auto
```

router:

```text
task classifier
↓
coding task
↓
preferred model
↓
fallback model
```

configuration:

```yaml
routing:
  auto:
    primary: 9router/auto
    fallback:
      - openai/coding-model
      - xai/model
      - ollama/local-model
```

jika provider gagal:

```text
timeout
→ retry
→ fallback
```

tetapi jangan silently berpindah provider jika user memiliki policy yang melarangnya.

---

# 46. model health checking

startup:

```text
checking Telegram ........ OK
checking database ........ OK
checking provider ........ OK
checking sandbox ......... OK
checking workspace ....... OK
```

`doctor` internal endpoint/UI harus memeriksa:

```text
Telegram token
provider
API endpoint
model
database
Docker
PTY
filesystem
permissions
workspace
```

---

# 47. startup output

contoh:

```text
TELEAGENT v1.0.0

telegram       ✓
database       ✓
sandbox        ✓
pty            ✓

provider:
9router

model:
auto

access:
OWNER ONLY

workspace:
/workspaces

agent:
READY
```

---

# 48. health endpoint

```text
GET /health
GET /ready
GET /metrics
```

response:

```json
{
  "status": "ok",
  "telegram": true,
  "database": true,
  "sandbox": true,
  "provider": true
}
```

---

# 49. observability

metrics:

```text
agent_runs_total
agent_runs_success
agent_runs_failed
agent_run_duration
tool_calls_total
tool_failures
provider_requests
provider_errors
tokens_used
telegram_messages
sandbox_processes
```

logs JSON:

```json
{
  "level": "info",
  "event": "tool.completed",
  "tool": "shell",
  "duration": 2380,
  "exitCode": 0
}
```

---

# 50. rate limiting

per user:

```text
messages/minute
runs/hour
tokens/day
CPU/minute
storage
```

configurable:

```env
RATE_LIMIT_MESSAGES=30
RATE_LIMIT_RUNS=10
MAX_DAILY_TOKENS=1000000
```

---

# 51. cost control

track:

```text
input tokens
output tokens
estimated cost
provider
model
duration
```

user dapat melihat summary otomatis:

```text
task completed

model: auto
duration: 4m 21s
tokens: 42.8k
tools: 18
files changed: 11
```

---

# 52. memory

dua level:

```text
session memory
workspace memory
```

workspace memory dapat menyimpan:

```text
project architecture
preferred package manager
test command
build command
important constraints
known issues
```

jangan menyimpan secrets.

---

# 53. project intelligence

saat workspace pertama kali dibuka:

```text
detect:
package.json
pyproject.toml
Cargo.toml
go.mod
pom.xml
build.gradle
composer.json
```

kemudian:

```text
language
framework
package manager
test runner
build command
lint command
git status
```

agent memperoleh project profile.

---

# 54. automatic verification

setelah code change:

```text
format
↓
typecheck
↓
lint
↓
test
↓
build
```

sesuaikan dengan project.

jangan menjalankan command yang tidak relevan.

---

# 55. definition of done

task hanya dianggap selesai jika:

```text
requested changes implemented
+
relevant verification completed
+
no unresolved critical error
```

final response:

```text
✅ completed

implemented:
- ...
- ...

changed:
- file1
- file2

verification:
✓ typecheck
✓ tests
✓ build

git:
3 files changed
```

---

# 56. failure response

jangan:

```text
error.
```

harus:

```text
⚠️ task incomplete

what happened:
...

what was attempted:
...

last error:
...

what remains:
...

workspace is left in:
...
```

---

# 57. crash recovery

worker crash:

```text
worker heartbeat lost
↓
detect
↓
restore session
↓
recover workspace
↓
mark interrupted tool
↓
resume or ask user
```

jangan menjalankan kembali command destructive secara otomatis setelah crash.

---

# 58. duplicate message protection

Telegram update bisa duplicate.

gunakan:

```text
update_id
```

dan database idempotency.

```text
processed_updates
```

---

# 59. Telegram reliability

implement:

```text
retry
exponential backoff
429 handling
network timeout
reconnect
webhook recovery
```

production gunakan webhook:

```text
POST /telegram/webhook
```

bukan polling sebagai default production.

---

# 60. webhook security

gunakan:

```text
secret token
```

dan validasi Telegram update.

---

# 61. file upload security

validasi:

```text
filename
mime
size
archive structure
path traversal
symlink
zip bomb
```

limits:

```env
MAX_UPLOAD_MB=100
MAX_EXTRACTED_MB=500
```

---

# 62. process security

block atau approval:

```text
shutdown
reboot
mkfs
disk operations
firewall changes
user creation
credential extraction
host filesystem access
```

sandbox harus tetap membatasi kemampuan tersebut meskipun model mencoba menjalankannya.

---

# 63. no fake tool execution

agent event:

```text
tool.started
```

hanya boleh dikirim setelah tool benar-benar dipanggil.

```text
tool.completed
```

hanya setelah result diterima.

jangan menghasilkan status palsu dari model.

---

# 64. deterministic tool layer

LLM:

```text
"run tests"
```

tool executor menentukan command sebenarnya.

misalnya:

```text
package.json
scripts.test = vitest run
```

maka:

```text
pnpm test
```

bukan model mengarang command.

---

# 65. command safety parser

sebelum shell execution:

```text
parse
→ normalize
→ classify
→ policy
→ approval
→ execute
```

command:

```text
rm -rf /
```

tidak boleh lolos hanya karena model menganggapnya perlu.

---

# 66. agent prompt architecture

system prompt harus menjelaskan:

```text
you are an autonomous software engineering agent.

you have access to tools.

never claim a tool was used unless it actually was.

inspect before modifying.

make minimal changes.

verify changes.

recover from failures.

never expose secrets.

respect workspace boundaries.

ask for approval when required.

do not stop merely because the first attempt failed.
```

---

# 67. tool result normalization

semua tool mengembalikan:

```ts
interface ToolResult {
  success: boolean
  output?: string
  error?: string

  metadata?: {
    duration?: number
    exitCode?: number
    filesChanged?: string[]
  }
}
```

---

# 68. Telegram renderer rules

model output:

```text
thinking
```

tidak perlu dikirim sebagai raw chain-of-thought.

ubah menjadi operational status:

```text
🧠 analyzing request
```

tool:

```text
read_file
```

menjadi:

```text
📖 reading src/auth.ts
```

shell:

```text
▶️ running npm test
```

edit:

```text
🛠 modifying src/auth.ts
```

---

# 69. natural-language settings

karena tidak ingin command, settings juga natural language.

user:

```text
mulai sekarang pakai minimax
```

agent:

```text
model preference updated:
cbai/minimax-m3
```

user:

```text
jangan pernah push git tanpa persetujuan gue
```

agent:

```text
policy updated:
git push → approval required
```

user:

```text
ubah bot jadi owner only
```

backend mengubah setting setelah authorization.

untuk perubahan security-sensitive, minta confirmation.

---

# 70. Telegram settings UI

tambahkan tombol:

```text
⚙️ Settings

Model
Provider
Agent
Workspace
Permissions
Sandbox
Memory
Notifications
Access
```

semua memakai inline keyboard / WebApp.

---

# 71. multi-agent

architecture mendukung:

```text
primary agent
research agent
coding agent
review agent
test agent
```

contoh:

```text
user:
review project ini dan perbaiki semua issue yang ditemukan
```

orchestrator:

```text
research
 ↓
coding
 ↓
testing
 ↓
review
```

tetapi jangan langsung mengaktifkan multi-agent jika resource tidak cukup.

---

# 72. agent profiles

contoh:

```yaml
agents:
  coding:
    provider: 9router
    model: auto
    tools:
      - filesystem
      - shell
      - git

  reviewer:
    provider: openai
    model: reviewer-model
    tools:
      - filesystem
      - git
```

---

# 73. plugin architecture

third-party tools:

```ts
interface AgentPlugin {
  id: string
  name: string

  register(context: PluginContext): Promise<void>
}
```

sehingga dapat menambahkan:

```text
GitHub
GitLab
Vercel
Cloudflare
Docker
Kubernetes
Figma
database
browser
```

tanpa mengubah core.

---

# 74. GitHub integration

optional OAuth/token.

agent dapat:

```text
create branch
create commit
create PR
inspect issues
review PR
```

default:

```text
read → allowed
write → approval
merge → approval
```

---

# 75. production test matrix

wajib test:

```text
Telegram connection
provider connection
model fallback
session persistence
workspace isolation
shell execution
PTY
Ctrl+C
long-running process
file editing
git
test execution
build failure recovery
approval
rate limiting
restart recovery
large output
large files
zip extraction
malicious paths
concurrent users
duplicate Telegram updates
429 handling
provider timeout
provider 500
database failure
worker crash
```

---

# 76. acceptance test

scenario:

```text
user:
"buatkan REST API sederhana di project ini,
pakai TypeScript, tambahkan test, jalankan test,
dan perbaiki sampai semuanya pass."
```

expected:

```text
agent detects project
↓
inspects package manager
↓
creates plan
↓
creates files
↓
installs dependency if required
↓
runs tests
↓
detects failures
↓
fixes
↓
runs tests again
↓
builds
↓
returns summary
```

tidak ada command Telegram yang diperlukan.

---

# 77. second acceptance test

```text
user:
"cek kenapa build project ini gagal."
```

agent:

```text
inspect
→ reproduce
→ diagnose
→ patch
→ build
→ verify
```

---

# 78. third acceptance test

```text
user:
"stop."
```

agent harus:

```text
cancel generation
interrupt PTY
terminate active process
persist state
```

---

# 79. fourth acceptance test

server restart ketika task sedang berjalan.

expected:

```text
worker recovery
session recovery
workspace recovery
safe state recovery
```

dan bukan:

```text
duplicate commands
duplicate commits
duplicate installs
```

---

# 80. project quality gates

sebelum release:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

harus zero:

```text
TypeScript errors
unhandled promise rejections
known race conditions
secret leakage
```

---

# 81. deployment modes

### development

```text
SQLite
polling
local workspace
sandbox optional
```

### production single server

```text
PostgreSQL/SQLite
Redis
webhook
Docker sandbox
persistent volumes
```

### production scale

```text
load balancer
bot gateway
Redis
PostgreSQL
multiple workers
sandbox worker pool
```

---

# 82. docker architecture

```text
                    ┌───────────────┐
Telegram ──────────►│ Bot Gateway   │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │ Agent Worker   │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │ Sandbox Pool  │
                    └───────────────┘

                    ┌───────────────┐
                    │ PostgreSQL    │
                    └───────────────┘

                    ┌───────────────┐
                    │ Redis         │
                    └───────────────┘
```

---

# 83. required `.env.example`

repository wajib menyertakan:

```env
TELEGRAM_BOT_TOKEN=

BOT_ACCESS_MODE=owner
OWNER_IDS=

DEFAULT_PROVIDER=9router
DEFAULT_MODEL=auto
DEFAULT_AGENT=auto

NINEROUTER_BASE_URL=http://localhost:20128/v1
NINEROUTER_API_KEY=

OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=

XAI_BASE_URL=https://api.x.ai/v1
XAI_API_KEY=

ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=

OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama

WORKSPACE_ROOT=/workspaces

DATABASE_URL=./data/teleagent.db
REDIS_URL=redis://localhost:6379

SANDBOX_ENABLED=true
MAX_CONCURRENT_RUNS=5
AGENT_MAX_RETRIES=5

MAX_UPLOAD_MB=100
MAX_OUTPUT_MB=10

LOG_LEVEL=info
```

---

# 84. install experience

target:

```bash
git clone <repo>
cd teleagent
cp .env.example .env
npm install
npm run setup
npm run dev
```

production:

```bash
docker compose up -d
```

kemudian bot langsung:

```text
🤖 TeleAgent

status: ready

send me anything.
```

---

# 85. first-run wizard

ketika belum dikonfigurasi:

```text
🤖 TeleAgent setup

Telegram: ✓
Database: ✓

Provider: not configured

Choose provider:

[ 9Router ]
[ OpenAI ]
[ xAI ]
[ Ollama ]
[ Custom /v1 ]
```

setelah memilih:

```text
API endpoint:
[ ... ]

API key:
[ ... ]

Model:
[ ... ]

[ Test Connection ]
```

jangan memaksa user mengedit config manual jika Telegram UI bisa mengaturnya.

`.env` tetap menjadi sumber konfigurasi deployment.

---

# 86. custom `/v1` provider

user memasukkan:

```text
endpoint:
https://example.com/v1

api key:
sk-xxxx

model:
my-model
```

system otomatis membuat:

```ts
OpenAICompatibleProvider
```

jadi provider baru tidak membutuhkan code baru.

---

# 87. fallback

jika:

```text
provider timeout
```

system:

```text
retry #1
↓
retry #2
↓
fallback provider
```

Telegram:

```text
⚠️ primary provider unavailable

switching to configured fallback...
```

---

# 88. no silent data loss

sebelum destructive operation:

```text
snapshot
```

optional:

```text
git checkpoint
```

sehingga agent dapat rollback.

---

# 89. checkpoint system

sebelum perubahan besar:

```text
workspace snapshot
```

metadata:

```text
run_id
commit
changed_files
timestamp
```

jika agent gagal:

```text
restore checkpoint
```

berdasarkan policy.

---

# 90. final UX

user experience harus terasa seperti:

```text
user
 ↓
"benerin project ini"
 ↓
agent
 ↓
understands
 ↓
uses tools
 ↓
works
 ↓
tests
 ↓
fixes
 ↓
verifies
 ↓
reports
```

bukan seperti:

```text
user
 ↓
/run npm test
 ↓
/approve
 ↓
/read file
 ↓
/edit
```

---

## 91. definition of production-ready

project tidak boleh dianggap selesai hanya karena bot bisa membalas Telegram.

production-ready berarti:

```text
✓ natural-language interface
✓ persistent sessions
✓ multi-provider
✓ generic /v1 support
✓ model selection
✓ autonomous tool execution
✓ filesystem tools
✓ shell + PTY
✓ git
✓ test/build
✓ CLI adapters
✓ OpenCode support
✓ Codex support
✓ Claude Code support
✓ generic CLI support
✓ skills
✓ browser-ready architecture
✓ sandbox
✓ approval system
✓ owner/public mode
✓ multi-user isolation
✓ rate limiting
✓ audit log
✓ secret protection
✓ crash recovery
✓ provider fallback
✓ Telegram streaming status
✓ large output handling
✓ upload handling
✓ database persistence
✓ health checks
✓ metrics
✓ Docker deployment
✓ automated tests
✓ graceful shutdown
✓ restart recovery
```

satu hal yang perlu dibuat eksplisit di implementasinya: **“full seperti CLI” berarti capability parity semaksimal mungkin, bukan memaksa semua perilaku terminal mentah masuk ke Telegram.** misalnya interactive TUI/editor yang memang membutuhkan layar terminal harus ditangani lewat PTY + adapter atau diubah menjadi UI Telegram/WebApp. Dengan desain ini, OpenCode/Codex/Claude dan CLI lain tetap bisa menjadi execution backend tanpa Telegram harus meniru terminal secara literal.

kalau PRD ini diberikan ke coding agent, instruksi implementasinya sebaiknya **“build the entire repository, not just scaffold it”**: generate source code, migrations, Docker Compose, `.env.example`, tests, adapters, sandbox, Telegram UI, provider abstraction, README, dan jalankan seluruh test/build sebelum menyatakan selesai.
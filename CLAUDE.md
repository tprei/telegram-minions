# telegram-minions — Claude guidance

## Secret and token safety

**Never read, log, print, or include `.env` contents in any output, commit, or message.**

- `.env` is gitignored. Never stage or commit it under any name.
- Never echo `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, or any credential value.
- Use `.env.example` with placeholder values as the only committed secrets template.

## Project overview

Telegram-controlled Goose coding agents on fly.io. The Dispatcher polls Telegram for `/task` commands, spawns Goose sessions for each task, and the Observer streams Goose events back to Telegram forum topics.

## Key files

| File | Purpose |
|---|---|
| `src/main.ts` | Entry point — starts Dispatcher with SIGTERM/SIGINT handlers |
| `src/dispatcher.ts` | Telegram poll loop, `/task` parsing, session lifecycle |
| `src/session.ts` | SessionHandle — wraps a single `goose run` subprocess |
| `src/observer.ts` | Translates Goose stream-json events to Telegram messages |
| `src/telegram.ts` | Telegram Bot API client (sendMessage, editMessage, topics) |
| `src/format.ts` | HTML message formatters for Telegram |
| `src/config.ts` | Centralized config from env vars |
| `src/slugs.ts` | Deterministic adjective-noun slug generator |
| `src/types.ts` | TypeScript types for Goose events and Telegram API |
| `src/ci-babysit.ts` | CI polling, failure log parsing, fix prompt builder |
| `goose/config.yaml` | Goose agent configuration (mode, extensions, limits) |
| `.claude/agents/post-task-router.md` | Haiku classifier — routes completed work to the right action |
| `.claude/agents/ci-fix.md` | CI fix specialist — diagnoses and fixes CI failures |
| `.claude/agents/git-commit-specialist.md` | Git workflow — commits, pushes, opens PRs |
| `.claude/agents/explorer.md` | Read-only codebase exploration |
| `.claude/agents/planner.md` | Implementation planning |
| `.claude/agents/technical-architect.md` | System architecture design |

## Claude authentication (ACP provider)

Sessions use `GOOSE_PROVIDER=claude-acp` which delegates to your Claude Code subscription — no API key needed. It wraps `@zed-industries/claude-agent-acp` which calls the `claude` CLI.

**Local setup (one time):**
```sh
npm install -g @zed-industries/claude-agent-acp
claude auth login    # opens browser, authorizes your Claude subscription
```

Credentials persist at `~/.claude/.credentials.json`.

**Fly.io setup (one time after first deploy):**
```sh
fly ssh console
claude auth login    # paste URL into local browser to authorize
```

Credentials write to `/workspace/home/.claude/` (HOME=/workspace/home in fly.toml) and persist across redeploys on the volume.

## Development

```sh
npm install
npm run typecheck        # type check
npm run dev              # run directly with tsx (requires .env)
npm run build            # compile to dist/
```

## Command format

### Task (one-shot execution)
```
/task https://github.com/org/repo Description of the coding task
/task repo-alias Description of the task
/task Description of the task (no repo, uses current workspace)
```

### Plan (multi-turn planning → execution)
```
/plan repo-alias Let's work on feature A
```
1. Creates a planning thread with a read-only agent that explores code and proposes a plan
2. Reply in the thread with feedback — the agent refines the plan
3. Send `/execute` to close the planning thread and spawn an execution task with the final plan
4. Or send `/split` to extract parallelizable items and spawn independent sub-minions

### Split (parallel sub-tasks from plan/think)
```
/split
/split Focus on the first two items only
```
1. Extracts discrete, parallelizable work items from the conversation using a Haiku classifier
2. Spawns N independent child sessions — each with its own forum topic, worktree, and branch
3. Each child runs as a `/task` in parallel and opens its own PR
4. The parent topic tracks children and reports aggregate status
5. Send `/close` in the parent to terminate all children

## Goose stream-json event schema

Events are one JSON object per line (NDJSON). Types:
- `{"type":"message","message":{"role":"assistant","content":[...]}}` — text and tool calls
- `{"type":"notification","extensionId":"...","message":"..."}` — MCP logs
- `{"type":"error","error":"..."}` — errors
- `{"type":"complete","total_tokens":123}` — session end

Content block types in `message.content`:
- `{"type":"text","text":"..."}` — assistant text output
- `{"type":"toolRequest","id":"...","toolCall":{"name":"...","arguments":{...}}}` — tool calls
- `{"type":"toolResponse","id":"...","toolResult":{...}}` — tool results

## MCP servers

All MCPs are installed globally in the Docker image and enabled by default via env vars. Each can be toggled independently.

| MCP | Env var | Purpose | Requirements |
|---|---|---|---|
| **Playwright** | `ENABLE_BROWSER_MCP` | Headless Chromium for web browsing | Pre-installed browsers at `PLAYWRIGHT_BROWSERS_PATH` |
| **GitHub** | `ENABLE_GITHUB_MCP` | PRs, issues, reviews, code search via GitHub API | `GITHUB_TOKEN` must be set (logs warning if missing) |
| **Context7** | `ENABLE_CONTEXT7_MCP` | Up-to-date library/framework documentation lookup | None (uses public docs) |
| **Sentry** | `ENABLE_SENTRY_MCP` | Error tracking, issue search, stack traces via Sentry API | `SENTRY_ACCESS_TOKEN` must be set as a Fly secret. Optional: `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_SLUG` to scope queries |
| **Z.AI Web Search** | `ENABLE_ZAI_MCP` | Web search, real-time information | `ZAI_API_KEY` required. **Only enabled when `GOOSE_PROVIDER=z-ai`** |

MCP config is built dynamically in `src/session.ts` via `buildMcpServers()`. For Goose sessions it generates `--with-extension` flags; for Claude sessions it generates `--mcp-config` JSON. If an MCP's prerequisites aren't met (e.g., missing `GITHUB_TOKEN`), it's skipped with a stderr warning rather than crashing.

## Session environment passthrough

By default, minion sessions run in an isolated environment with only essential vars (`PATH`, `HOME`, etc.) and a few hardcoded secrets (`GITHUB_TOKEN`, `SENTRY_ACCESS_TOKEN`). To pass additional secrets to sessions, use the explicit passthrough list.

### Via environment variable (CLI/Fly.io)

```sh
# Set the env var with a comma-separated list of var names to pass through
fly secrets set SESSION_ENV_PASSTHROUGH="MY_API_KEY,DATABASE_URL,CUSTOM_SECRET_TOKEN"
```

### As a library user

```typescript
import { createMinion, configFromEnv } from 'telegram-minions'

const config = configFromEnv({
  sessionEnvPassthrough: [
    'MY_API_KEY',
    'DATABASE_URL',
    'CUSTOM_SECRET_TOKEN',
  ]
})

createMinion(config).start()
```

Only vars that exist in the parent process environment will be passed through. Missing vars are silently skipped.

## Fly.io deployment

```sh
# Secrets — no ANTHROPIC_API_KEY needed when using claude-acp
fly secrets set \
  TELEGRAM_BOT_TOKEN=... \
  TELEGRAM_CHAT_ID=... \
  ALLOWED_USER_IDS=... \
  GITHUB_TOKEN=... \
  SENTRY_ACCESS_TOKEN=sntrys_...

# Optional: scope Sentry to a specific org/project (set in fly.toml [env] or as secrets)
# SENTRY_ORG_SLUG=your-org
# SENTRY_PROJECT_SLUG=your-project

# Create persistent volume (stores cloned repos + claude auth)
fly volumes create workspace_data --size 10

fly deploy

# Authenticate Claude after first deploy (one time)
fly ssh console
# inside the machine:
claude auth login   # paste URL into local browser
```

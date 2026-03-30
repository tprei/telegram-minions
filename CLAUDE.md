# telegram-minions — Claude guidance

## Secret and token safety

**Never read, log, print, or include `.env` contents in any output, commit, or message.**

- `.env` is gitignored. Never stage or commit it under any name.
- Never echo `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, or any credential value.
- Use `.env.example` with placeholder values as the only committed secrets template.

## Project overview

Telegram-controlled AI coding agents on fly.io. The Dispatcher polls Telegram for commands (`/task`, `/plan`, `/think`, `/review`, `/ship`), spawns Claude or Goose sessions, and the Observer streams events back to Telegram forum topics. Also available as an npm package (`telegram-minions`) for programmatic use.

## Key files

### Core

| File | Purpose |
|---|---|
| `src/main.ts` | Entry point — starts Dispatcher with SIGTERM/SIGINT handlers |
| `src/minion.ts` | `createMinion()` factory — top-level API for library consumers |
| `src/dispatcher.ts` | Telegram poll loop, command routing, session lifecycle |
| `src/session.ts` | SessionHandle — wraps a single `claude` or `goose run` subprocess |
| `src/observer.ts` | Translates stream-json events to Telegram messages |
| `src/telegram.ts` | Telegram Bot API client (sendMessage, editMessage, topics) |
| `src/format.ts` | HTML message formatters for Telegram |
| `src/index.ts` | Public npm package exports |
| `src/types.ts` | TypeScript types (SessionMode, ShipPhase, AutoAdvance, events) |
| `src/errors.ts` | Custom error classes (ConfigError, ConfigFormatError) |

### Configuration

| File | Purpose |
|---|---|
| `src/config-types.ts` | TypeScript interfaces for all config (`MinionConfig`, etc.) |
| `src/config-env.ts` | `configFromEnv()` — builds config from environment variables |
| `src/config-validator.ts` | Config validation with typed error reporting |
| `src/config-manager.ts` | Runtime config management |
| `src/profile-store.ts` | Provider profile persistence (`profiles.json`) |
| `src/prompts.ts` | Default system prompts for task, plan, think, review, ship phases |

### Commands and routing

| File | Purpose |
|---|---|
| `src/command-parser.ts` | Command prefix constants and argument parsing |
| `src/command-router.ts` | Routes incoming Telegram messages to typed `RoutedCommand` |
| `src/cli.ts` | CLI entry point for `telegram-minions` binary |

### Orchestration

| File | Purpose |
|---|---|
| `src/ship-pipeline.ts` | Multi-phase ship pipeline (think → plan → dag → verify → done) |
| `src/split-orchestrator.ts` | Parallel sub-task spawning from `/split` |
| `src/dag-orchestrator.ts` | DAG execution — schedules tasks via Kahn's algorithm |
| `src/dag.ts` | DAG data model, topological sort, status rendering |
| `src/dag-extract.ts` | DAG/stack item extraction from conversations |
| `src/landing-manager.ts` | `/land` — merges PRs in topological order |
| `src/conflict-resolver.ts` | Automated merge conflict resolution via agent |
| `src/verification.ts` | Quality gates and completeness checks for ship pipeline |
| `src/quality-gates.ts` | Quality validation rules |

### Session management

| File | Purpose |
|---|---|
| `src/session-manager.ts` | Workspace prep/cleanup, branch management, worktrees |
| `src/session-log.ts` | Session event logging |
| `src/conversation-limits.ts` | Conversation length enforcement |
| `src/conversation-digest.ts` | Conversation summarization for context management |
| `src/dispatcher-context.ts` | Shared dispatcher context and state |

### CI and observability

| File | Purpose |
|---|---|
| `src/ci-babysit.ts` | CI failure log parsing, fix prompt builder |
| `src/ci-babysitter.ts` | CI polling loop, auto-retry orchestration |
| `src/claude-stream.ts` | Claude API stream event handling |
| `src/claude-usage.ts` | Token usage tracking for Claude sessions |
| `src/stats.ts` | Session and usage statistics |
| `src/sentry.ts` | Sentry error reporting integration |
| `src/logger.ts` | Structured logging |

### Supporting modules

| File | Purpose |
|---|---|
| `src/slugs.ts` | Deterministic adjective-noun slug generator |
| `src/split.ts` | Split item data types and helpers |
| `src/store.ts` | Persistent key-value store |
| `src/pinned-message-manager.ts` | Telegram pinned message lifecycle |
| `src/http-utils.ts` | HTTP request helpers |
| `src/api-server.ts` | Optional HTTP dashboard API |

### Agent definitions

| File | Purpose |
|---|---|
| `.claude/agents/post-task-router.md` | Haiku classifier — routes completed work to the right action |
| `.claude/agents/ci-fix.md` | CI fix specialist — diagnoses and fixes CI failures |
| `.claude/agents/git-commit-specialist.md` | Git workflow — commits, pushes, opens PRs |
| `.claude/agents/explorer.md` | Read-only codebase exploration |
| `.claude/agents/planner.md` | Implementation planning |
| `.claude/agents/technical-architect.md` | System architecture design |

### Other

| File | Purpose |
|---|---|
| `goose/config.yaml` | Goose agent configuration (mode, extensions, limits) |

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
npm test                 # run tests
npm run dev              # run directly with tsx (requires .env)
npm run build            # compile to dist/
```

## Command format

### Session-creating commands

#### Task (one-shot execution)
```
/task https://github.com/org/repo Description of the coding task
/task repo-alias Description of the task
/task Description of the task (no repo, uses current workspace)
```
Alias: `/w` (short form for `/task`)

#### Plan (multi-turn planning → execution)
```
/plan repo-alias Let's work on feature A
```
1. Creates a planning thread with a read-only agent that explores code and proposes a plan
2. Reply in the thread with feedback — the agent refines the plan
3. Send `/execute` to close the planning thread and spawn an execution task with the final plan
4. Or send `/split` to extract parallelizable items and spawn independent sub-minions
5. Or send `/stack` to create stacked PRs (sequential chain)
6. Or send `/dag` to create a dependency graph of tasks

#### Think (research-only exploration)
```
/think repo-alias Investigate the auth flow
/think What's the current test coverage?
```
Like `/plan` but read-only — the agent explores and reports without proposing changes. Supports the same follow-up commands (`/split`, `/stack`, `/dag`, `/execute`).

#### Review (code review)
```
/review https://github.com/org/repo 123
/review repo-alias 123
/review repo-alias
/review 123
```
Spawns a review session that examines a specific PR (by number) or all open PRs on a repo. Uses the `REVIEW_MODEL` (default: opus).

#### Ship (automated feature pipeline)
```
/ship repo-alias Build a user settings page
/ship https://github.com/org/repo Add rate limiting to the API
```
Runs a multi-phase automated pipeline:
1. **Think** — researches the codebase (read-only exploration)
2. **Plan** — produces an implementation plan
3. **DAG** — extracts work items with dependencies and schedules them
4. **Verify** — runs quality gates on completed work
5. **Done** — reports results

Each phase auto-advances to the next. The ship pipeline uses the profile selection flow if multiple provider profiles are configured.

### Thread-scoped commands

These commands are sent as replies within an active session topic.

#### Split (parallel sub-tasks from plan/think)
```
/split
/split Focus on the first two items only
```
1. Extracts discrete, parallelizable work items from the conversation using a Haiku classifier
2. Spawns N independent child sessions — each with its own forum topic, worktree, and branch
3. Each child runs as a `/task` in parallel and opens its own PR
4. The parent topic tracks children and reports aggregate status
5. Send `/close` in the parent to terminate all children

#### Stack (sequential stacked PRs from plan/think)
```
/stack
/stack Focus on the auth flow
```
1. Extracts ordered work items from the conversation using a Haiku classifier
2. Spawns child sessions sequentially — each branches from the previous one's PR branch
3. Each child opens a PR targeting the previous branch (stacked PRs)
4. Parent topic tracks progress and shows DAG status
5. Send `/land` to merge the stack bottom-up into main

#### DAG (dependency graph from plan/think)
```
/dag
/dag Only the backend items
```
1. Extracts work items with explicit dependencies using a Haiku classifier
2. Schedules tasks using Kahn's algorithm — independent tasks run in parallel
3. Fan-in nodes (multiple dependencies) merge upstream branches before starting
4. Failed nodes skip all transitive dependents
5. Send `/land` to merge completed PRs in topological order

#### Land (merge stack/DAG PRs)
```
/land
```
1. Merges completed PRs in topological order (bottom-up for stacks)
2. Uses squash merge with branch deletion
3. GitHub auto-retargets downstream PRs after each merge

#### Other thread commands

| Command | Purpose |
|---|---|
| `/execute` | Close planning thread and spawn execution task with the final plan |
| `/reply` (or `/r`) | Send follow-up feedback to the active session |
| `/retry` | Retry a failed DAG node |
| `/force` | Force-advance a DAG node |
| `/close` | Terminate session and all children |
| `/stop` | Stop the running session |

### Global commands

These commands work anywhere, no active session required.

| Command | Purpose |
|---|---|
| `/status` | Show all active sessions |
| `/stats` | Show session statistics |
| `/usage` | Show token/cost usage |
| `/clean` | Clean up stale sessions and worktrees |
| `/help` | Show available commands |

### Config (provider profile management)
```
/config                    Show current config and available profiles
/config add                Add a new provider profile
/config set <id>           Switch to a profile
/config remove <id>        Remove a profile
/config default <id>       Set the default profile
/config default clear      Clear default (prompt every time)
```
Profiles let you configure multiple AI providers (claude-acp, custom API endpoints) and switch between them. Each profile stores: `id`, `name`, `baseUrl`, `authToken`, `opusModel`, `sonnetModel`, `haikuModel`.

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
| **Supabase** | `ENABLE_SUPABASE_MCP` | Database queries, migrations, logs via Supabase API | `SUPABASE_ACCESS_TOKEN` must be set. Optional: `SUPABASE_PROJECT_REF` to scope to a specific project |
| **Z.AI Web Search** | `ENABLE_ZAI_MCP` | Web search, real-time information | Uses `ZAI_API_KEY` from z-ai provider. **Only enabled when `GOOSE_PROVIDER=z-ai`** |

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

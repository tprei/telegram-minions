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
| `src/dag.ts` | DAG data model, topological sort, scheduling, status rendering |
| `src/dag-extract.ts` | DAG/stack item extraction from conversations, child prompt building |
| `goose/config.yaml` | Goose agent configuration (mode, extensions, limits) |
| `src/inject-assets.ts` | Injects agents, skills, and goosehints into session workspaces |
| `src/config-types.ts` | TypeScript types including `AgentDefinitions` |
| `assets/agents/` | Claude agent definitions injected into workspaces |
| `assets/.claude/skills/` | Claude Code skill definitions injected into workspaces |
| `assets/.goose/skills/` | Goose skill definitions for session workspaces |
| `assets/.goosehints` | Goose project guidance injected into workspaces |
| `assets/settings.json` | Claude Code settings injected into workspaces |
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
5. Or send `/stack` to create stacked PRs (sequential chain)
6. Or send `/dag` to create a dependency graph of tasks

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

### Stack (sequential stacked PRs from plan/think)
```
/stack
/stack Focus on the auth flow
```
1. Extracts ordered work items from the conversation using a Haiku classifier
2. Spawns child sessions sequentially — each branches from the previous one's PR branch
3. Each child opens a PR targeting the previous branch (stacked PRs)
4. Parent topic tracks progress and shows DAG status
5. Send `/land` to merge the stack bottom-up into main

### DAG (dependency graph from plan/think)
```
/dag
/dag Only the backend items
```
1. Extracts work items with explicit dependencies using a Haiku classifier
2. Schedules tasks using Kahn's algorithm — independent tasks run in parallel
3. Fan-in nodes (multiple dependencies) merge upstream branches before starting
4. Failed nodes skip all transitive dependents
5. Send `/land` to merge completed PRs in topological order

### Land (merge stack/DAG PRs)
```
/land
```
1. Merges completed PRs in topological order (bottom-up for stacks)
2. Uses squash merge with branch deletion
3. GitHub auto-retargets downstream PRs after each merge

## Agent file injection

When a session starts, `injectAgentFiles()` copies bundled agents, skills, and guidance files into the session workspace. Existing files are never overwritten — the target repo's own config takes precedence.

### What gets injected

| Source | Destination | Contents |
|---|---|---|
| `assets/agents/` | `.claude/agents/` | Claude agent definitions (post-task-router, explorer, planner, etc.) |
| `assets/.claude/skills/` | `.claude/skills/` | Claude Code skills (commit, explore, review-pr, update-config) |
| `assets/templates/.claude/CLAUDE.md` | `.claude/CLAUDE.md` | Default workspace guidance |
| `assets/.goosehints` | `.goosehints` | Goose project hints (structure, commands, conventions) |
| `assets/settings.json` | `.claude/settings.json` | Claude Code environment settings (token limits, permissions) |

### Customizing via environment variables

| Env var | Purpose |
|---|---|
| `AGENTS_DIR` | Custom path to Claude agent `.md` files |
| `SKILLS_DIR` | Custom path to Claude skill `.md` files |
| `GOOSEHINTS_PATH` | Custom path to `.goosehints` file |
| `CLAUDE_MD_PATH` | Custom path to `CLAUDE.md` guidance file |

### Customizing as a library user

```typescript
import { createMinion, configFromEnv } from 'telegram-minions'

const config = configFromEnv({
  agentDefs: {
    agentsDir: './my-agents',
    skillsDir: './my-skills',
    goosehintsPath: './my-goosehints',
    claudeMd: './my-guidance.md',
    settingsJson: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16000' } },
  }
})

createMinion(config).start()
```

## Claude Code skills

Skills are slash-command shortcuts available to Claude Code sessions. They live in `assets/.claude/skills/` and are injected into `.claude/skills/` at session start.

| Skill | Purpose |
|---|---|
| `/commit` | Run quality checks, generate a session summary, and route to git specialist |
| `/explore` | Deep codebase exploration — architecture, call chains, data flow |
| `/review-pr` | Review a PR for bugs, security issues, and correctness (max 5 findings) |
| `/update-config` | Safely update config files (`.env.example`, CI, build settings) |

## Goose skills and goosehints

Goose skills live in `assets/.goose/skills/` and provide structured guidance for Goose sessions. The `.goosehints` file provides project-level context.

### Goose skills

| Skill | Purpose |
|---|---|
| `code-exploration` | Efficient code navigation — search patterns, architecture discovery |
| `pr-workflow` | Git branching, conventional commits, PR creation via `gh` |
| `testing` | Test discovery, execution order (typecheck → lint → test) |
| `ci-diagnosis` | CI failure analysis — classify, diagnose, fix root cause |
| `secure-coding` | Security best practices — secrets, input validation, shell safety |

### Goosehints

The `.goosehints` file injected into workspaces contains:
- Project structure overview (src/, test/, assets/)
- Development commands (typecheck, lint, test, build)
- Key conventions (ESM imports, conventional commits)
- Dependency and environment guidance

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

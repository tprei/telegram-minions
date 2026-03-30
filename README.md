# telegram-minions

[![npm version](https://img.shields.io/github/package-json/v/tprei/telegram-minions)](https://github.com/tprei/telegram-minions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A Telegram-based orchestration layer for autonomous coding agents. This project wraps Goose and Claude Code inside a sandboxed Docker container, allowing you to trigger codebase modifications, architectural planning, and deep research directly from a Telegram chat.

It handles session state, streams agent output back to Telegram forum topics, and automatically monitors and fixes failing CI pipelines.

Inspired by [Stripe's Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) — one-shot, end-to-end coding agents.

![telegram-minions screenshot](./docs/screenshot.png)

## Features

* **Telegram Interface**: Start, monitor, and interact with coding agents via Telegram commands and forum topics.
* **Multiple Operating Modes**:
  * **Task**: One-shot execution for standard coding tasks (via Goose).
  * **Plan**: Multi-turn, read-only exploration and planning phase. Once approved, the plan is executed (via Claude -> Goose).
  * **Think**: Deep research mode for complex technical queries (via Claude).
  * **Review**: Automated pull request review with detailed feedback (via Claude).
  * **Ship**: End-to-end feature pipeline — think, plan, build, and verify in one command (via Claude -> Goose).
* **Autonomous CI Babysitting**: Automatically monitors GitHub PR checks after a task completes. If CI fails, it parses the logs and spawns a `ci-fix` agent to resolve the issues and push updates.
* **Pre-configured MCP Servers**:
  * `Playwright`: Headless Chromium for web browsing and visual QA.
  * `GitHub`: PRs, issues, code search.
  * `Context7`: Up-to-date documentation lookup for external libraries.
  * `Sentry`: Error tracking and stack trace retrieval.
  * `Supabase`: Database queries, migrations, and logs via Supabase API.
  * `Z.AI`: Web search and real-time information (when using z-ai provider).
* **Stacked PRs & DAG Orchestration**: Chain dependent tasks as stacked PRs or arbitrary dependency graphs, then land them in topological order.
* **Workspace Isolation**: Uses Git worktrees to maintain a clean, persistent workspace for concurrent sessions without cross-contamination.
* **Provider Profiles**: Switch between Claude providers (ACP, Anthropic API, self-hosted) via `/config`.

## Prerequisites

Before deploying telegram-minions, you'll need:

1. **Telegram Bot**: Create a bot via [@BotFather](https://t.me/BotFather). Enable **Topics** (forum mode) on the group where the bot will operate. Note the bot token and chat ID.
2. **GitHub Personal Access Token**: Generate a [fine-grained PAT](https://github.com/settings/tokens?type=beta) with the following scopes:
   * `repo` — full access to repositories the bot will work on
   * `read:org` — if working with organization repos
3. **Node.js 20+** (for local development) or **Docker** (for deployment)
4. **Fly.io CLI** (optional, for cloud deployment): `curl -L https://fly.io/install.sh | sh`
5. **Claude Code CLI** (for `claude-acp` provider): `npm install -g @zed-industries/claude-agent-acp`

## How it works

```
┌─────────────┐     commands      ┌──────────────┐     spawn      ┌───────────────┐
│  Telegram    │ ───────────────> │  Dispatcher   │ ────────────> │  Session       │
│  User        │                  │  (poll loop)  │               │  (worktree)    │
│              │ <─────────────── │               │ <──────────── │               │
└─────────────┘   topic messages  └──────────────┘   events       │  Goose/Claude  │
                                        │                         └───────┬───────┘
                                        │ monitors CI                     │
                                        v                                 v
                                  ┌──────────────┐               ┌───────────────┐
                                  │  CI Babysit   │               │  GitHub PR     │
                                  │  (gh checks)  │               │  (commit/push) │
                                  └──────┬───────┘               └───────────────┘
                                         │ on failure
                                         v
                                  ┌──────────────┐
                                  │  ci-fix agent │
                                  └──────────────┘
```

**Session lifecycle:**

1. User sends a command (e.g., `/task myrepo Fix the login bug`) in the Telegram forum.
2. The **Dispatcher** parses the command, clones/updates the target repo, and creates a Git worktree for isolation.
3. A **SessionHandle** spawns either a Goose or Claude subprocess in the worktree with the appropriate system prompt and MCP servers.
4. The **Observer** reads the agent's NDJSON output stream in real time, translating events into Telegram messages posted to the session's forum topic.
5. When the agent completes, the Dispatcher checks for a PR. If one exists and CI babysitting is enabled, it polls `gh pr checks` and spawns a **ci-fix agent** on failure (up to `CI_BABYSIT_MAX_RETRIES` times).
6. Users can interact mid-session with `/reply`, or finalize plans with `/execute`, `/split`, `/stack`, or `/dag`.

## Usage

Interact with the bot in your authorized Telegram chat using the following commands:

### Global Commands

| Command | Alias | Description |
|---|---|---|
| `/task [repo] <description>` | `/w` | Start a coding task in a new topic |
| `/plan [repo] <description>` | | Start a read-only planning session |
| `/think [repo] <question>` | | Start a deep-research session |
| `/review [repo] [PR#]` | | Review a pull request or all unreviewed PRs |
| `/ship [repo] <description>` | | End-to-end feature pipeline (think → plan → dag → verify) |
| `/status` | | List all active and idle sessions |
| `/stats` | | Display aggregate usage statistics |
| `/usage` | | Show Claude ACP quota and recent activity |
| `/config` | | Manage provider profiles |
| `/clean` | | Remove idle sessions, orphaned workspaces, and cached repos |
| `/help` | | Show all available commands |

### Thread Commands (inside a topic)

| Command | Alias | Description |
|---|---|---|
| `/reply <text>` | `/r` | Provide feedback or follow-up instructions to the agent |
| `/execute [directive]` | | Finalize a plan/research session and begin code implementation |
| `/split [directive]` | | Split a plan into parallel, independent sub-tasks |
| `/stack [directive]` | | Create stacked PRs from a plan (sequential chain) |
| `/dag [directive]` | | Create a dependency graph of tasks from a plan |
| `/land` | | Merge completed stack/DAG PRs into main in topological order |
| `/stop` | | Stop the running agent but keep the thread and workspace |
| `/close` | | Terminate the agent, wipe the workspace, and delete the topic |

### /ship — automated feature pipeline

`/ship` runs a multi-phase pipeline that takes a feature from idea to verified implementation:

1. **Think** — research the problem and understand the codebase
2. **Plan** — create a detailed implementation plan
3. **DAG** — extract work items into a dependency graph and execute them
4. **Verify** — review all PRs for completeness and correctness

```
/ship https://github.com/org/repo Add dark mode toggle to settings page
/ship webapp Implement rate limiting on the API
```

Each phase auto-advances when complete. The final result is a set of reviewed, CI-passing PRs ready to land.

### /review — pull request review

`/review` spawns a Claude agent to review pull requests with detailed, inline feedback.

```
/review https://github.com/org/repo 123    # review PR #123
/review webapp 456                          # review PR #456 in aliased repo
/review webapp                              # review all unreviewed PRs in repo
```

### /config — provider profiles

Manage provider profiles for switching between Claude providers:

```
/config                              # list all profiles
/config add <id> <name>              # add a new profile
/config set <id> <field> <value>     # update a profile field
/config remove <id>                  # remove a profile
/config default <id>                 # set the default profile
/config default clear                # clear default (shows picker each time)
```

Available fields: `name`, `baseUrl`, `authToken`, `opusModel`, `sonnetModel`, `haikuModel`.

## Configuration

The system is configured via environment variables. See [docs/configuration.md](./docs/configuration.md) for a full reference.

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | The ID of the Telegram forum/group the bot listens to |
| `ALLOWED_USER_IDS` | Comma-separated list of authorized Telegram user IDs |
| `GITHUB_TOKEN` | GitHub PAT for cloning repos and powering the GitHub MCP |

### Agent & Auth

By default, the system uses `claude-acp` (Claude Code subscription) which requires no API key but requires a one-time interactive login.

| Variable | Type | Default | Description |
|---|---|---|---|
| `GOOSE_PROVIDER` | string | `claude-acp` | Provider string. Set to `anthropic` for API key auth |
| `ANTHROPIC_API_KEY` | string | — | Required only if `GOOSE_PROVIDER=anthropic` |
| `GOOSE_MODEL` | string | `sonnet` | Model for Goose task sessions |
| `PLAN_MODEL` | string | `opus` | Model for plan sessions |
| `THINK_MODEL` | string | `opus` | Model for think sessions |
| `REVIEW_MODEL` | string | `opus` | Model for review sessions |

### Workspace & Sessions

| Variable | Type | Default | Description |
|---|---|---|---|
| `WORKSPACE_ROOT` | string | `/workspace` | Root directory for repos and worktrees |
| `MAX_CONCURRENT_SESSIONS` | number | `5` | Maximum parallel agent sessions |
| `MAX_DAG_CONCURRENCY` | number | `4` | Maximum parallel DAG nodes |
| `MAX_SPLIT_ITEMS` | number | `5` | Maximum items from a `/split` |
| `SESSION_TOKEN_BUDGET` | number | `200000` | Token budget per session |
| `SESSION_BUDGET_USD` | number | `10` | Dollar budget per session |
| `SESSION_TIMEOUT_MS` | number | `3600000` | Session hard timeout (1 hour) |
| `SESSION_INACTIVITY_TIMEOUT_MS` | number | `900000` | Inactivity timeout (15 minutes) |
| `SESSION_STALE_TTL_MS` | number | `172800000` | Stale session cleanup threshold (2 days) |
| `CLEANUP_INTERVAL_MS` | number | `3600000` | Cleanup check interval (1 hour) |
| `MAX_CONVERSATION_LENGTH` | number | `100` | Maximum messages in a conversation |

### CI Babysitting

| Variable | Type | Default | Description |
|---|---|---|---|
| `CI_BABYSIT_ENABLED` | boolean | `true` | Enable automatic CI monitoring and fixing |
| `CI_BABYSIT_MAX_RETRIES` | number | `2` | Maximum ci-fix attempts per PR |
| `CI_POLL_INTERVAL_MS` | number | `30000` | CI check polling interval (30 seconds) |
| `CI_POLL_TIMEOUT_MS` | number | `600000` | CI polling timeout (10 minutes) |
| `DAG_CI_POLICY` | string | `warn` | CI failure policy for DAG nodes: `block`, `warn`, or `skip` |

### MCP Server Toggles

| Variable | Type | Default | Description |
|---|---|---|---|
| `ENABLE_BROWSER_MCP` | boolean | `true` | Playwright headless browser |
| `ENABLE_GITHUB_MCP` | boolean | `true` | GitHub API integration |
| `ENABLE_CONTEXT7_MCP` | boolean | `true` | Library documentation lookup |
| `ENABLE_SENTRY_MCP` | boolean | `true` | Sentry error tracking |
| `SENTRY_ACCESS_TOKEN` | string | — | Required if Sentry MCP is enabled |
| `SENTRY_ORG_SLUG` | string | — | Scope Sentry queries to a specific org |
| `SENTRY_PROJECT_SLUG` | string | — | Scope Sentry queries to a specific project |
| `ENABLE_SUPABASE_MCP` | boolean | `true` | Supabase database integration |
| `SUPABASE_ACCESS_TOKEN` | string | — | Required if Supabase MCP is enabled |
| `SUPABASE_PROJECT_REF` | string | — | Scope Supabase queries to a specific project |
| `ENABLE_ZAI_MCP` | boolean | `true` | Z.AI web search (only active with `GOOSE_PROVIDER=z-ai`) |
| `ZAI_API_KEY` | string | — | Required for z-ai provider |

### Observer & Telegram Queue

| Variable | Type | Default | Description |
|---|---|---|---|
| `MIN_SEND_INTERVAL_MS` | number | `3500` | Minimum interval between Telegram messages |
| `ACTIVITY_THROTTLE_MS` | number | `3000` | Activity indicator update throttle |
| `TEXT_FLUSH_DEBOUNCE_MS` | number | `5000` | Text message flush debounce |
| `ACTIVITY_EDIT_DEBOUNCE_MS` | number | `5000` | Activity message edit debounce |

### Other

| Variable | Type | Default | Description |
|---|---|---|---|
| `SENTRY_DSN` | string | — | Sentry DSN for error reporting on the minion itself |
| `SESSION_ENV_PASSTHROUGH` | string | — | Comma-separated list of env var names to pass to sessions |

## Deployment (Fly.io)

This project is designed to run continuously in a cloud environment like Fly.io with a persistent volume attached.

1. **Set Secrets**:
   ```bash
   fly secrets set \
     TELEGRAM_BOT_TOKEN="your_token" \
     TELEGRAM_CHAT_ID="-100..." \
     ALLOWED_USER_IDS="123456789" \
     GITHUB_TOKEN="ghp_..."
   ```

2. **Create Persistent Volume**:
   This stores cloned repositories and Claude authentication state across redeploys.
   ```bash
   fly volumes create workspace_data --size 10
   ```

3. **Deploy**:
   ```bash
   fly deploy
   ```

4. **Authenticate Claude (First deploy only)**:
   If using `claude-acp`, you must authenticate the container once.
   ```bash
   fly ssh console
   su - minion -c 'HOME=/workspace/home claude'
   ```
   Complete OAuth in your browser, then type `/exit` to leave Claude.

## Local Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run directly (requires .env file)
npm run dev

# Build for production
npm run build
```

## Integrating as a Library

The core logic is published as an npm package and can be imported directly to define custom system prompts, agent profiles, repository aliases, or an HTTP API.

### Basic usage

```typescript
import { createMinion, configFromEnv } from "@tprei/telegram-minions"

const minion = createMinion({
  ...configFromEnv(),
  repos: {
    "scripts": "https://github.com/myorg/scripts",
    "webapp": "https://github.com/myorg/webapp",
  }
})

await minion.start()
```

### Custom prompts

Override default system prompts for any session mode:

```typescript
const minion = createMinion({
  ...configFromEnv(),
  prompts: {
    task: "You are a coding agent. Always write tests.",
    plan: "You are a planning agent. Be thorough.",
    think: "You are a research agent. Cite sources.",
    review: "You are a code reviewer. Focus on security.",
    ship_plan: "Create a detailed implementation plan.",
    ship_verify: "Verify all PRs meet the requirements.",
  },
})
```

### Custom agent definitions

Point to custom Claude agent configs and CLAUDE.md:

```typescript
const minion = createMinion({
  ...configFromEnv(),
  agentDefs: {
    agentsDir: "./my-agents",    // custom .claude/agents/ directory
    claudeMd: "# My Rules\n...", // custom CLAUDE.md content
    settingsJson: { /* ... */ },  // custom .claude/settings.json
  },
})
```

### HTTP API

Enable the built-in HTTP API for dashboard and monitoring:

```typescript
const minion = createMinion({
  ...configFromEnv(),
  api: {
    port: 3000,
    host: "0.0.0.0",
    apiToken: "my-secret-token",
  },
})
```

### Session env passthrough

Pass additional secrets to agent sessions:

```typescript
const minion = createMinion({
  ...configFromEnv({
    sessionEnvPassthrough: [
      "MY_API_KEY",
      "DATABASE_URL",
    ],
  }),
})
```

### Exported classes

For advanced use cases, individual classes are available:

```typescript
import {
  TelegramClient,
  Observer,
  Dispatcher,
  SessionHandle,
  validateMinionConfig,
  DEFAULT_PROMPTS,
} from "@tprei/telegram-minions"
```

## Security

### Token scopes and data flow

* **Telegram Bot Token**: Used only for polling updates and sending messages to the configured chat. The bot ignores messages from users not in `ALLOWED_USER_IDS`.
* **GitHub Token**: Used for cloning repos, creating branches/PRs, and the GitHub MCP server. Use a fine-grained PAT scoped to only the repositories the bot needs access to.
* **Sentry/Supabase Tokens**: Passed to their respective MCP servers. Scope these to the minimum required access.
* **`SESSION_ENV_PASSTHROUGH`**: Only variable *names* listed here are forwarded to child sessions. Values must exist in the parent process environment.

### Isolation

Each agent session runs in its own Git worktree with an isolated environment. Sessions cannot access each other's workspaces. The `ALLOWED_USER_IDS` allowlist prevents unauthorized users from triggering commands.

### Secrets handling

* Never commit `.env` files — use `.env.example` as a template.
* On Fly.io, use `fly secrets set` for all sensitive values.
* The `authToken` field in provider profiles is stored in `profiles.json` on the persistent volume — ensure the volume is not publicly accessible.

## Quick Setup Wizard

To create a new minion instance for a different repository, use the setup wizard:

```bash
npx @tprei/telegram-minions setup
```

Or download and run directly:
```bash
curl -fsSL https://raw.githubusercontent.com/tprei/telegram-minions/main/assets/scripts/setup-wizard.sh | bash
```

The wizard will:
- Prompt for minion name, target repo, Telegram credentials
- Generate all config files (Dockerfile, fly.toml, etc.)
- Create the fly app and volume
- Deploy to fly.io
- Print next steps for Claude authentication

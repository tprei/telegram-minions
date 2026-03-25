# telegram-minions

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
* **Autonomous CI Babysitting**: Automatically monitors GitHub PR checks after a task completes. If CI fails, it parses the logs and spawns a `ci-fix` agent to resolve the issues and push updates.
* **Pre-configured MCP Servers**:
  * `Playwright`: Headless Chromium for web browsing and visual QA.
  * `GitHub`: PRs, issues, code search.
  * `Context7`: Up-to-date documentation lookup for external libraries.
  * `Sentry`: Error tracking and stack trace retrieval.
  * `Z.AI`: Web search and real-time information (when using z-ai provider).
* **Stacked PRs & DAG Orchestration**: Chain dependent tasks as stacked PRs or arbitrary dependency graphs, then land them in topological order.
* **Workspace Isolation**: Uses Git worktrees to maintain a clean, persistent workspace for concurrent sessions without cross-contamination.

## Usage

Interact with the bot in your authorized Telegram chat using the following commands:

### Global Commands
* `/task [repo] <description>` (or `/w`) - Starts a coding task in a new topic.
* `/plan [repo] <description>` - Starts a read-only planning session.
* `/think [repo] <question>` - Starts a deep-research session.
* `/review [repo] <PR#>` - Reviews a pull request (or all unreviewed PRs).
* `/status` - Lists all active and idle sessions.
* `/stats` - Displays aggregate usage statistics (tokens, time, success rate).
* `/usage` - Shows Claude ACP quota and recent activity.
* `/config` - Manages provider profiles.
* `/clean` - Removes all idle sessions, orphaned workspaces, and cached repos.
* `/help` - Shows all available commands.

### Thread Commands (inside a specific topic)
* `/reply <text>` (or `/r <text>`) - Provides feedback or follow-up instructions to the agent.
* `/execute [directive]` - Finalizes a plan or research session and begins code implementation.
* `/split [directive]` - Splits a plan into parallel, independent sub-tasks.
* `/stack [directive]` - Creates stacked PRs from a plan (sequential chain with dependent branches).
* `/dag [directive]` - Creates a dependency graph of tasks from a plan (parallel where possible).
* `/land` - Merges completed stack/DAG PRs into main in topological order.
* `/stop` - Stops the running agent but keeps the thread and workspace.
* `/close` - Terminates the active agent, wipes the isolated workspace, and deletes the topic.

## Configuration

The system is configured via environment variables.

### Required
* `TELEGRAM_BOT_TOKEN` - Your Telegram bot token.
* `TELEGRAM_CHAT_ID` - The ID of the chat/forum the bot should listen to.
* `ALLOWED_USER_IDS` - Comma-separated list of authorized Telegram user IDs.
* `GITHUB_TOKEN` - GitHub PAT for cloning repositories and powering the GitHub MCP.

### Agent & Auth
By default, the system uses `claude-acp` (Claude Code subscription) which requires no API key but requires a one-time interactive login.
* `GOOSE_PROVIDER` - Provider string (default: `claude-acp`). Set to `anthropic` to use an API key instead.
* `ANTHROPIC_API_KEY` - Required only if `GOOSE_PROVIDER` is set to `anthropic`.

### MCP Server Toggles
* `ENABLE_BROWSER_MCP` - (default: `true`)
* `ENABLE_GITHUB_MCP` - (default: `true`)
* `ENABLE_CONTEXT7_MCP` - (default: `true`)
* `ENABLE_SENTRY_MCP` - (default: `true`)
* `SENTRY_ACCESS_TOKEN` - Required if Sentry MCP is enabled.
* `ENABLE_ZAI_MCP` - (default: `true`) - Z.AI web search (only enabled when `GOOSE_PROVIDER=z-ai`)
* `ZAI_API_KEY` - Required for z-ai provider. Get from https://z.ai/manage-apikey/apikey-list

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

The core logic is published as a package and can be imported directly if you want to define custom system prompts, custom agent profiles, or repository aliases in code.

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

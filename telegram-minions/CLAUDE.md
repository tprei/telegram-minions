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

## Fly.io deployment

```sh
# Secrets — no ANTHROPIC_API_KEY needed when using claude-acp
fly secrets set \
  TELEGRAM_BOT_TOKEN=... \
  TELEGRAM_CHAT_ID=... \
  ALLOWED_USER_IDS=... \
  GITHUB_TOKEN=...

# Create persistent volume (stores cloned repos + claude auth)
fly volumes create workspace_data --size 10

fly deploy

# Authenticate Claude after first deploy (one time)
fly ssh console
# inside the machine:
claude auth login   # paste URL into local browser
```

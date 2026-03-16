# telegram-notify

Telegram notification bot for Claude Code hooks. Sends threaded notifications with real-time tool activity, project context, and session tracking.

## How it works

The bot hooks into four Claude Code events:

1. **UserPromptSubmit** — Creates a new forum topic with a deterministic slug name (e.g., `scripts · bold-arc`), posts the user's prompt, and renames the tmux window
2. **PostToolUse** — Sends or edits an activity message showing tool usage (Edit, Write, Bash) with throttling to avoid spam
3. **Stop** — Posts the assistant's reply as a thread reply to the original prompt, including elapsed time
4. **SessionEnd** — Deletes the forum topic and cleans up caches

When `LISTENER_ENABLED=true`, a separate `listener.ts` process polls for incoming Telegram messages and injects them as keystrokes into the active tmux pane. Each session gets its own topic, enabling parallel sessions on the same project.

## Setup

### 1. Create a Telegram bot

Message `@BotFather` → `/newbot` → follow prompts → save the token.

### 2. Get your chat ID

Send any message to your bot, then:

```sh
curl https://api.telegram.org/bot<TOKEN>/getUpdates
```

Grab `result[0].message.chat.id`.

### 3. Configure secrets

```sh
cp .env.example .env
# Edit .env: fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

### 4. Install dependencies

```sh
npm install
```

### 5. Test

```sh
echo '{"session_id":"test123","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"hello","transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

Expect `{}` on stdout. With `.env` configured, a message should arrive in Telegram.

### 6. Register the hooks

Add to `~/.claude/settings.json` under `hooks`:

```json
"UserPromptSubmit": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /absolute/path/to/telegram-notify/src/notify.ts",
        "timeout": 15
      }
    ]
  }
],
"PostToolUse": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /absolute/path/to/telegram-notify/src/notify.ts",
        "timeout": 15
      }
    ]
  }
],
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /absolute/path/to/telegram-notify/src/notify.ts",
        "timeout": 15
      }
    ]
  }
],
"SessionEnd": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /absolute/path/to/telegram-notify/src/notify.ts",
        "timeout": 15
      }
    ]
  }
]
```

### 7. (Optional) Enable the two-way listener

The listener lets you reply to Telegram messages and have them injected into the active Claude pane.

```sh
# Add to .env
LISTENER_ENABLED=true
ALLOWED_USER_IDS=<your-telegram-user-id>
```

The classifier (`src/safe-inject.ts`) calls `z-claude` to check each incoming message before injecting. Because `z-claude` is a shell function, it must be wrapped as a real executable:

```sh
mkdir -p ~/bin
cat > ~/bin/z-claude <<'EOF'
#!/usr/bin/env bash
ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \
ANTHROPIC_AUTH_TOKEN="$MY_ZAI_AUTH_TOKEN" \
ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5" \
ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-5" \
exec claude --model GLM-5 "$@"
EOF
chmod +x ~/bin/z-claude
```

`MY_ZAI_AUTH_TOKEN` must be set in the shell that starts `listener.ts` (not in `.env`). Start the listener manually:

```sh
npx tsx src/listener.ts
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | (required) | Supergroup chat ID (negative number) |
| `LISTENER_ENABLED` | `false` | Enable two-way message handling |
| `ALLOWED_USER_IDS` | (none) | Comma-separated Telegram user IDs allowed to inject |
| `ACTIVITY_THROTTLE_MS` | `3000` | Throttle window for PostToolUse activity updates |
| `TELEGRAM_NOTIFY_DISABLED` | (none) | Set to any value to disable all notifications |

## Message flow

```
UserPromptSubmit         PostToolUse (x N)              Stop
      │                       │                          │
      ▼                       ▼                          ▼
┌─────────────┐        ┌─────────────┐           ┌─────────────┐
│ 👤 Prompt   │        │ 🔧 Edit     │           │ 🤖 Reply    │
│ 📦 project  │◄──────►│   file.ts   │◄─ edit ──►│ ⏱ 45s       │
│ 🌿 branch   │        │   (3 tools) │           │ 📦 project  │
│             │        └─────────────┘           │             │
│ "fix bug"   │                                  │ "Done!"     │
└─────────────┘                                  └─────────────┘
      │                                                │
      └──────────────── thread reply ─────────────────┘
```

## Topic naming

Topics use session-based keying for parallel session support:

1. Created as `project (abc123)` using first 6 chars of session ID
2. Renamed to `project · adj-noun` after first prompt (e.g., `scripts · bold-arc`)
3. Deleted automatically on SessionEnd

The slug is deterministic: same session ID always produces the same adjective-noun pair.

## Verification

```sh
# Type check
npx tsc --noEmit

# End-to-end with Telegram
echo '{"session_id":"abc123","cwd":"'$(pwd)'","hook_event_name":"UserPromptSubmit","prompt":"test","transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

## Edge cases

| Scenario | Behaviour |
|---|---|
| Missing env vars | Logs warning to stderr, exits 0 |
| Invalid stdin JSON | Logs warning to stderr, exits 0 |
| Non-git directory | Branch shows `n/a` |
| Message > 4096 chars | Split into reply chain within the same topic thread |
| Telegram API error | Logged to stderr, exits 0 |
| PostToolUse before UserPromptSubmit | Ignored (no cached prompt info) |
| SessionEnd with no topic | No-op |

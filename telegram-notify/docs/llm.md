# telegram-notify — LLM setup reference

Machine-readable reference for setting up and understanding this project. Written for LLMs onboarding into this codebase.

---

## What it does

Fires when Claude Code's `Stop` hook triggers. Reads stdin JSON, enriches with git/tmux/hostname context, then sends a formatted HTML notification to a Telegram supergroup with forum topics. Each unique project name (basename of `cwd`) gets its own topic thread, created automatically on first use.

---

## Source map

| File | Role |
|---|---|
| `src/notify.ts` | Entry point. Reads stdin, resolves topic, sends message. |
| `src/telegram.ts` | Telegram API client. Splits long messages into reply chains. |
| `src/topics.ts` | Forum topic manager. Creates/caches `project → topic_id` mappings. |
| `src/format.ts` | Builds the HTML notification string. |
| `src/context.ts` | Reads git branch, tmux window name, hostname. |
| `src/transcript.ts` | Extracts last user instruction or slash command from transcript JSONL. |
| `src/types.ts` | `StopHookInput` interface matching Claude Code's Stop hook schema. |
| `topics-cache.json` | Runtime cache mapping project names to Telegram topic IDs. Gitignored. |
| `.env` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Gitignored, never commit. |
| `.env.example` | Placeholder template. The only committed secrets file. |

---

## Prerequisites

- Node.js with `npx tsx` available
- A Telegram bot token from `@BotFather`
- A Telegram supergroup with Topics/Forum mode enabled
- The bot added as admin with **Manage Topics** + **Post Messages** permissions

---

## Setup sequence

### 1. Create a Telegram bot

Message `@BotFather` → `/newbot` → follow prompts → copy the token.

### 2. Create the supergroup and enable Topics

1. Create a new Telegram group (must be a supergroup — promote it if needed)
2. Group settings → **Topics** → enable
3. Add your bot → promote to admin → enable **Manage Topics** and **Post Messages**

### 3. Get the group chat ID

Add `@userinfobot` to the group; it replies with the chat ID (a negative number like `-1001234567890`). Then remove it.

Alternatively: send a message in the group, then hit `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[*].message.chat.id`.

### 4. Configure secrets

```sh
cp .env.example .env
# set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (the group's negative ID)
```

### 5. Install dependencies

```sh
npm install
```

### 6. Smoke test

```sh
echo '{"session_id":"test","cwd":"/home/user/myproject","hook_event_name":"Stop","last_assistant_message":"All done.","stop_hook_active":false,"transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

Expected: `{}` on stdout, no stderr errors, a message in the **myproject** topic of your group.

On first run for a new project name, `createForumTopic` is called and the result is written to `topics-cache.json`. Subsequent runs for the same project skip the API call.

### 7. Register the Stop hook

In `~/.claude/settings.json`:

```json
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
]
```

---

## Message format

```
📦 <project>  ·  📂 <cwd>
🌿 <branch>  ·  🪟 <tmux-window>  ·  🖥 <hostname>

❓ <last user instruction or /slash-command>

💬 <full last assistant message>
```

- `❓` line is omitted when no transcript is available or transcript is empty
- `❓` shows the `/command-name` for slash commands (extracted from `<command-name>` tags)
- `💬` contains the full `last_assistant_message` without truncation
- If the formatted message exceeds 4096 chars, it is split at the last newline before the limit; overflow chunks are sent as replies to the first message within the same topic thread

---

## Topic lifecycle

- Topics are created lazily on first notification for a project
- The mapping `{ "projectName": topicId }` is persisted in `topics-cache.json` at the repo root
- To force a new topic for a project, delete its entry from `topics-cache.json`
- To use a single fixed topic for all projects, manually set the desired `message_thread_id` — but this is not exposed as a config option; you'd modify `notify.ts` directly

---

## Failure modes

| Condition | Behaviour |
|---|---|
| `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` missing | Logs to stderr, exits 0 — never blocks Claude |
| Invalid stdin JSON | Logs to stderr, exits 0 |
| `createForumTopic` fails (e.g. bot lacks permission) | Logs to stderr, sends to general chat instead |
| Telegram `sendMessage` HTTP error | Logs to stderr, returns false — does not retry |
| Non-git directory | Branch field shows `n/a` |
| No tmux session | `🪟` field omitted from message |
| Transcript unreadable or missing | `❓` line omitted |

---

## Type check

```sh
npx tsc --noEmit
```

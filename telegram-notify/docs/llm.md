# telegram-notify — LLM setup reference

Machine-readable reference for setting up and understanding this project. Written for LLMs onboarding into this codebase.

---

## What it does

Multi-hook Telegram notification system with threaded conversations and real-time activity tracking:

| Hook | Purpose |
|---|---|
| `UserPromptSubmit` | Creates topic, posts prompt message, renames topic to slug, renames tmux window |
| `PostToolUse` | Sends or edits activity message showing tool name and file/command |
| `Stop` | Posts assistant reply as thread reply to original prompt, includes elapsed time |
| `SessionEnd` | Deletes forum topic, cleans up caches |

Each session gets its own topic (keyed by `session_id`), enabling parallel sessions for the same project.

When `LISTENER_ENABLED=true`, a separate `listener.ts` process polls for incoming Telegram messages and injects them into the correct tmux pane via `safe-inject.ts`.

---

## Source map

| File | Role |
|---|---|
| `src/notify.ts` | Entry point. Routes hook events, manages topics, sends messages. |
| `src/telegram.ts` | Telegram API client. `sendMessage`, `editMessage`, splits long messages. |
| `src/topics.ts` | Forum topic manager. Session-keyed cache with create/rename/delete. |
| `src/slugs.ts` | Deterministic adjective-noun slug generator from session ID. |
| `src/format.ts` | HTML message builders: `formatUserPrompt`, `formatToolActivity`, `formatAssistantReply`. |
| `src/context.ts` | Git branch, tmux window/pane, hostname. Includes `renameTmuxWindow`. |
| `src/transcript.ts` | Extracts last user instruction from transcript JSONL. |
| `src/prompt-cache.ts` | Maps `session_id → { messageId, timestamp, activityMessageId, toolCount }`. |
| `src/types.ts` | `HookInput` interface with optional fields for each hook type. |
| `src/listener.ts` | Long-polls `getUpdates`, routes messages to correct tmux pane. |
| `src/safe-inject.ts` | Sanitizes and classifier-checks incoming text before `tmux send-keys`. |
| `src/sessions.ts` | Maps `thread_id → { session_id, pane_id, cwd, ts }` for listener routing. |
| `topics-cache.json` | `{ sessionId → { threadId, renamed } }`. Gitignored. |
| `prompt-cache.json` | `{ sessionId → { messageId, timestamp, activityMessageId, toolCount } }`. Gitignored. |
| `sessions-cache.json` | `{ threadId → { session_id, pane_id, cwd, ts } }`. Gitignored. |
| `.env` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Gitignored, never commit. |
| `.env.example` | Placeholder template. The only committed secrets file. |

---

## Message flow

```
UserPromptSubmit         PostToolUse (throttled)          Stop
       │                        │                          │
       ▼                        ▼                          ▼
┌──────────────┐         ┌──────────────┐          ┌──────────────┐
│ 👤 Prompt    │         │ 🔧 Edit      │          │ 🤖 Reply     │
│ 📦 project   │◄────────│   file.ts    │◄─ edit ─►│ ⏱ 45s        │
│ 🌿 branch    │         │   (3 tools)  │          │ 📦 project   │
│              │         └──────────────┘          │              │
│ "fix bug"    │                                    │ "Done!"      │
└──────────────┘                                    └──────────────┘
       │                                                  │
       └──────────────── reply_to_message_id ─────────────┘
```

### PostToolUse throttling

- `ACTIVITY_THROTTLE_MS` (default 3000ms) controls how often the activity message updates
- Within throttle window: only `toolCount` increments in cache
- Outside throttle window: new activity message sent (first) or existing edited (subsequent)

---

## Topic lifecycle

1. **Create** — `UserPromptSubmit` calls `createForumTopic` with name `project (abc123)`
2. **Rename** — After first prompt, topic renamed to `project · adj-noun` via `editForumTopic`
3. **Tmux** — Window renamed to slug (e.g., `bold-arc`)
4. **Delete** — `SessionEnd` calls `deleteForumTopic` and cleans caches

Cache key is `session_id`, not project name. Parallel sessions create parallel topics.

---

## Hook input schema

```typescript
interface HookInput {
  session_id: string        // always present
  cwd: string               // always present
  transcript_path: string   // always present
  permission_mode: string   // always present
  hook_event_name: string   // UserPromptSubmit | PostToolUse | Stop | SessionEnd

  // UserPromptSubmit only
  prompt?: string

  // PostToolUse only
  tool_name?: string
  tool_input?: Record<string, unknown>

  // Stop only
  stop_hook_active?: boolean
  last_assistant_message?: string
}
```

---

## Prerequisites

- Node.js with `npx tsx` available
- A Telegram bot token from `@BotFather`
- A Telegram supergroup with Topics/Forum mode enabled
- The bot added as admin with **Manage Topics** + **Post Messages** permissions
- (Listener only) `claude` CLI on `$PATH` and `MY_ZAI_AUTH_TOKEN` set in environment
- (Listener only) `/home/prei/bin/z-claude` executable wrapper

---

## Setup sequence

### 1. Create bot and supergroup

1. `@BotFather` → `/newbot` → copy token
2. Create supergroup → Settings → **Topics** → enable
3. Add bot → promote to admin → enable **Manage Topics** and **Post Messages**
4. Get chat ID via `@userinfobot` or `getUpdates`

### 2. Configure secrets

```sh
cp .env.example .env
# set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

### 3. Install and test

```sh
npm install
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"hi","transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

### 4. Register hooks in `~/.claude/settings.json`

```json
"UserPromptSubmit": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "npx tsx /path/to/telegram-notify/src/notify.ts", "timeout": 15 }] }
],
"PostToolUse": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "npx tsx /path/to/telegram-notify/src/notify.ts", "timeout": 15 }] }
],
"Stop": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "npx tsx /path/to/telegram-notify/src/notify.ts", "timeout": 15 }] }
],
"SessionEnd": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "npx tsx /path/to/telegram-notify/src/notify.ts", "timeout": 15 }] }
]
```

### 5. (Optional) Run listener

```sh
LISTENER_ENABLED=true npx tsx src/listener.ts
```

---

## Message formats

### UserPromptSubmit

```
👤 Prompt  ·  📦 <project>  ·  🌿 <branch>
📂 <cwd>  ·  🪟 <tmux>  ·  🖥 <hostname>

<blockquote><prompt truncated to 300 chars></blockquote>
```

### PostToolActivity

```
🔧 Edit · <code>/path/to/file.ts</code> (3 tools)
🔧 Bash · <code>npm run build…</code>
🔧 Read
```

### Stop (Reply)

```
🤖 Reply  ·  ⏱ 45s  ·  📦 <project>
🌿 <branch>  ·  🪟 <tmux>  ·  🖥 <hostname>

❓ <i><last instruction truncated></i>

<blockquote><assistant message></blockquote>
```

---

## Failure modes

| Condition | Behaviour |
|---|---|
| `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` missing | Logs to stderr, exits 0 |
| `TELEGRAM_NOTIFY_DISABLED` set | Exits 0 immediately |
| Invalid stdin JSON | Logs to stderr, exits 0 |
| `createForumTopic` fails | Logs to stderr, sends to general chat |
| `sendMessage` HTTP error | Logs to stderr, returns false |
| Non-git directory | Branch shows `n/a` |
| No tmux session | `🪟` omitted |
| PostToolUse before UserPromptSubmit | Ignored (no cached prompt) |
| SessionEnd with no topic | No-op |
| `z-claude` not found | Replies "classifier unavailable" |
| `z-claude` returns `UNSAFE` | Replies "blocked: classifier flagged" |
| Shell metacharacters in message | Blocked before classifier |

---

## Type check

```sh
npx tsc --noEmit
```

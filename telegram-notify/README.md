# scripts

Telegram notification bot for Claude Code's `Stop` hook. Sends a message with project, branch, session, and last assistant message whenever Claude finishes a task.

## How it works

Claude Code fires the `Stop` hook when it finishes. The hook runs `notify.ts` via `npx tsx`, which reads the hook's stdin JSON, enriches it with git/hostname context, and POSTs to the Telegram Bot API. Failures are logged to stderr and never block Claude from stopping.

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
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"Stop","last_assistant_message":"done","stop_hook_active":false,"transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

Expect `{}` on stdout. With `.env` configured, a message should arrive in Telegram.

### 6. Register the Stop hook

Add to `~/.claude/settings.json` under `hooks`:

```json
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx tsx /home/prei/scripts/src/notify.ts",
        "timeout": 15
      }
    ]
  }
]
```

## Verification

```sh
# Type check
npx tsc --noEmit

# End-to-end with Telegram
echo '{"session_id":"abc","cwd":"'$(pwd)'","hook_event_name":"Stop","last_assistant_message":"All done.","stop_hook_active":false,"transcript_path":"/tmp/t.json","permission_mode":"default"}' | npx tsx src/notify.ts
```

## Edge cases

| Scenario | Behaviour |
|---|---|
| Missing env vars | Logs warning to stderr, exits 0 |
| Invalid stdin JSON | Logs warning to stderr, exits 0 |
| Non-git directory | Branch shows `n/a` |
| Message > 4096 chars | Split into reply chain within the same topic thread |
| Telegram API error | Logged to stderr, exits 0 |

# scripts — Claude guidance

## Secret and token safety

**Never read, log, print, or include `.env` contents in any output, commit, or message.**

- `.env` is gitignored. Never stage or commit it under any name or path.
- Never echo `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, or any other env var value in responses, diffs, or tool output.
- If a token appears in a file or shell output, flag it immediately and advise rotation — do not reproduce it.
- Use `.env.example` with placeholder values as the only committed secrets template.
- When testing, never inline real credentials in commands shown to the user.

## Project overview

Multi-hook Telegram notification system for Claude Code. Hooks into `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd` to create threaded conversations with real-time tool activity tracking. Each session gets its own forum topic with a deterministic slug name.

## Key files

| File | Purpose |
|---|---|
| `src/notify.ts` | Entry point — routes hooks, manages topics, sends messages |
| `src/telegram.ts` | Telegram API client via native `fetch` |
| `src/topics.ts` | Forum topic manager with session-based keying |
| `src/slugs.ts` | Deterministic adjective-noun slug generator |
| `src/prompt-cache.ts` | Session → message/timing/activity cache |
| `src/format.ts` | HTML message builders for each hook type |
| `src/context.ts` | Git branch, tmux window/pane, hostname |
| `src/types.ts` | `HookInput` interface with optional hook-specific fields |
| `.env` | Runtime secrets — gitignored, never committed |
| `.env.example` | Placeholder template — the only committed secrets file |

## Development

```sh
npm install
npx tsc --noEmit                         # type check
echo '{...}' | npx tsx src/notify.ts     # smoke test
```

See `README.md` for full setup and `docs/llm.md` for architecture details.

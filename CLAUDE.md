# scripts — Claude guidance

## Secret and token safety

**Never read, log, print, or include `.env` contents in any output, commit, or message.**

- `.env` is gitignored. Never stage or commit it under any name or path.
- Never echo `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, or any other env var value in responses, diffs, or tool output.
- If a token appears in a file or shell output, flag it immediately and advise rotation — do not reproduce it.
- Use `.env.example` with placeholder values as the only committed secrets template.
- When testing, never inline real credentials in commands shown to the user.

## Project overview

Telegram notification bot for Claude Code's `Stop` hook. When Claude finishes a session, `src/notify.ts` fires via stdin JSON, gathers git/tmux/hostname context, and POSTs to the Telegram Bot API. Failures never block Claude from stopping.

## Key files

| File | Purpose |
|---|---|
| `src/notify.ts` | Entry point — reads stdin, sends notification, exits 0 |
| `src/telegram.ts` | Telegram API client via native `fetch` |
| `src/context.ts` | Git branch, tmux window, hostname |
| `src/format.ts` | HTML message builder |
| `src/types.ts` | `StopHookInput` / `HookOutput` interfaces |
| `.env` | Runtime secrets — gitignored, never committed |
| `.env.example` | Placeholder template — the only committed secrets file |

## Development

```sh
npm install
npx tsc --noEmit                         # type check
echo '{...}' | npx tsx src/notify.ts     # smoke test
```

See `README.md` for full setup and test instructions.

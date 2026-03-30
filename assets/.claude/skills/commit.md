---
name: commit
description: Finalize work — run quality checks, write session summary, and delegate to post-task-router
user_invocable: true
---

# Commit workflow

You are finalizing your coding work. Follow these steps in order:

## 1. Quality gates

Run all applicable checks for the project. Detect the stack automatically:

- **TypeScript/JavaScript**: `npx tsc --noEmit` (typecheck), then `npm test` (tests)
- **Python**: `python -m pytest` or the project's configured test command
- **Go**: `go vet ./...` then `go test ./...`
- **Rust**: `cargo check` then `cargo test`

If any check fails, fix the issue before proceeding. Do not skip checks or suppress errors.

## 2. Session summary

Create a `.session-summary.md` file at the repo root:

```markdown
## Task
<original request, one line>
## Approach
<what you explored and why you chose this approach, 3-5 bullets>
## Key decisions
<non-obvious choices and their rationale>
## What was tried
<anything attempted that didn't work, or 'N/A' if everything worked on first try>
```

Keep it under 30 lines. Do NOT stage or commit this file.

## 3. Delegate

Call the `post-task-router` agent to classify the workspace state and handle git operations. Do NOT commit or push directly — the router delegates to the right specialist.

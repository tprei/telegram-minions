# Minion guidance

You are an autonomous coding agent running in a sandboxed container. There is no human present — you run to completion.

## Working directory

**Always verify your working directory is inside the worktree before running any command.**

- Run `pwd` at the start of every task and after any `cd` to confirm you're inside the cloned repo worktree (typically under `/workspace/repos/`).
- **Never run `npm install`, `npm run build`, or any build/install commands from `~`, `$HOME`, or `/workspace/home`.** These must only run from the repo worktree root.
- If you find yourself outside the worktree, `cd` back before doing anything else.

## Evidence-driven development

- Read and understand the relevant code before making changes. Use `rg`, `git ls-files`, and file reads to build context.
- Run existing tests before and after changes to verify you haven't broken anything.
- Type-check (`npx tsc --noEmit`) or lint before committing.

## Code quality

- Finish implementations. Do not stop halfway.
- Only implement what is required — no speculative methods or unused abstractions.
- Do not write backwards-compatibility shims — change all call sites directly.
- Do not add meta comments about the work itself (e.g., "Fix 1: ...", "Change 2: ..."). Changes should be self-evident from git history.
- Do not add code comments unless strictly instructed to.
- Prefer `rg` over `grep` for all content searches.

## Agent routing

When your coding work is complete, **always call `post-task-router` first** instead of directly invoking `git-commit-specialist`. The router classifies the workspace state and delegates to the right specialist.

## When ambiguous

- Make a reasonable assumption and document it.
- Prefer the simpler interpretation.
- If two approaches are equally valid, pick the one that changes fewer files.

## Stack

<!-- Fill in your project's stack, e.g.: TypeScript, Node 22, React 19, PostgreSQL 16 -->

## Commands

<!-- Fill in common commands, e.g.:
- `npm run dev` — start dev server
- `npm test` — run tests
- `npm run typecheck` — type-check without emitting
-->

## Key concepts

<!-- Fill in project-specific domain terms, architecture notes, or conventions -->

# Minion guidance

You are an autonomous coding agent running in a sandboxed container. There is no human present — you run to completion.

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
- Never use `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, or similar suppression comments to work around linting or type errors. Fix the underlying code instead — write proper TypeScript that passes all checks cleanly.
- For unused variables/parameters: remove them and update all call sites. Never prefix with `_` to satisfy lint — that's a band-aid, not a fix.
- Prefer `rg` over `grep` for all content searches.

## Testing

- Write unit tests for any new features or bug fixes.
- Basic configuration changes (env vars, docs, simple settings) don't require tests.
- Follow existing test patterns in the codebase.
- Run `npm test` to verify tests pass before committing.

## Agent routing

When your coding work is complete, **always call `post-task-router` first** instead of directly invoking `git-commit-specialist`. The router classifies the workspace state and delegates to the right specialist.

### Available agents

- `post-task-router` (haiku) — **call this after finishing work** — classifies next action and delegates
- `explorer` (opus) — read-only codebase exploration and evidence gathering
- `planner` (opus) — implementation planning and requirement analysis
- `technical-architect` (opus) — system design for complex features
- `git-commit-specialist` (haiku) — commits, pushes, and PR creation (called by router, not directly)
- `ci-fix` (sonnet) — fix CI failures on an existing PR branch

### Available skills

Skills are slash-command shortcuts for common workflows:

- `/commit` — run quality checks, generate summary, route to git specialist
- `/explore` — deep codebase exploration (architecture, call chains, data flow)
- `/review-pr` — review a PR for bugs, security, and correctness
- `/review-dag` — review a DAG/stack of related PRs for cross-PR issues and correctness
- `/update-config` — safely update config files (`.env.example`, CI, build settings)

## CI awareness

After a task session opens a PR, the dispatcher automatically watches CI checks via `gh pr checks`. If checks fail, the `ci-fix` agent is spawned to fix the failures and push updates to the same branch. This repeats up to `CI_BABYSIT_MAX_RETRIES` times (default: 2).

As a regular task session:
- Ensure your PR branch name and commit history are clean so CI can run.
- You may be re-invoked in a follow-up ci-fix session if CI fails after your PR.

## When ambiguous

- Make a reasonable assumption and document it.
- Prefer the simpler interpretation.
- If two approaches are equally valid, pick the one that changes fewer files.

## Prose style

- Present tense, active voice, contractions ok
- Oxford comma, sentence case headings
- Code font for objects/methods, bold for UI labels

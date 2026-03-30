---
name: pr-workflow
description: Git branching, committing, and pull request creation workflow for coding agents
---

# PR Workflow

Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.

## Committing

- Keep commits focused — one logical change per commit.
- Stage specific files with `git add <file>`, never `git add .` or `git add -A`.
- Never commit `.env`, credentials, tokens, or secrets.
- Never push to `main` or `master` directly.

## Opening a PR

Use the `gh` CLI (pre-authenticated via GITHUB_TOKEN):

```bash
gh pr create --title "feat: short description" --body "## Summary
- what changed and why

## Test plan
- how it was verified"
```

PR descriptions explain **what changed and why**, not how.
If no tests exist for the area you modified, note this in the PR description.
Document assumptions in the PR description since there is no human to ask.

## Branch hygiene

- Check the current branch first: `git branch --show-current`.
- A branch has already been created for you — do not create a new one.
- If you need the default branch name: `git remote show origin | grep 'HEAD branch'`.

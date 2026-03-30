---
name: ci-diagnosis
description: Diagnose and fix CI failures from GitHub Actions or other CI systems
---

# CI Diagnosis

When CI checks fail on a pull request, follow this workflow.

## 1. Get the failure details

```bash
gh pr checks <pr-number>
gh run view <run-id> --log-failed
```

## 2. Classify the failure

- **Type error**: fix the TypeScript/compilation error in the source
- **Lint error**: fix the style or lint violation (never add disable comments)
- **Test failure**: read the failing test, understand the assertion, fix the code or test
- **Build failure**: check for missing imports, circular dependencies, or config issues
- **Flaky test**: re-run once; if it passes, note the flakiness in the PR

## 3. Fix locally

- Reproduce the failure with the same command CI uses
- Fix the root cause, not symptoms
- Run the full quality gate suite after fixing

## 4. Push the fix

- Commit the fix with `fix: resolve CI failure — <description>`
- Push to the same branch — CI will re-run automatically

## Rules

- Never use `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or similar suppressions.
- Never skip pre-commit hooks with `--no-verify`.
- Fix the underlying code instead of working around the tooling.

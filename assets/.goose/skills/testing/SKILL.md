---
name: testing
description: Discover and run project tests, type checks, and linters before committing
---

# Testing

Run quality gates before committing or opening a PR.

## Discovery

Detect the project's toolchain from config files:

| File | Runner | Commands |
|---|---|---|
| `vitest.config.*` or `vite.config.*` | Vitest | `npx vitest run` |
| `jest.config.*` | Jest | `npx jest` |
| `pytest.ini` / `pyproject.toml` | Pytest | `pytest` |
| `Cargo.toml` | Cargo | `cargo test` |
| `go.mod` | Go | `go test ./...` |

Check `package.json` scripts for `test`, `typecheck`, and `lint` commands.

## Execution order

1. **Type check** — `npx tsc --noEmit` (TypeScript) or equivalent
2. **Lint** — `npx eslint src/` or project-specific linter
3. **Test** — run the discovered test command
4. **Focused tests** — if you changed specific files, run only related tests first for faster feedback

## Rules

- Dependencies are pre-installed. Do NOT run `npm install`, `npm ci`, or install packages.
- If a test runner is not found, it is not a project dependency — skip and note in the PR.
- Fix failures before committing. Do not push broken code.
- If you add new functionality, write tests following existing patterns in the codebase.

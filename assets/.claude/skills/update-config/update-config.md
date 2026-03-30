---
name: update-config
description: Safely update project configuration — env vars, build settings, CI, and dependencies
user_invocable: true
---

# Configuration update

Safely modify project configuration files. This skill handles env vars, build settings, CI pipelines, and dependency changes with proper validation.

## Safety rules

- NEVER modify `.env` files or commit secrets. Only update `.env.example` with placeholder values.
- NEVER remove existing config without understanding all consumers. Search for references first.
- ALWAYS validate config changes by running the project's build/typecheck after modifications.

## Workflow

1. **Identify scope**: Determine which config files need changes. Common targets:
   - `package.json` / `tsconfig.json` / `go.mod` / `Cargo.toml` — project settings
   - `.env.example` — environment variable templates (never `.env`)
   - `fly.toml` / `Dockerfile` / `docker-compose.yml` — deployment config
   - `.github/workflows/` — CI pipeline configuration
   - `vitest.config.ts` / `jest.config.*` / `eslint.config.*` — tooling config

2. **Read current state**: Read each config file to understand the current settings before making changes.

3. **Search for references**: Use `rg` to find all code that references the config values you're changing. Ensure no consumers break.

4. **Make changes**: Edit config files. For new env vars:
   - Add to `.env.example` with a descriptive placeholder
   - Add to `src/config.ts` (or equivalent) with validation
   - Add to deployment configs (fly.toml, Dockerfile) if needed

5. **Validate**: Run the project's build and typecheck to confirm nothing broke.

6. **Report**: Summarize what changed and what the user needs to do (e.g., set new env vars, redeploy).

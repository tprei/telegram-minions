---
name: secure-coding
description: Security best practices for avoiding common vulnerabilities in code changes
---

# Secure Coding

Avoid introducing security vulnerabilities in code changes.

## Secrets

- Never commit `.env`, API keys, tokens, or credentials.
- Never log or print secret values.
- Use environment variables for configuration, not hardcoded strings.
- Check for `.env.example` to understand expected env vars without exposing values.

## Input validation

- Validate user input at system boundaries (API endpoints, CLI args, form inputs).
- Sanitize data before inserting into HTML (prevent XSS).
- Use parameterized queries for database access (prevent SQL injection).
- Avoid `eval()`, `new Function()`, or executing user-provided strings.

## Command execution

- Never pass unsanitized input to shell commands.
- Use array-form APIs (`execFile` over `exec`) to avoid shell injection.
- Quote file paths and variable expansions in shell scripts.

## Dependencies

- Do not install new packages unless explicitly required by the task.
- Dependencies are pre-installed and locked — do not modify `package-lock.json`.

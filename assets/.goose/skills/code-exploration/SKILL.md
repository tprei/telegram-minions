---
name: code-exploration
description: Efficient codebase navigation, search, and understanding techniques
---

# Code Exploration

Read and understand code before making changes.

## Search techniques

- **Find files**: `find . -name "*.ts" -not -path "*/node_modules/*"`
- **Search content**: `rg "pattern" --type ts` (prefer `rg` over `grep`)
- **Find definitions**: `rg "function functionName|class ClassName|export.*ClassName"`
- **Trace imports**: `rg "from.*module-name" --type ts`
- **Git history**: `git log --oneline -20`, `git log --oneline -- path/to/file`

## Understanding architecture

1. Start with entry points: `main.ts`, `index.ts`, `app.ts`
2. Read config files: `package.json`, `tsconfig.json`, `Dockerfile`
3. Check for architecture docs: `README.md`, `CLAUDE.md`, `AGENTS.md`, `ARCHITECTURE.md`
4. Trace the call chain from entry point to the area you need to change
5. Identify tests for the area: `rg "describe.*ModuleName" test/`

## Before changing code

- Read the file you plan to modify in full
- Understand the function signatures and callers
- Check for related tests
- Look at recent git history for the file: `git log --oneline -5 -- <file>`

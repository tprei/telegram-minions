---
name: explore
description: Deep codebase exploration — trace architecture, call chains, and data flow
user_invocable: true
---

# Codebase exploration

Perform a thorough, structured exploration of the codebase. Use read-only tools only — do not modify any files.

## Strategy

1. **Orientation**: Run `git ls-files | head -80` and check for README, package.json, go.mod, Cargo.toml, or similar to identify the tech stack and entry points.

2. **Broad search**: Use `rg` with keywords from the user's question to locate relevant files. Search for type definitions, function signatures, and config patterns.

3. **Deep trace**: Read the key files you found. Follow imports, trace call chains from entry points to leaves, and map the data flow.

4. **Cross-reference**: Check tests for usage examples and edge cases. Check git log for recent changes to the area of interest.

## Output format

Present findings as a structured report:

### Architecture overview
High-level description of how the relevant components fit together.

### Key components
For each important file/module:
- **Path**: `src/foo.ts`
- **Purpose**: What it does and why it exists
- **Key exports**: Functions, types, and classes other modules depend on

### Data flow
How data moves through the system for the scenario in question.

### Risks and observations
Non-obvious findings, potential issues, or areas that need attention.

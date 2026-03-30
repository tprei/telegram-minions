---
name: review-pr
description: Review a pull request for bugs, security issues, and correctness problems
user_invocable: true
---

# PR review

Review a pull request and post a concise, high-signal review to GitHub.

## What to look for

Focus ONLY on issues that could cause bugs, security vulnerabilities, data loss, or correctness failures:

- Logic errors, off-by-one, null/undefined mishandling
- Race conditions, deadlocks, resource leaks
- Security issues (injection, auth bypass, secret exposure)
- API contract violations, breaking changes
- Missing error handling on external boundaries (network, filesystem, user input)

## What NOT to comment on

- Style, formatting, naming conventions
- Missing tests (unless the code is clearly untested AND risky)
- Documentation or comments
- Performance unless there is a clear O(n^2) or worse regression
- Anything you are less than 80% confident is a real issue

An empty review is a valid outcome. Not every PR has problems.

## Workflow

1. Identify the PR number from the user's message or the current branch: `gh pr list --head $(git branch --show-current) --json number -q '.[0].number'`
2. Get the diff: `gh pr diff <number>`
3. Read changed files for full context (not just the diff)
4. Analyze for real issues
5. Post the review:
   - No issues: `gh pr review <number> --approve --body "LGTM"`
   - Warnings only: `gh pr review <number> --comment --body "<findings>"`
   - Any critical: `gh pr review <number> --request-changes --body "<findings>"`

## Finding format

Cap at 5 findings. For each:

```
### [severity] file:line — One-line title
Explanation with a concrete failure scenario.
```suggestion
// suggested fix (optional)
```
```

Severity levels: `critical`, `warning`, `info` (use info sparingly).

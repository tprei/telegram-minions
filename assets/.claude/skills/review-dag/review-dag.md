---
name: review-dag
description: Review a DAG or stack of related PRs for cross-PR issues and per-PR correctness
user_invocable: true
---

# DAG review

Review a collection of related PRs (from a DAG, stack, or split) and post concise, high-signal reviews to GitHub. This covers both per-PR correctness and cross-PR integration issues.

## What to look for

### Per-PR (same as single-PR review)

- Logic errors, off-by-one, null/undefined mishandling
- Race conditions, deadlocks, resource leaks
- Security issues (injection, auth bypass, secret exposure)
- API contract violations, breaking changes
- Missing error handling on external boundaries (network, filesystem, user input)

### Cross-PR

- **File conflicts**: multiple PRs modifying the same file — potential merge conflicts or silent overwrites
- **Interface mismatches**: PR A changes a function signature, type, or export that PR B depends on
- **Ordering assumptions**: a PR assumes state created by another PR that may not have landed yet
- **Duplicated work**: two PRs implementing the same logic differently
- **Import/dependency gaps**: PR A adds a dependency that PR B also needs but doesn't declare

## What NOT to comment on

- Style, formatting, naming conventions
- Missing tests (unless the code is clearly untested AND risky)
- Documentation or comments
- Performance unless there is a clear O(n^2) or worse regression
- Anything you are less than 80% confident is a real issue

An empty review is a valid outcome. Not every DAG has problems.

## Workflow

1. **Identify PRs**: collect PR numbers from one of these sources (in priority order):
   - User provides PR numbers or URLs directly
   - Parse the DAG status table from a PR description (look for `<!-- dag-status-start -->` / `<!-- dag-status-end -->` markers containing a markdown table with PR links)
   - List open PRs on the current repo: `gh pr list --json number,title,headRefName,url`

2. **Fetch metadata for each PR**:
   ```sh
   gh pr view <number> --json number,title,headRefName,body,url
   ```

3. **Fetch diffs for each PR**:
   ```sh
   gh pr diff <number>
   ```

4. **Build file ownership map**: for each PR, record which files are added, modified, or deleted. Identify overlaps — files touched by more than one PR.

5. **Analyze cross-PR interfaces**: for each overlapping file or export boundary:
   - Check if function signatures, types, or interfaces changed in one PR are consumed by another
   - Check if merge order could cause one PR to silently overwrite another's changes
   - Check if a PR adds imports from files that are moved or renamed in another PR

6. **Review each PR individually**: read the full changed files for context (not just the diff). Apply the same criteria as a single-PR review.

7. **Post reviews to GitHub**:
   - For each PR with findings: `gh pr review <number> --comment --body "<per-PR findings>"`
   - For PRs with critical issues: `gh pr review <number> --request-changes --body "<findings>"`
   - For clean PRs: `gh pr review <number> --approve --body "LGTM"`

8. **Output consolidated summary** to the conversation:
   - Total PRs reviewed
   - Cross-PR issues found (if any)
   - Per-PR issue counts
   - Overall assessment: ready to land, or needs fixes

## Finding format

Cap at **5 findings per PR** and **10 cross-PR findings total**.

### Per-PR findings

```
### [severity] file:line — One-line title
Explanation with a concrete failure scenario.
```suggestion
// suggested fix (optional)
```
```

### Cross-PR findings

```
### [severity] Cross-PR: One-line title
**Affects:** PR #X (task-a) <> PR #Y (task-b)
**Files:** `src/foo.ts` (PR #X) <> `src/bar.ts` (PR #Y)
Explanation of the interface mismatch, integration gap, or merge-order risk.
```

Severity levels: `critical`, `warning`, `info` (use info sparingly).

## Large DAGs

When the DAG has more than 6 PRs, prioritize cross-PR analysis over exhaustive per-PR review. Focus per-PR review on PRs that touch overlapping files or that have critical-path dependencies (fan-in nodes).

## Handling missing PRs

Skip DAG nodes that have no PR URL (status `pending`, `running`, or `failed`). Note skipped nodes in the summary so the user knows which parts were not reviewed.

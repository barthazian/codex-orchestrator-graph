---
name: codex-reviewer
description: Stage 6 code review for the codex-orchestrator pipeline. Runs deterministic build gate, queries state.db for implementation context, then launches Codex app-server review + 5 parallel Claude agents simultaneously. Orchestrating Claude judges all findings KEEP/DISCARD/ELEVATE and writes synthesis.
triggers:
  - codex-reviewer
  - codex review
  - stage 6 review
---

# Codex Reviewer — Stage 6 Full Protocol

## Step 0: Deterministic Gate (HARD FAIL)

Run the project's build/check command. Stop immediately if it fails — do not proceed to LLM review on broken code.

| Stack | Command |
|-|-|
| Rust | `cargo check 2>&1 && cargo build 2>&1` |
| Node | `npm run build 2>&1` or `tsc --noEmit 2>&1` |
| Python | `python -m py_compile <changed_files>` |
| Other | Run appropriate type-check + build for the project |

Use the **Bash tool** to execute. If the gate fails, report the failure to the user and **stop**. Do not continue to Step 1.

## Step 1: Build Review Context

### 1a. Query state.db (pipeline mode)

If `_codex/state.db` exists, query it via Bash tool with sqlite3:

```sql
SELECT mission, stage, progress FROM mission WHERE id=1;
SELECT id, task, status, files_modified, summary FROM agents WHERE status='completed';
```

If `_codex/state.db` does not exist (standalone review, not inside pipeline): skip the query and use git diff only.

### 1b. Freeze the diff scope

Run `git diff --name-only HEAD` to get the file list. This is the **frozen diff scope** — all review activity is limited to these files.

### 1c. Cross-reference and read

Build a map: "file X was modified by agent Y who was tasked with Z and reported W".

Read the full content of every file in the frozen diff scope using the **Read tool**.

### 1d. Compose context block

Assemble the review context block that will be passed to all Claude review agents:

- **Mission description**: what we are building (from state.db or user prompt)
- **Per-file context**: which agent modified it, their task description, their completion summary
- **Full file contents** for every file in diff scope

This gives reviewers the INTENT behind each change, not just the code.

## Step 2: Parallel Launch

Send a **single message** containing ALL 6 tool calls simultaneously:

### Tool call 1 — Codex app-server review (Bash, background)

```bash
node ~/.claude/scripts/codex-review.mjs --target uncommittedChanges --cwd "$(pwd)" --output _codex/reviews/codex-review.md --timeout 120000
```

Use `run_in_background: true`.

### Tool calls 2–6 — Five Claude review agents (Task tool)

Launch five **Task** calls (`subagent_type=general-purpose`). Each agent receives:

- The mission description
- Per-file implementation context (agent task + summary)
- Full file contents for all files in diff scope
- Their specific focus area (from the table below)
- Instruction to return findings as a JSON array:

```json
[{"path": "...", "line": 0, "severity": "CRITICAL|HIGH|MEDIUM|LOW", "category": "...", "description": "...", "evidence": "...", "suggested_fix": "..."}]
```

| Agent | Focus |
|-|-|
| #1 | CLAUDE.md compliance — audit changes against project rules. Only flag rules directly relevant to the changes. |
| #2 | Bug scan — logic errors, off-by-one, race conditions, incorrect API usage. Ignore nitpicks. |
| #3 | Error handling + edge cases — swallowed errors, missing validation, unhandled edge cases, panic paths. |
| #4 | Security — secrets in code, injection, hardcoded values, unsafe operations, key/credential exposure. |
| #5 | Trading/financial safety — float for money, missing dry-run, no circuit breaker, no position size validation, no rate limiting on orders, no audit logging before order submission. Skip if no financial code in scope. |

If an agent's focus area is not applicable to the diff scope (e.g., no financial code for agent #5), instruct it to return an empty array.

## Step 3: Collect + Judge

After all 6 tool calls complete:

1. Read `_codex/reviews/codex-review.md` for Codex findings (plain text — interpret directly).
2. Collect all 5 Claude agent results (JSON arrays).
3. Read each source file in the frozen diff scope at the cited lines using the **Read tool**.
4. Judge every raw finding:

| Verdict | Criteria | Action |
|-|-|-|
| **KEEP** | Real issue confirmed by reading the code at the cited line. The described behavior actually occurs. | Include in report |
| **DISCARD** | False positive, pre-existing issue, pedantic nitpick, or linter-catchable. | Drop silently |
| **ELEVATE** | Flagged independently by BOTH a Codex finding AND a Claude agent finding on the same path+category. | Include with ELEVATE tag — highest priority |

**Discard** a finding if:

- It is not in the frozen diff scope
- It is a pre-existing issue not introduced by these changes
- A compiler or linter would catch it
- A senior engineer would not flag it in a real review

If Codex review was unavailable (background task exited non-zero or `codex-review.mjs` not found): judge with Claude agents only. Note "Codex review unavailable" in telemetry.

## Step 4: Write Synthesis

Write the final report to `_codex/reviews/synthesis.md`:

```markdown
# Code Review Synthesis — <date>

## Gate: PASS / FAIL
## Files Reviewed: <list>

## ELEVATE (confirmed by both Codex and Claude)
- [path:line] category — description — fix

## CRITICAL / HIGH (KEEP)
- [path:line] category — description — fix

## MEDIUM / LOW (KEEP)
- [path:line] category — description — fix

## Telemetry
- Total raw findings: N
- Discarded: N
- Kept: N (ELEVATE: N, CRITICAL: N, HIGH: N, MEDIUM: N, LOW: N)
- Codex findings: N | Claude agent findings: N
```

Use the **Bash tool** to write the file (`Write` tool or heredoc). Then print the full synthesis to the user.

## Step 5: Optional PR Review

Check if the work is on a PR branch with an open pull request:

```bash
gh pr view --json number,state 2>/dev/null
```

If an open PR exists, invoke the `code-review:code-review` skill for GitHub comment posting. If no PR exists, skip this step.

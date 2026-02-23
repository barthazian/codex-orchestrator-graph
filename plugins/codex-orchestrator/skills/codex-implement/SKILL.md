---
name: codex-implement
description: Stage 5 implementation skill for the codex-orchestrator pipeline. Owns the mandatory agent spawn template, file pre-locking, artifact gate, host build verification, map update gate, background watcher, and agent timing expectations. Invoked by codex-orchestrator at Stage 5.
triggers:
  - codex-implement
---

# Codex Implement — Stage 5 Skill

This skill owns **Stage 5 (Implementation)** of the codex-orchestrator pipeline. It is invoked by the orchestrator after PRD approval and returns control when the artifact gate + build gate + map update gate all pass.

**Owns:**
- Mandatory agent spawn template (no improvisation)
- File pre-locking protocol
- Artifact gate (all agents complete, locks released)
- Host build verification gate
- Codebase map update gate
- Background watcher
- Agent timing expectations
- Implementation-specific operational policies (prompt size, sandbox, ephemeral/persistent, timeout, retry)

**Does NOT own:**
- Review logic (that is codex-reviewer)
- Research agent spawning (that is codex-research)
- PRD creation (that is codex-prd)
- Test agent spawning (that is codex-test)
- SQLite schema (defined in codex-orchestrator)
- Mission table writes other than agent registration and file locks

---

## Stage 5: Implementation

Decompose the PRD into independent, parallelizable tasks. Spawn a Codex agent for each task. Each agent gets a specific task, relevant file paths, and the working directory.

**Artifact Gate (before advancing to Stage 6):** Claude MUST verify all implementation agents completed and file locks are released:

```bash
sqlite3 -header -column _codex/state.db "SELECT id, task, status FROM agents WHERE status NOT IN ('completed','failed');"
sqlite3 -header -column _codex/state.db "SELECT file_path, agent_id FROM file_locks;"
```

If any agents are still running or file locks remain, do NOT advance to review.

**Host Build Verification Gate (after artifact gate passes):** Claude runs the build verification command directly from the host — NOT inside any agent. Agents write files; Claude verifies. This is language-agnostic: Claude reads the project root, detects the build tool, and runs the appropriate command:

```bash
# Claude detects and runs — examples:
cargo check          # Rust   (Cargo.toml present)
tsc --noEmit         # TypeScript (tsconfig.json present)
go build ./...       # Go     (go.mod present)
python -m py_compile # Python (*.py present)
npm run build        # Node   (package.json with build script)
```

**Why this must run on the host:** `workspace-write` sandbox blocks outbound network. Agents cannot fetch dependencies from crates.io, npm, PyPI, etc. The host has full network access. If build verification is delegated to agents, dependency resolution silently fails and the failure surfaces only after the agent's full turn budget is consumed.

If build verification fails, Claude fixes the issue directly (dependency source, version conflict, syntax error) before advancing to Stage 6. Do NOT spawn a new agent to fix a dependency line.

---

## Spawning Agents — Mandatory Prompt Template

Every agent prompt MUST include the **Mission Context** and **Task** blocks below. Claude uses this template every time, filling in the bracketed placeholders. No improvisation.

**Design principle: maximize coding turns.** Codex agents have a limited turn budget (not configurable). Every sqlite3 call, file read, or status update costs a turn. The template is designed so agents spend nearly ALL turns writing code.

- Claude pre-injects all mission context as plain text (agents run ZERO read queries)
- Claude pre-locks files before spawning (agents run ZERO file lock commands)
- Agents report completion with a single sqlite3 heredoc (1 turn, not 3+)
- No checkpoint writes during work (Claude monitors via `codex-agent capture`)

### The Template

**CRITICAL: Use file-based prompts to avoid shell quoting issues.** Write the prompt to `_codex/prompt-{agentId}.txt` using the Write tool, then spawn with `codex-agent start "$(cat _codex/prompt-{agentId}.txt)"`.

**Prompt files stay well under 1KB with the context file approach.** The context (mission state, agents, events) lives in `_codex/mission-context.md`. The prompt contains only: context file reference + task + file list + WHEN DONE. This permanently solves the Windows ~32KB env block limit that caused `Argument list too long` when context was embedded inline.

**Before writing the prompt file**, Claude MUST:

1. Read the current mission context (single structured command replaces 3 separate SELECT queries):
```bash
codex-agent mission status --json --dir "{cwd}"
```
This returns mission state, all agents, file locks, and recent events in one machine-parseable JSON response.

2. Pre-lock the agent's files and register the agent as `pending`:
```bash
sqlite3 _codex/state.db <<SQL
INSERT INTO agents (id, task, sandbox) VALUES ('{jobId}', '{task}', '{sandbox}');
INSERT INTO events (type, source, message) VALUES ('agent_registered', 'claude', 'Registered agent {jobId} (pending) for: {task}');
INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('{file1}', '{jobId}');
INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('{file2}', '{jobId}');
SQL
```

**Why `pending`, not `running`:** If context compacts between this step and the spawn command, a `running` row with no actual process is a phantom agent. `pending` = registered-not-yet-spawned. Claude updates to `spawned` immediately after the spawn command succeeds. Recovery can then distinguish: `pending` = spawn never attempted, `spawned` = command issued (process may or may not be alive), `running` = confirmed live (set by agent's own first DB write, if applicable, or left as `spawned` until completion).

3. Write mission context to file — do NOT embed in prompt:
```bash
codex-agent mission context --dir "{cwd}" > "_codex/mission-context.md"
```

4. Read model config from env vars:
```bash
IMPL_MODEL="${CODEX_IMPL_MODEL:-gpt-5.3-codex-spark}"
IMPL_REASONING="${CODEX_IMPL_REASONING:-xhigh}"
```

5. **For complex tasks, write an implementation spec file** before writing the prompt. A task is "complex" if it requires more than 5 bullet points of implementation detail to describe. Write the detail there — NOT in the prompt body:
```bash
mkdir -p _codex/specs
# Write to _codex/specs/{agentId}.md using the Write tool:
# Include: architecture decisions, API patterns to follow, key function signatures,
# cross-file integration points, gotchas, PRD section references.
# The agent will read this on turn 1 from the filesystem — no env-block cost.
```

6. Write the prompt file using the template below.

**Prompt file template** (write this to `_codex/prompt-{agentId}.txt`):

```
=== MISSION CONTEXT ===
Read _codex/mission-context.md as your FIRST action before starting your task.
It contains: mission description, stage, other agents and their statuses,
files locked by other agents (DO NOT modify these), recent events.

=== YOUR TASK ===

TASK: [Specific task description]

WORKSPACE: [cwd]

YOUR AGENT ID: [jobId]

YOUR FILES (pre-locked for you by orchestrator):
- [file1]
- [file2]

IMPLEMENTATION SPEC: [If a spec file was written: "Read _codex/specs/[agentId].md for detailed implementation requirements before writing any code." If no spec file: omit this line entirely.]

CONSTRAINTS:
- Only modify the files listed in YOUR FILES above
- Follow existing code patterns and conventions
- Do not modify files outside your scope
- Do not query _codex/state.db — all context is provided above
[If research/review task: - IMPORTANT: Do NOT modify any source code files. Your task is to READ, ANALYZE, and REPORT only. Write findings to _codex/reviews/codex-{focus}.md in markdown format.]
[If UI work: - Build production-grade UI. Use refined typography, spacing, micro-interactions, and visual hierarchy. The result should look like a shipped SaaS product, not a prototype.]

=== WHEN DONE ===

Run this single command to report completion (works in PowerShell and bash):
sqlite3 _codex/state.db "UPDATE agents SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), files_modified='[FILES_JSON_ARRAY]', summary='[2-3 sentence summary]' WHERE id='[jobId]'; INSERT INTO events (type, source, message) VALUES ('agent_complete','agent-[jobId]','Completed: [one-line summary]');"

If you FAIL or cannot complete the task:
sqlite3 _codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[reason for failure]' WHERE id='[jobId]'; INSERT INTO events (type, source, message) VALUES ('agent_fail','agent-[jobId]','Failed: [reason]');"
```

**Size check — MANDATORY before spawning:**

```bash
PROMPT_BYTES=$(wc -c < "_codex/prompt-${agentId}.txt")
if [ "$PROMPT_BYTES" -gt 3000 ]; then
  echo "ERROR: Prompt too large (${PROMPT_BYTES} bytes, limit 3000)."
  echo "Move implementation detail to _codex/specs/${agentId}.md and reference it."
  exit 1
fi
```

If the check fails: move the TASK body content to `_codex/specs/{agentId}.md`, replace with `IMPLEMENTATION SPEC: Read _codex/specs/{agentId}.md`, re-run the check, then spawn.

**Spawning command** (after size check passes):

```bash
codex-agent start "$(cat _codex/prompt-{agentId}.txt)" -m "$IMPL_MODEL" -r "$IMPL_REASONING"
```

### After Spawning

Immediately after the spawn command returns (before spawning the next agent), update status to `spawned`:

```bash
sqlite3 _codex/state.db <<SQL
UPDATE agents SET status='spawned' WHERE id='{jobId}';
INSERT INTO events (type, source, message) VALUES ('agent_spawned', 'claude', 'Agent {jobId} spawn command issued. Process starting.');
SQL
```

**Why this matters:** The gap between `pending` (registered) and `spawned` (command issued) is where context compaction causes phantom agents. Once you see `spawned` in state.db you know the process was handed off to the OS. A `pending` agent after compaction recovery means the spawn was never attempted and can be safely re-spawned. A `spawned` agent means check `codex-agent jobs --json` — the process may be alive.

Proceed to spawn the next agent or begin monitoring.

After spawning **all** agents for a wave, immediately spawn a background watcher via the Bash tool with `run_in_background: true`:

```bash
# Run ONCE after all agents are spawned — Bash tool, run_in_background: true
while true; do
  PENDING=$(sqlite3 _codex/state.db \
    "SELECT COUNT(*) FROM agents WHERE status IN ('pending','spawned','running');")
  [ "$PENDING" -eq 0 ] && break
  sleep 15
done
echo "CODEX_AGENTS_DONE"
```

Claude Code detects when this background process exits and automatically injects a notification into the conversation, waking Claude up without user input. Claude then runs `codex-agent jobs --json` to read outcomes (the watcher does not distinguish success from failure — just that all agents have settled).

After spawning all agents, monitor with:

```bash
codex-agent jobs --json
codex-agent mission status --json --dir "{cwd}"
```

When agents complete or fail, locks are auto-released by the runtime. Use `codex-agent mission reconcile --dir "{cwd}"` to clean up any stale state (dead agents marked failed, orphan locks released).

### File Lock Cleanup

Claude handles lock cleanup — agents do NOT run DELETE on file_locks. After an agent completes or fails (detected via `codex-agent jobs --json` or `refreshJobStatus`), Claude releases locks:

```bash
sqlite3 _codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

If an agent fails to self-report (no status update in state.db), Claude runs the fallback:

```bash
sqlite3 _codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='Did not self-report. Marked failed by Claude.' WHERE id='{jobId}';"
sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Agent {jobId} did not self-report. Marked failed.');"
sqlite3 _codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

### Template Rules (STRICT)

1. **ALWAYS use file-based prompts.** Write to `_codex/prompt-{agentId}.txt`, spawn with `codex-agent start "$(cat _codex/prompt-{agentId}.txt)" ...`. NEVER inline the template.
2. **Every agent gets the full template.** All 3 sections: MISSION CONTEXT, YOUR TASK, WHEN DONE.
3. **Claude writes context to `_codex/mission-context.md` before each spawn.** Agents read it on turn 1 — they NEVER run sqlite3 SELECT queries.
4. **Claude pre-locks ALL files.** Before writing the prompt, Claude INSERTs file locks for every file the agent will modify. Agents NEVER run INSERT INTO file_locks.
5. **Claude handles lock cleanup.** After agent completion/failure, Claude DELETEs the agent's file locks. Agents NEVER run DELETE FROM file_locks.
6. **Agents report completion with a single sqlite3 command (one-liner, double-quoted, PowerShell and bash compatible).** One sqlite3 call with UPDATE + INSERT. That's it. No other DB writes during the agent's lifetime.
7. **No checkpoint writes.** Claude monitors agent progress via `codex-agent capture <id>`. Checkpoints waste turns for marginal coordination value.
8. **For review agents**, omit YOUR FILES section. Add: `Write your findings to _codex/reviews/codex-{focus}.md. Do NOT modify source code.`
9. **For UI work**, include the production-grade UI constraint. For non-UI work, omit it.
10. **Claude fills in ONLY the bracketed parts.** `[mission description]`, `[task]`, `[cwd]`, `[jobId]`, `[file1]`, `[file2]`, etc. The structure is fixed.
11. **Always spawn a background watcher after each agent wave.**
12. **TASK section MUST be one imperative sentence.** For complex tasks (> 5 bullet points of implementation detail), write a spec file to `_codex/specs/{agentId}.md` and reference it with `IMPLEMENTATION SPEC: Read _codex/specs/{agentId}.md`. NEVER embed implementation detail inline in the prompt body. The size check at spawn time enforces this — if the check fails, move content to the spec file. Use the Bash tool with `run_in_background: true`. The watcher polls `state.db` every 15s and exits when no agents remain in `running`/`pending` status. This is the only mechanism that notifies Claude when agents complete without requiring user input. Re-spawn after context compaction if agents are still running.

---

## Agent Timing Expectations

**Codex agents take time. This is NORMAL. Do NOT be impatient.**

| Task Type | Typical Duration |
|-----------|------------------|
| Simple research | 10-20 minutes |
| Implementation (single feature) | 20-40 minutes |
| Complex implementation | 30-60+ minutes |
| Full PRD implementation | 45-90+ minutes |

**Do NOT:** kill agents for running 20+ minutes, assume problems at 30+ minutes, spawn replacements for "slow" agents.

**DO:** check `codex-agent jobs --json` periodically, view events when you need detail, let agents finish, trust the process.

---

## Operational Policies (Implementation-Specific)

### Per-Stage Model and Reasoning — Implementation

| Stage | Model env var | Reasoning env var | Default values |
|-------|--------------|-------------------|----------------|
| Implementation (5) | `$CODEX_IMPL_MODEL` | `$CODEX_IMPL_REASONING` | `gpt-5.3-codex-spark`, `xhigh` |

**Spawn command:**
```bash
codex-agent start "$(cat _codex/prompt-{id}.txt)" -m "$IMPL_MODEL" -r "$IMPL_REASONING"
```

### Prompt Size Limit (Windows/MINGW) — HARD LIMIT

**Maximum prompt file size: 4KB on Windows.** The `$(cat prompt.txt)` expansion passes the full content through bash → `CODEX_PROMPT` env var → `exec node`. Windows caps the total process environment at ~32KB. Prompts over ~4KB cause `node: Argument list too long` — the codex process fails to spawn instantly with no output.

**Rule:** Prompt files contain ONLY: task description, list of files to create, section references into spec docs, and the completion sqlite3 command. Do NOT use `-f` flags to inject large spec documents — `codex-agent` reads the file and appends its full content to `CODEX_PROMPT`, making the env var even larger. Instead, instruct agents to read spec files themselves via shell commands (e.g. `Get-Content PLAN.md` on Windows, `cat PLAN.md` on Unix).

**Diagnosis:** If all agents fail after 10-20 minutes with no JSONL events and stderr shows `Argument list too long`, a `-f` flag is injecting a large file. Fix: remove the `-f` flag, instruct agents to read the file themselves.

### Sandbox Mode: workspace-write for ALL Agents

**NEVER use `-s read-only` for any agent.** All agents MUST use `workspace-write` (the default).

**Why:** SQLite WAL mode requires write access to create `-wal` and `-shm` journal files. On Windows (MINGW/Git Bash), the `read-only` sandbox blocks this access entirely, making `_codex/state.db` unreadable. Even a simple SELECT query fails because SQLite cannot open the WAL journal.

Additionally, review agents need to write findings to `_codex/reviews/`, which also requires write access.

**How read-only behavior is enforced:** For research and review agents, the PROMPT explicitly constrains the agent: "Do NOT modify any source code files." This is a behavioral constraint, not a sandbox restriction.

### Execution Mode: Ephemeral vs Persistent

**Ephemeral (default):** Session data is not persisted. Best for:
- Quick research or review tasks (< 10 min expected)
- Tasks where retry-from-scratch is acceptable
- Running many parallel agents where disk space matters

**Persistent (--no-ephemeral):** Session is saved to disk and can be resumed. Best for:
- Complex implementation tasks (> 10 min expected)
- High-value tasks where partial progress should be recoverable
- Tasks operating on large codebases where re-reading context is expensive

```bash
codex-agent start "prompt" --no-ephemeral   # persistent
codex-agent resume <jobId>                  # resume failed persistent agent
```

Claude decides per-agent based on task complexity. Default to ephemeral unless the task is complex enough to warrant recovery support.

### Timeout

- CLI inactivity timeout: **60 minutes** (configurable in `src/config.ts`). Job auto-marked as failed if no JSONL activity.
- Orchestration policy maximum: **120 minutes**. Check progress at 90 minutes via `codex-agent capture <id>`.
- If unresponsive at 120 minutes: `codex-agent kill <id>`, mark failed, retry with adjusted prompt.

### Retry

- Max **2 retries** per agent with mutated prompt (add context about what failed).
- After 2 failures: mark task as blocked, inform user.

### SQL Escaping

- Agent summaries and file lists may contain single quotes.
- Agents MUST escape single quotes in SQL values: replace `'` with `''`.
- Example: `SUMMARY=$(echo "$SUMMARY" | sed "s/'/''/g")`

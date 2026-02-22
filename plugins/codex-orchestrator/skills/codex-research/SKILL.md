---
name: codex-research
description: Stage 2 research skill for the codex-orchestrator pipeline. Owns research question decomposition, agent spawn template (read-only behavioral constraint), and synthesis setup. Invoked by codex-orchestrator at Stage 2.
triggers:
  - codex-research
---

# Codex Research — Stage 2 Skill

This skill owns **Stage 2 (Research)** of the codex-orchestrator pipeline. It is invoked by the orchestrator after ideation and returns when all research agents have completed and their findings are ready for synthesis.

**Owns:**
- Research question decomposition
- Agent spawn template (read-only behavioral constraint via prompt — NOT `-s read-only` sandbox)
- Return condition: all research agents `completed` in `state.db`

**Does NOT own:**
- Source code modification (research agents are read-only by prompt constraint)
- Synthesis (that is Stage 3 — Claude's job after this skill returns)
- SQLite schema (defined in codex-orchestrator)
- File locks (research agents do not lock files — they write only to `_codex/reviews/`)

---

## Stage 2: Research

Decompose the research into focused, independent questions. Each question becomes a single Codex agent. Spawn all agents in parallel (up to 5).

**What research agents do:**
- Read source files, documentation, existing code
- Write findings to `_codex/reviews/research-{focus}.md`
- Do NOT modify source code
- Do NOT lock files (they only write to `_codex/reviews/`)

**Return condition:** All research agents show `status = 'completed'` or `'failed'` in `state.db`. Claude then returns to the orchestrator for Stage 3 (Synthesis).

---

## Spawning Research Agents

Research agents use the same spawn template as `codex-implement` with two differences:
1. The CONSTRAINTS block includes a hard read-only instruction
2. The WHEN DONE block writes findings to a markdown file, not a source file

**Why `workspace-write` sandbox even for read-only agents:** SQLite WAL mode requires write access to create `-wal` and `-shm` journal files. The `read-only` sandbox blocks this on Windows/MINGW, making `_codex/state.db` unreadable. Read-only behavior is enforced via the prompt CONSTRAINTS, not via sandbox.

### Before Spawning Each Agent

1. Read mission context:
```bash
codex-agent mission status --json --dir "{cwd}"
```

2. Register agent (NO file locks for research agents):
```bash
sqlite3 _codex/state.db <<SQL
INSERT INTO agents (id, task, sandbox) VALUES ('{jobId}', '{task}', 'workspace-write');
INSERT INTO events (type, source, message) VALUES ('agent_spawn', 'claude', 'Spawned research agent {jobId}: {task}');
UPDATE agents SET status='running' WHERE id='{jobId}';
INSERT INTO events (type, source, message) VALUES ('agent_start', 'claude', 'Research agent {jobId} started');
SQL
```

3. Generate context:
```bash
CONTEXT=$(codex-agent mission context --dir "{cwd}")
```

4. Write prompt file (`_codex/prompt-{agentId}.txt`):

```
=== MISSION CONTEXT (pre-loaded by orchestrator — do not query the database) ===
{output of: codex-agent mission context --dir "{cwd}"}

=== YOUR RESEARCH TASK ===

TASK: [Specific research question — e.g., "Investigate how X is implemented in the codebase"]

WORKSPACE: [cwd]

YOUR AGENT ID: [jobId]

RESEARCH FOCUS: [focus area — used in output filename]

CONSTRAINTS:
- IMPORTANT: Do NOT modify any source code files. Your task is READ, ANALYZE, and REPORT only.
- Do not query _codex/state.db — all context is provided above
- Do not create new source files
- You MAY write to _codex/reviews/research-{focus}.md

OUTPUT:
Write your findings to: _codex/reviews/research-{focus}.md

Structure your findings as:
## Summary
[2-3 sentence overview]

## Key Findings
[Bullet list of discoveries]

## Relevant Files
[Files examined, with brief notes]

## Recommendations
[What this means for implementation]

=== WHEN DONE ===

After writing your findings file, run this single command:

sqlite3 _codex/state.db <<'DONE'
UPDATE agents SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), files_modified='["_codex/reviews/research-[focus].md"]', summary='[2-3 sentence summary of key findings]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_complete', 'agent-[jobId]', 'Research complete: [one-line finding]');
DONE

If you FAIL:

sqlite3 _codex/state.db <<'FAIL'
UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[reason]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_fail', 'agent-[jobId]', 'Failed: [reason]');
FAIL
```

5. Spawn:
```bash
codex-agent start "$(cat _codex/prompt-{agentId}.txt)" --map -m "$CODEX_MODEL" -r "$CODEX_REASONING"
```

### Background Watcher

After spawning all research agents, spawn a background watcher:

```bash
# Bash tool, run_in_background: true
while true; do
  PENDING=$(sqlite3 _codex/state.db \
    "SELECT COUNT(*) FROM agents WHERE status IN ('running','pending');")
  [ "$PENDING" -eq 0 ] && break
  sleep 15
done
echo "CODEX_AGENTS_DONE"
```

### After All Agents Complete

Read all findings files:
```bash
# List what was written
sqlite3 _codex/state.db "SELECT id, summary FROM agents WHERE status='completed';"
# Read each findings file
# _codex/reviews/research-{focus}.md for each completed agent
```

Return to orchestrator — Stage 3 (Synthesis) begins.

---

## Lock Cleanup

Research agents do not hold file locks. No lock cleanup needed after completion.

If an agent fails to self-report:
```bash
sqlite3 _codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='Did not self-report.' WHERE id='{jobId}';"
sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Research agent {jobId} did not self-report.');"
```

---

## Operational Policies

### Model and Reasoning

```bash
codex-agent start "$(cat _codex/prompt-{id}.txt)" -m "$CODEX_MODEL" -r "$CODEX_REASONING"
# Defaults: gpt-5.3-codex-spark, xhigh
```

### Prompt Size (Windows/MINGW)

Keep prompt files under 4KB. Never embed file content in the prompt — instruct agents to read files themselves.

### Timing

| Research Type | Typical Duration |
|--------------|-----------------|
| Single-file investigation | 10-15 minutes |
| Module/subsystem survey | 15-25 minutes |
| Cross-codebase analysis | 20-35 minutes |

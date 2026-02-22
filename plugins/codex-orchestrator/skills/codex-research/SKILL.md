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

## Research Mode

Read RESEARCH_MODE from env before doing anything else:

```bash
RESEARCH_MODE="${CODEX_RESEARCH_MODE:-claude}"
```

| Mode | When to use | Agents |
|------|-------------|--------|
| `claude` (default) | Greenfield, codebase analysis, web research | Claude subagents via Task tool |
| `codex` | Research requires compilation/execution validation | Codex agents (`$CODEX_RESEARCH_MODEL`, high) |
| `hybrid` | Synthesis from Claude + execution validation from Codex | Both |

---

## If RESEARCH_MODE=claude (default) — Claude Subagent Path

For each research question, spawn a Task tool subagent:
- `subagent_type=Explore` → codebase reads (Glob, Grep, Read)
- `subagent_type=general-purpose` → web/docs research (WebSearch, WebFetch)

Claude collects results in-memory and writes findings directly to
`_codex/reviews/research-{focus}.md` after all subagents complete.

**No state.db agent registration. No background watcher. No WHEN DONE block.**
Return to orchestrator for Stage 3 immediately after all subagents complete.

---

## If RESEARCH_MODE=codex or hybrid — Codex Agent Path

Spawn Codex agents using the template below. Research agents use the same spawn
template as `codex-implement` with two differences:
1. The CONSTRAINTS block includes a hard read-only instruction
2. The WHEN DONE block writes findings to a markdown file, not a source file

**Why `workspace-write` sandbox even for read-only agents:** SQLite WAL mode requires write access to create `-wal` and `-shm` journal files. The `read-only` sandbox blocks this on Windows/MINGW, making `_codex/state.db` unreadable. Read-only behavior is enforced via the prompt CONSTRAINTS, not via sandbox.

### Before Spawning Each Agent

1. Read mission context:
```bash
codex-agent mission status --json --dir "{cwd}"
```

2. Register agent as `pending` (NO file locks for research agents):
```bash
sqlite3 _codex/state.db <<SQL
INSERT INTO agents (id, task, sandbox) VALUES ('{jobId}', '{task}', 'workspace-write');
INSERT INTO events (type, source, message) VALUES ('agent_registered', 'claude', 'Registered research agent {jobId} (pending): {task}');
SQL
```

3. Write mission context to file — do NOT embed in prompt:
```bash
codex-agent mission context --dir "{cwd}" > "_codex/mission-context.md"
```

4. Read model config from env vars:
```bash
RESEARCH_MODEL="${CODEX_RESEARCH_MODEL:-gpt-5.3-codex}"
RESEARCH_REASONING="${CODEX_RESEARCH_REASONING:-high}"
```

5. Write prompt file (`_codex/prompt-{agentId}.txt`):

```
=== MISSION CONTEXT ===
Read _codex/mission-context.md as your FIRST action before starting your task.
It contains: mission description, stage, other agents and their statuses,
files locked by other agents (DO NOT modify these), recent events.

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

⚠️ === MANDATORY FINAL STEP — DO NOT SKIP === ⚠️

Writing the findings file is NOT sufficient. The mission will deadlock if you do not run the sqlite3 command below.
You MUST execute this shell command as your absolute last action, even if you think you are done:

sqlite3 _codex/state.db <<'DONE'
UPDATE agents SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), files_modified='["_codex/reviews/research-[focus].md"]', summary='[2-3 sentence summary of key findings]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_complete', 'agent-[jobId]', 'Research complete: [one-line finding]');
DONE

Do not exit, do not say "done", do not stop — until AFTER the sqlite3 command above has been executed successfully.

If you FAIL (for any reason):

sqlite3 _codex/state.db <<'FAIL'
UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[reason]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_fail', 'agent-[jobId]', 'Failed: [reason]');
FAIL
```

6. Spawn, then immediately mark `spawned`:
```bash
codex-agent start "$(cat _codex/prompt-{agentId}.txt)" -m "$RESEARCH_MODEL" -r "$RESEARCH_REASONING"
sqlite3 _codex/state.db <<SQL
UPDATE agents SET status='spawned' WHERE id='{jobId}';
INSERT INTO events (type, source, message) VALUES ('agent_spawned', 'claude', 'Research agent {jobId} spawn command issued.');
SQL
```

### Background Watcher (codex/hybrid mode only)

**Only needed when RESEARCH_MODE=codex or hybrid.** Not needed for claude mode.

After spawning all Codex research agents, spawn a background watcher:

```bash
# Bash tool, run_in_background: true
while true; do
  PENDING=$(sqlite3 _codex/state.db \
    "SELECT COUNT(*) FROM agents WHERE status IN ('pending','spawned','running');")
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

### Model and Reasoning (Codex path only)

```bash
RESEARCH_MODEL="${CODEX_RESEARCH_MODEL:-gpt-5.3-codex}"
RESEARCH_REASONING="${CODEX_RESEARCH_REASONING:-high}"
codex-agent start "$(cat _codex/prompt-{id}.txt)" -m "$RESEARCH_MODEL" -r "$RESEARCH_REASONING"
```

Claude subagent path (default) uses no Codex model — subagents inherit Claude's model.

### Prompt Size (Windows/MINGW)

Keep prompt files under 4KB. Never embed file content in the prompt — instruct agents to read files themselves.

### Timing

| Research Type | Typical Duration |
|--------------|-----------------|
| Single-file investigation | 10-15 minutes |
| Module/subsystem survey | 15-25 minutes |
| Cross-codebase analysis | 20-35 minutes |

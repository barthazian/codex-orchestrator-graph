# Skill Graph Architecture

_Initial design captured 2026-02-21. Updated to reflect completed implementation._

## Problem This Solved

The original `codex-orchestrator` SKILL.md was ~1,010 lines — both the graph routing logic AND all stage node implementations in a single file. Claude loaded the full 1,010 lines on every invocation (~15-20k tokens before any work began).

Stage 6 was duplicated: the SKILL.md described the full review protocol inline AND `codex-reviewer.md` implemented the same protocol as a standalone agent. They drifted out of sync whenever either was updated.

---

## Graph Topology

```
USER
  |
  v
codex-orchestrator  ← graph traversal, state machine, coordination only
  |
  |--[Stage 2]--> codex-research   skill
  |--[Stage 4]--> codex-prd        skill
  |--[Stage 5]--> codex-implement  skill
  |--[Stage 6]--> codex-reviewer   agent
  |--[Stage 7]--> codex-test       skill
```

Edges are conditional transitions read from `_codex/state.db`. Orchestrator reads `mission.stage`, invokes the right skill via the `Skill` tool, waits for return, reads outcome, decides next edge.

No direct skill-to-skill calls. Everything routes through the orchestrator.

---

## Node Responsibilities

| Node | Owns | Does NOT own |
|------|------|-------------|
| `codex-orchestrator` | Graph topology, stage transitions, state.db protocol, prereq gates, mission init, user interaction | Stage-specific spawn templates, timing, review protocol |
| `codex-research` | Stage 2 spawn template, research synthesis pattern (claude/codex/hybrid modes) | Anything outside Stage 2 |
| `codex-prd` | PRD format, user approval loop, auto-approve flag | Agent spawning |
| `codex-implement` | Stage 5 spawn template, file locks, artifact gate, background watcher, build verification, timing, spec file protocol | Review logic |
| `codex-reviewer` | Full dual-model review: Codex CLI + 5 Claude agents → KEEP/DISCARD/ELEVATE → synthesis.md | Everything else |
| `codex-test` | Stage 7 spawn template, spec-first mode, language-aware preflight, coverage verification | Implementation |

---

## Transition Conditions

```
ideation   → research    when: user confirms scope
research   → synthesis   when: all research agents in state.db = completed/failed
synthesis  → prd         when: Claude writes synthesis to events table
prd        → implement   when: user explicitly approves PRD (or CODEX_AUTO_APPROVE=1)
implement  → review      when: artifact gate passes (no running agents, no locks, build clean)
review     → implement   when: ELEVATE/CRITICAL findings exist (loop back for fixes)
review     → test        when: no ELEVATE/CRITICAL findings
test       → done        when: all tests pass + coverage >= 80%
```

---

## How Skills Are Invoked

```
Skill("codex-research")  → stage skill runs → findings written → returns
Skill("codex-prd")       → stage skill runs → PRD approved → returns
Skill("codex-implement") → stage skill runs → build gate passes → returns
Skill("codex-reviewer")    → agent runs → synthesis.md written → returns
Skill("codex-test")      → stage skill runs → tests pass → returns
```

---

## Actual File Sizes (Post-Implementation)

| Skill | Lines | Notes |
|-------|-------|-------|
| `codex-orchestrator` | ~500 | Graph routing + SQLite schema + monitoring |
| `codex-implement` | ~400 | Full spawn template, all gates, operational policies |
| `codex-research` | ~200 | claude/codex/hybrid modes + spawn template |
| `codex-prd` | ~100 | PRD format + approval loop |
| `codex-test` | ~280 | Spec-first mode + language preflight + spawn template |
| `codex-reviewer` | ~110 | Dual-model review protocol (agent, not skill) |

**Context loaded per turn:**
- Before: 1,010 lines always
- After: ~500 (orchestrator) + ~100–400 (active stage skill)
- Reduction: ~35–60% per turn

---

## Hardening Changes (Post-Initial Design)

These were not in the original design and were added after operational experience.

### 1. Three-Status Agent Progression

Original design had two statuses: `running` (on register) and `completed`/`failed`. This created phantom agents when context compaction happened between registration and the `codex-agent start` command — the DB showed `running` but no process existed.

**Solution:** Three statuses enforced across all spawning skills:
- `pending` = registered, spawn command not yet issued (safe to re-spawn)
- `spawned` = command issued, process handed to OS (check `codex-agent jobs --json`)
- `running` = agent self-reported start (legacy; agents may skip this)

SQL schema updated: `CHECK (status IN ('pending', 'spawned', 'running', 'completed', 'failed'))`

### 2. Two-Checkpoint Blackboard Protocol

Original design had a single post-gate checkpoint. If compaction happened mid-stage (between spawning agents and the artifact gate), recovery was ambiguous — the checkpoint showed the previous stage's state.

**Solution:** Two checkpoints per stage gate:
- **Checkpoint A (pre-execution):** Written before registering any agent. Content: `stage`, `planned_agents` (names + file lists). Recovery anchor — if compaction mid-stage, this checkpoint shows what was planned vs what `state.db` shows was completed.
- **Checkpoint B (post-gate):** Written after `mission.stage` updates. Full completed picture.

Supersede chain in memoryd ensures only the current checkpoint is returned on `memory_bootstrap`.

### 3. Spec Files for Complex Tasks (Option B)

Original design embedded all task detail inline in the prompt body. For cross-cutting tasks (touching multiple modules), implementation detail exceeded the Windows env-block limit (~32KB total, ~4KB safe per prompt).

**Solution:** For tasks with >5 bullet points, Claude writes `_codex/specs/{agentId}.md` before spawning. Prompt body contains one imperative sentence + `IMPLEMENTATION SPEC: Read _codex/specs/{agentId}.md`.

**Hard 3KB size check** runs before every `codex-agent start` — fails with exit code 1 if over limit. Added to `codex-implement` and `codex-test`.

### 4. No `-f` Flag

Codex CLI `-f file.txt` appends full file content to `CODEX_PROMPT` env var, exhausting the Windows ~32KB process environment limit. Agents read files themselves during their turns. The `-f` flag reference was removed from all spawn commands and the CRITICAL guidance note.

---

## What Stays in `codex-orchestrator` SKILL.md

| Section | Status |
|---------|--------|
| Command structure | Kept |
| Critical rules (5 rules) | Kept |
| Prerequisites — git check, install script reference | Kept |
| Pipeline overview + stage detection table | Kept (stage internals stripped) |
| SQLite schema + write ownership table | Kept — shared by all skills |
| CLI reference — monitoring commands | Kept |
| Operational policies — shared (sandbox, model selection) | Kept |
| Error recovery — post-compaction recovery | Kept |
| Blackboard checkpoint protocol | Kept — two-checkpoint design |
| Spawning template | Moved to `codex-implement` |
| Agent timing expectations | Moved to `codex-implement` |
| Stage 6 inline review protocol | Replaced with one-paragraph `Skill("codex-reviewer")` invocation |

---

## Stage 6 Deduplication

The original SKILL.md described the full review protocol inline (~130 lines), identical to `codex-reviewer.md`. After decomposition, Stage 6 in the orchestrator SKILL.md is:

```
### Stage 6: Review

Skill("codex-reviewer")

The `codex-reviewer` agent runs the full dual-model review protocol
(deterministic gate → codex review → 5 Claude agents → orchestrating Claude
judgment → synthesis). It is the authoritative source for Stage 6 — do not
re-implement its protocol here.

After it returns, check _codex/reviews/synthesis.md for ELEVATE/CRITICAL findings:
- If any exist: loop back to Stage 5 (spawn fix agents via codex-implement)
- If none: advance to Stage 7
```

Full protocol lives only in `codex-reviewer.md`. No duplication.

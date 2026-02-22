# Skill Graph Implementation Plan

_Captured: 2026-02-21_

## Problem

The current `codex-orchestrator` SKILL.md is 1,010 lines — both the graph (routing logic) AND all node implementations (how to do research, implement, review, test). Claude loads the full 1,010 lines on every invocation, consuming ~15-20k tokens before any work begins.

Stage 6 is duplicated: the SKILL.md describes the full review protocol inline AND `codex-reviewer.md` implements the same protocol as a standalone agent. They are out of sync whenever either is updated.

---

## Graph Topology

```
USER
  |
  v
codex-orchestrator  ← graph traversal, state machine, coordination only
  |
  |--[Stage 2]--> codex-research   skill  (new)
  |--[Stage 4]--> codex-prd        skill  (new, lightweight)
  |--[Stage 5]--> codex-implement  skill  (new)
  |--[Stage 6]--> codex-reviewer   agent  (already exists — just invoke it)
  |--[Stage 7]--> codex-test       skill  (new)
```

Edges are conditional transitions read from `_codex/state.db`. Orchestrator reads `mission.stage`, invokes the right skill via the `Skill` tool, waits for return, reads outcome, decides next edge.

---

## Node Responsibilities

| Node | Owns | Does NOT own |
|------|------|-------------|
| `codex-orchestrator` | Graph topology, stage transitions, state.db protocol, prereq gates, mission init, user interaction | Stage-specific spawn templates, timing, review protocol |
| `codex-research` | Stage 2 spawn template, research synthesis pattern | Anything outside Stage 2 |
| `codex-prd` | PRD format, user approval loop | Agent spawning |
| `codex-implement` | Stage 5 spawn template, file locks, artifact gate, background watcher, build verification, timing | Review logic |
| `codex-reviewer` | Full dual-model review (already complete — DO NOT duplicate) | Everything else |
| `codex-test` | Stage 7 spawn template, coverage verification | Implementation |

---

## Transition Conditions (Edge Logic)

```
ideation   → research    when: user confirms scope
research   → synthesis   when: all research agents in state.db = completed
synthesis  → prd         when: Claude writes synthesis to events table
prd        → implement   when: user explicitly approves PRD
implement  → review      when: artifact gate passes (no running agents, no locks, build clean)
review     → implement   when: ELEVATE/CRITICAL findings exist (loop back for fixes)
review     → test        when: no ELEVATE/CRITICAL findings
test       → done        when: all tests pass
```

---

## How Skills Are Invoked

Orchestrator uses the `Skill` tool at each stage transition:

```
Skill("codex-research")   → stage skill runs → updates state.db → returns
Skill("codex-implement")  → stage skill runs → updates state.db → returns
Skill("codex-reviewer")   → agent runs       → synthesis.md written → returns
Skill("codex-test")       → stage skill runs → updates state.db → returns
```

No direct skill-to-skill calls. Everything routes through the orchestrator.

---

## File Structure (Target State)

```
~/.claude/plugins/marketplaces/codex-orchestrator-marketplace/
└── plugins/codex-orchestrator/
    ├── skills/
    │   ├── codex-orchestrator/SKILL.md   (~300 lines — graph only)
    │   ├── codex-research/SKILL.md       (~150 lines — new)
    │   ├── codex-implement/SKILL.md      (~350 lines — new)
    │   ├── codex-prd/SKILL.md            (~100 lines — new)
    │   └── codex-test/SKILL.md           (~100 lines — new)
    └── commands/
        └── codex-orchestrator.md         (unchanged stub)

~/.claude/agents/
└── codex-reviewer.md                     (already exists — unchanged)
```

---

## What Stays in `codex-orchestrator` SKILL.md

| Section | Action |
|---------|--------|
| Command structure (Section 1) | Keep |
| Critical rules (Section 2) | Keep, condense |
| Prerequisites — git, health checks (Section 3) | Keep |
| Pipeline overview + stage detection table (Section 4) | Keep table only — strip stage internals |
| SQLite schema + write ownership table (Section 5) | Keep — shared by all skills |
| Spawning template (Section 6) | **Move to `codex-implement`** |
| CLI reference — monitoring commands (Section 7) | Keep |
| CLI reference — spawn flags | Move to stage skills |
| Operational policies — shared (sandbox, timeout, retry, model selection) (Section 8) | Keep |
| Error recovery — shared (Section 9) | Keep |
| Agent timing expectations (Section 10) | **Move to `codex-implement`** |
| When not to use (Section 11) | Keep |

---

## Stage 6 Fix (Deduplication)

The SKILL.md Stage 6 currently describes the full review protocol inline (~130 lines), which is identical to `codex-reviewer.md`. After decomposition:

**SKILL.md Stage 6 becomes:**
```
### Stage 6: Review

Invoke the `codex-reviewer` agent. It runs the full dual-model review protocol
(deterministic gate → codex review → 5 Claude agents → orchestrating Claude judgment → synthesis).

After it returns, check synthesis.md for ELEVATE/CRITICAL findings:
- If any exist: loop back to Stage 5 (spawn fix agents)
- If none: advance to Stage 7
```

Full protocol lives ONLY in `codex-reviewer.md`. No duplication.

---

## Size Projection

| State | Lines loaded per turn |
|-------|-----------------------|
| Now (monolith) | 1,010 always |
| After decomposition | ~300 (orchestrator) + ~100–350 (active stage skill) |
| **Reduction** | **35–60% per turn** |

---

## Build Order

1. **Extract `codex-implement`** — biggest payoff, most content to move (spawn template, file locks, watcher, build gate, timing)
2. **Extract `codex-research`** — second biggest, mostly spawn template + synthesis pattern
3. **Slim `codex-orchestrator` SKILL.md** — remove moved sections, replace Stage 6 with codex-reviewer invocation
4. **Create `codex-test`** — small, mostly new content
5. **Create `codex-prd`** — smallest, mostly format + approval loop
6. **Verify `codex-reviewer` agent** — confirm it needs no changes

---

## Key Decisions

- Skills share state via `state.db` only — no direct skill-to-skill data passing
- Each stage skill is independently invocable (can run Stage 5 directly without full orchestration)
- `codex-reviewer` agent is the authoritative source for Stage 6 — SKILL.md never duplicates it again
- Background watcher (Rule 11) moves to `codex-implement` — it's implementation-stage specific
- Per-stage model/reasoning config (`CODEX_MODEL`, `CODEX_REVIEW_MODEL`, etc.) stays in each stage skill

# codex-orchestrator-graph

Refactored codex-orchestrator using a skill graph architecture. The original monolith (~1,010 lines loaded every turn) is decomposed into stage-specific skills loaded on demand.

## Status

| Skill | Status | Lines |
|-------|--------|-------|
| `codex-orchestrator` | Done (slimmed) | ~350 |
| `codex-implement` | Done (extracted) | ~350 |
| `codex-research` | Stub | — |
| `codex-prd` | Stub | — |
| `codex-test` | Stub | — |
| `codex-reviewer` | Unchanged (lives in ~/.claude/agents/) | — |

## Design

See `docs/skill-graph-design.md` for the full design rationale, graph topology, transition conditions, and build order.

## Token savings

| State | Lines loaded per turn |
|-------|-----------------------|
| Monolith (before) | 1,010 always |
| After decomposition | ~350 (orchestrator) + ~350 (active stage skill) |
| Reduction | ~30–65% per turn |

## Structure

```
plugins/codex-orchestrator/
├── skills/
│   ├── codex-orchestrator/SKILL.md   # graph/routing only
│   ├── codex-implement/SKILL.md      # Stage 5 — spawn template, gates, timing
│   ├── codex-research/SKILL.md       # Stage 2 (stub)
│   ├── codex-prd/SKILL.md            # Stage 4 (stub)
│   └── codex-test/SKILL.md           # Stage 7 (stub)
└── commands/
    └── codex-orchestrator.md
```

`codex-reviewer` agent is unchanged and lives in `~/.claude/agents/`.

## Current install (unchanged)

The production install at `~/.claude/plugins/marketplaces/codex-orchestrator-marketplace/` is **not affected** by this repo. Test here first, swap when ready.

---
name: codex-research
description: Stage 2 research skill for the codex-orchestrator pipeline. Owns research agent spawn templates, question decomposition, and synthesis pattern. Invoked by codex-orchestrator at Stage 2.
triggers:
  - codex-research
---

# Codex Research — Stage 2 Skill

> **STATUS: STUB** — Content to be extracted from codex-orchestrator Stage 2 description and codex-implement spawn template (adapted for read-only behavior).

This skill owns **Stage 2 (Research)** of the codex-orchestrator pipeline.

**Owns:**
- Research question decomposition
- Agent spawn template (adapted from codex-implement — read-only behavioral constraint in prompt)
- Research synthesis pattern
- Return condition: all research agents completed

**Does NOT own:**
- Source code modification (research agents are read-only by prompt constraint)
- SQLite schema
- Synthesis write (that is Stage 3, Claude's job)

## TODO

Extract from current monolith:
- Stage 2 description (Section 4 of original SKILL.md)
- Spawn template (shared with codex-implement, adapted with read-only constraint)
- `workspace-write` sandbox rationale (WAL mode requires write access even for read-only agents)

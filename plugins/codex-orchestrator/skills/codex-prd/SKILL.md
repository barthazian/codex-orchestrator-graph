---
name: codex-prd
description: Stage 4 PRD skill for the codex-orchestrator pipeline. Owns PRD format, user approval loop, and file writing to docs/prds/. Invoked by codex-orchestrator at Stage 4.
triggers:
  - codex-prd
---

# Codex PRD — Stage 4 Skill

> **STATUS: STUB** — Content to be extracted from codex-orchestrator Stage 4 description.

This skill owns **Stage 4 (PRD Creation)** of the codex-orchestrator pipeline.

**Owns:**
- PRD markdown format template
- User approval loop (wait for explicit approval before returning)
- File writing to `docs/prds/`
- Return condition: user explicitly approves the PRD

**Does NOT own:**
- Agent spawning (no agents at this stage)
- SQLite schema

## TODO

Extract from current monolith:
- Stage 4 description + PRD template (Section 4 of original SKILL.md)

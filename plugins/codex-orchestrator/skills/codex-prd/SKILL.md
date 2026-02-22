---
name: codex-prd
description: Stage 4 PRD skill for the codex-orchestrator pipeline. Owns PRD format, user approval loop, and writing to docs/prds/. Invoked by codex-orchestrator after synthesis. Returns only after user explicitly approves.
triggers:
  - codex-prd
---

# Codex PRD — Stage 4 Skill

This skill owns **Stage 4 (PRD Creation)** of the codex-orchestrator pipeline. It is invoked after synthesis and returns only after the user has explicitly approved the PRD.

**Owns:**
- PRD markdown format template
- User approval loop (MUST wait for explicit user "approve" / "looks good" / "proceed")
- File writing to `docs/prds/{feature-name}.md`
- Updating `mission.stage` to `'implement'` after approval

**Does NOT own:**
- Agent spawning (no Codex agents at this stage)
- Synthesis (that is Stage 3 — Claude already did it before invoking this skill)
- Implementation (that begins after this skill returns)

---

## Stage 4: PRD Creation

For significant changes, Claude writes a PRD in `docs/prds/`. The PRD is reviewed with the user before implementation begins.

**When to skip PRD:** For trivial changes (single-file bug fix, minor refactor) where scope is already clear and agreed, skip the PRD and advance directly to Stage 5. Ask the user first.

### PRD Format

Write to `docs/prds/{kebab-case-feature-name}.md`:

```markdown
# [Feature/Fix Name]

## Problem
[What's broken or missing — 2-4 sentences, concrete]

## Solution
[High-level approach — what will be built, not how]

## Requirements
- [Specific, testable requirement 1]
- [Specific, testable requirement 2]
- [Specific, testable requirement 3]

## Implementation Plan

### Phase 1: [Name]
- [ ] Task 1 — [assigned file(s)]
- [ ] Task 2 — [assigned file(s)]

### Phase 2: [Name]
- [ ] Task 3 — [assigned file(s)]

## Files to Modify
- `path/to/file.rs` — [what changes and why]
- `path/to/other.rs` — [what changes and why]

## Files to Create
- `path/to/new.rs` — [purpose]

## Testing
- [ ] Unit test: [what to test]
- [ ] Integration test: [what scenario]
- [ ] Build passes: `cargo check` (or equivalent)

## Success Criteria
- [Measurable outcome 1]
- [Measurable outcome 2]
- Build is clean, all tests pass
```

### Writing the PRD

1. Write the PRD file using the template above
2. Present the PRD to the user: paste the key sections (Problem, Solution, Implementation Plan) in the conversation

### Auto-Approve Check

Before waiting for user approval, check:
```bash
AUTO_APPROVE="${CODEX_AUTO_APPROVE:-0}"
```

If `AUTO_APPROVE=1`:
- Skip user approval gate
- Log: `sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('auto_approve', 'claude', 'PRD auto-approved. Advancing to Stage 5.');"`
- Proceed directly to After User Approval steps

If `AUTO_APPROVE=0` (default):
3. **Wait for explicit user approval** — do NOT advance to Stage 5 until the user says something like "approved", "looks good", "proceed", "go ahead", or equivalent

### After User Approval

1. Update `mission.stage` to `'implement'`:
```bash
sqlite3 _codex/state.db "UPDATE mission SET stage='implement', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=1;"
sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('stage_transition', 'claude', 'PRD approved. Advancing to implementation.');"
```

2. Write blackboard checkpoint (see Section 5 of codex-orchestrator):
```
memory_remember_candidate(tier="blackboard", title="codex-mission-checkpoint:{project_id}", ...)
```
Supersede old checkpoint, store new id in `mission.blackboard_checkpoint_id`.

3. Return to orchestrator — `Skill("codex-implement")` is next.

---

## PRD Quality Checklist

Before presenting to user, verify:
- [ ] Problem statement is concrete — not vague ("improve performance") but specific ("P99 latency exceeds 500ms on /api/orders")
- [ ] Every requirement is testable — can write a test that passes or fails
- [ ] File list is complete — no file is modified that isn't listed
- [ ] Implementation phases are independent — Phase 2 doesn't depend on Phase 1 internals
- [ ] Success criteria are measurable — not "it works" but "cargo test passes, no warnings"

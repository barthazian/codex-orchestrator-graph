---
name: codex-reviewer
description: Stage 6 code review for the codex-orchestrator pipeline. Delegates to the codex-reviewer agent (defined in ~/.claude/agents/codex-reviewer.md). This is a thin wrapper — the agent definition owns the full dual-model review protocol.
triggers:
  - codex-reviewer
  - codex review
  - stage 6 review
---

# Codex Reviewer — Stage 6 Skill (Delegation Wrapper)

This skill delegates to the **codex-reviewer agent** defined at `~/.claude/agents/codex-reviewer.md`.

## How to invoke

Use the **Agent tool** with `subagent_type="codex-reviewer"`:

```
Agent(
  subagent_type="codex-reviewer",
  description="Stage 6 code review",
  prompt="Review the changes in scope. Follow your codex-reviewer agent protocol."
)
```

## Why this wrapper exists

All other codex pipeline stages (codex-research, codex-prd, codex-implement, codex-test, codex-evaluate) are registered as **Skills**. Stage 6 (codex-reviewer) was only registered as an **Agent**. This naming inconsistency causes the model to try `Skill(codex-reviewer)` after context compaction — which fails with "Unknown skill". This thin wrapper resolves that error and redirects to the correct Agent invocation.

## Protocol (owned by the agent definition)

The agent file is the single source of truth for the review protocol:

1. Deterministic gate (build/check)
2. Freeze diff scope
3. Codex review (if CLI available)
4. 5 parallel Claude review agents (CLAUDE.md compliance, bugs, error handling, security, trading safety)
5. Orchestrating Claude judges KEEP/DISCARD/ELEVATE
6. Synthesis report to `_codex/reviews/synthesis.md`
7. Optional PR review via `code-review:code-review`

**Do NOT duplicate the protocol here.** Always defer to the agent definition.

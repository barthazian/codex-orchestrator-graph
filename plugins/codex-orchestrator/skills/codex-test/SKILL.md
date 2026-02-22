---
name: codex-test
description: Stage 7 testing skill for the codex-orchestrator pipeline. Owns test agent spawn templates, test execution, and coverage verification. Invoked by codex-orchestrator at Stage 7.
triggers:
  - codex-test
---

# Codex Test — Stage 7 Skill

> **STATUS: STUB** — Mostly new content (Stage 7 had minimal content in the original monolith).

This skill owns **Stage 7 (Testing)** of the codex-orchestrator pipeline.

**Owns:**
- Test agent decomposition (what to test, which files)
- Spawn template (adapted from codex-implement for test-writing agents)
- Test execution and result collection
- Coverage verification
- Return condition: all tests pass

**Does NOT own:**
- Source code modification (fix agents go back through codex-implement)
- SQLite schema

## TODO

Write Stage 7 content:
- Test agent spawn template (reuse codex-implement template, test-specific constraints)
- Coverage gate (language-agnostic: cargo test, pytest --cov, jest --coverage, go test -cover)
- Failure handling: if tests fail, return findings to orchestrator for Stage 5 loop-back

---
name: codex-test
description: Stage 7 testing skill for the codex-orchestrator pipeline. Owns test agent decomposition, spawn template, test execution gate, and coverage verification. Invoked by codex-orchestrator after review passes. Returns when all tests pass.
triggers:
  - codex-test
---

# Codex Test — Stage 7 Skill

This skill owns **Stage 7 (Testing)** of the codex-orchestrator pipeline. It is invoked after Stage 6 review passes (no ELEVATE/CRITICAL findings) and returns when all tests pass and coverage meets the threshold.

**Owns:**
- Test decomposition (what to test, which files)
- Agent spawn template (adapted from codex-implement, test-specific constraints)
- Test execution gate (run tests on host after agents write test files)
- Coverage verification
- Return condition: tests pass + coverage met
- Failure path: if tests fail, return findings to orchestrator for Stage 5 loop-back

**Does NOT own:**
- Source code fixes (failures loop back through `codex-implement`)
- SQLite schema
- Review logic (that is `codex-reviewer`)

---

## Test Mode

Read TEST_MODE from env before doing anything else:

```bash
TEST_MODE="${CODEX_TEST_MODE:-spec-first}"
```

| Mode | Description |
|------|-------------|
| `spec-first` (default) | Claude writes test specs with exact inputs/outputs → Codex agents implement from spec |
| `codex-direct` | Codex agents read source and write tests directly (legacy behavior) |

### If TEST_MODE=spec-first (default)

Before spawning any test agents:
1. Claude reads all source files under test directly (Read tool — no agent needed)
2. Claude writes `_codex/test-specs/test-spec-{module}.md` for each module:
   - Exact function signatures
   - Exact input values and expected outputs (verified by Claude against source logic)
   - Edge cases and error paths
3. Codex agents receive the spec file path — implement tests from spec only
   - Prompt includes: `"Read _codex/test-specs/test-spec-{module}.md for the exact test cases to implement. Do not invent test cases — use only what's in the spec."`
4. This eliminates wrong-expected-value errors (Claude verifies logic before any agent codes)

---

## Language-Aware Pre-Flight Check

Before spawning **any** test agents, Claude detects the project language from root files and
applies the relevant pre-flight. Claude fixes trivially-fixable blocking issues directly.
For non-trivial blockers (broken build, missing deps), Claude surfaces the error and waits
— it does NOT spawn test agents over a broken baseline.

**Detection heuristic (in priority order):**

| Root file present | Language | Pre-flight checks |
|-------------------|----------|-------------------|
| `Cargo.toml` | Rust | `src/lib.rs` exists + `[lib]` in Cargo.toml + `cargo check` clean |
| `go.mod` | Go | `go build ./...` clean + `_test.go` naming convention |
| `pyproject.toml` / `setup.py` | Python | `conftest.py` at root + package `__init__.py` files |
| `package.json` (jest/vitest/mocha) | Node/TS | test runner in scripts + `node_modules/` exists |
| `build.gradle` / `pom.xml` | JVM | `src/test/java` or `src/test/kotlin` directory exists |
| none of the above | Unknown | Log warning, proceed with no pre-flight |

**Trivially fixable** (Claude creates + logs): missing `src/lib.rs`, `__init__.py`, test source dir.
**Needs user action** (Claude surfaces + halts): build broken, missing package manager deps.

---

## Stage 7: Testing

Decompose testing into independent tasks: unit tests per module, integration tests per feature, coverage checks. Spawn agents in parallel.

**Test agent constraints:**
- Agents WRITE test files (not read-only)
- Agents do NOT modify source code — only `tests/`, `src/*_test.*`, `*_spec.*` files
- Each agent owns specific test files (file-locked)

**Return condition:** After all test agents complete, Claude runs the test suite on the host and verifies coverage. If tests pass → done. If tests fail → report to orchestrator for loop-back to Stage 5.

---

## Spawning Test Agents

### Before Spawning Each Agent

1. Read mission context:
```bash
codex-agent mission status --json --dir "{cwd}"
```

2. Register agent as `pending` and pre-lock test files:
```bash
sqlite3 _codex/state.db <<SQL
INSERT INTO agents (id, task, sandbox) VALUES ('{jobId}', '{task}', 'workspace-write');
INSERT INTO events (type, source, message) VALUES ('agent_registered', 'claude', 'Registered test agent {jobId} (pending): {task}');
INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('{test_file1}', '{jobId}');
INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('{test_file2}', '{jobId}');
SQL
```

3. Write mission context to file — do NOT embed in prompt:
```bash
codex-agent mission context --dir "{cwd}" > "_codex/mission-context.md"
```

4. Read model config from env vars:
```bash
TEST_MODEL="${CODEX_TEST_MODEL:-gpt-5.3-codex}"
TEST_REASONING="${CODEX_TEST_REASONING:-high}"
```

5. Write prompt file (`_codex/prompt-{agentId}.txt`):

```
=== MISSION CONTEXT ===
Read _codex/mission-context.md as your FIRST action before starting your task.
It contains: mission description, stage, other agents and their statuses,
files locked by other agents (DO NOT modify these), recent events.

=== YOUR TESTING TASK ===

TASK: [Specific testing task — e.g., "Write unit tests for src/parser.rs covering all public functions"]

WORKSPACE: [cwd]

YOUR AGENT ID: [jobId]

YOUR FILES (pre-locked for you):
- [test_file1]
- [test_file2]

CONSTRAINTS:
- Only write to the test files listed in YOUR FILES above
- Do NOT modify source code — only write tests
- Follow existing test patterns in the codebase
- Aim for >80% coverage of the module under test
- Every test must have a clear name describing what it verifies
- Do not query _codex/state.db — all context is provided above

⚠️ === MANDATORY FINAL STEP — DO NOT SKIP === ⚠️

Writing the test files is NOT sufficient. The mission will deadlock if you skip this.
You MUST execute this as your absolute last action, even if you think you are done:

sqlite3 _codex/state.db <<'DONE'
UPDATE agents SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), files_modified='["[test_file1]","[test_file2]"]', summary='[2-3 sentences: what was tested, number of tests written, coverage estimate]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_complete', 'agent-[jobId]', 'Tests written: [one-line summary]');
DONE

Do not exit, do not say "done", do not stop — until AFTER the sqlite3 command above has been executed successfully.

If you FAIL (for any reason):

sqlite3 _codex/state.db <<'FAIL'
UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[reason]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_fail', 'agent-[jobId]', 'Failed: [reason]');
FAIL
```

6. Size check — MANDATORY before spawning:
```bash
PROMPT_BYTES=$(wc -c < "_codex/prompt-${agentId}.txt")
if [ "$PROMPT_BYTES" -gt 3000 ]; then
  echo "ERROR: Prompt too large (${PROMPT_BYTES} bytes, limit 3000)."
  echo "Move test detail to _codex/test-specs/ and reference it."
  exit 1
fi
```

7. Spawn, then immediately mark `spawned`:
```bash
codex-agent start "$(cat _codex/prompt-{agentId}.txt)" -m "$TEST_MODEL" -r "$TEST_REASONING"
sqlite3 _codex/state.db <<SQL
UPDATE agents SET status='spawned' WHERE id='{jobId}';
INSERT INTO events (type, source, message) VALUES ('agent_spawned', 'claude', 'Test agent {jobId} spawn command issued.');
SQL
```

### Background Watcher

After spawning all test agents:
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

---

## Test Execution Gate (Host — NOT in agent)

After all test agents complete, Claude runs the test suite directly on the host:

```bash
# Language-agnostic — detect and run:
cargo test                          # Rust   (Cargo.toml)
pytest --cov --cov-report=term      # Python (pytest.ini / pyproject.toml)
go test ./... -cover                # Go     (go.mod)
npm test -- --coverage              # Node   (package.json)
bun test --coverage                 # Bun
```

**Why on host:** Same reason as build verification — `workspace-write` sandbox blocks outbound network; test runners may need to fetch dependencies.

### Coverage Threshold

| Language | Minimum Coverage |
|----------|-----------------|
| Rust | 80% (lines) |
| Python | 80% (lines) |
| Go | 80% (statements) |
| TypeScript/JS | 80% (lines) |

If coverage is below threshold, spawn additional test agents targeting the uncovered modules.

### Pass Path

All tests pass + coverage met:

1. Update mission stage to `'done'`:
```bash
sqlite3 _codex/state.db "UPDATE mission SET stage='done', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[2-5 paragraph mission summary: what was built, agent breakdown, files changed, review findings, test results]' WHERE id=1;"
sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('mission_complete', 'claude', 'All tests pass. Mission complete.');"
```

2. Write final blackboard checkpoint with `stage: "done"`.

3. Return to orchestrator — mission complete.

### Fail Path

Tests fail or compilation error:

1. Read failure output — identify which modules/functions are broken
2. Report to orchestrator: return structured failure summary
3. Orchestrator loops back to `Skill("codex-implement")` to spawn fix agents
4. After fix agents complete and build gate passes, re-invoke `Skill("codex-test")`

**Do NOT:** spawn fix agents from within this skill. Fixes go through `codex-implement`. This skill only tests and reports.

---

## Lock Cleanup

After each test agent completes (or fails):
```bash
sqlite3 _codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

If agent fails to self-report:
```bash
sqlite3 _codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='Did not self-report.' WHERE id='{jobId}';"
sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Test agent {jobId} did not self-report.');"
sqlite3 _codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

---

## Operational Policies

### Model and Reasoning

```bash
TEST_MODEL="${CODEX_TEST_MODEL:-gpt-5.3-codex}"
TEST_REASONING="${CODEX_TEST_REASONING:-high}"
codex-agent start "$(cat _codex/prompt-{id}.txt)" -m "$TEST_MODEL" -r "$TEST_REASONING"
```

### Timing

| Test Type | Typical Duration |
|-----------|-----------------|
| Unit tests (single module) | 10-20 minutes |
| Integration tests | 20-35 minutes |
| Full test suite (large codebase) | 30-60 minutes |

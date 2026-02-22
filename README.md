# codex-orchestrator-graph

A decomposed, stage-aware Claude Code skill graph for orchestrating multi-agent Codex pipelines. Each pipeline stage is a dedicated skill loaded on-demand — no monolithic context bloat.

## What This Is

The `codex-orchestrator` pipeline decomposes software tasks into a 7-stage factory:

| Stage | Name | Owner |
|-------|------|-------|
| 1 | Ideation | Claude + User |
| 2 | Research | `codex-research` skill |
| 3 | Synthesis | Claude |
| 4 | PRD | `codex-prd` skill |
| 5 | Implementation | `codex-implement` skill |
| 6 | Review | `codex-reviewer` agent |
| 7 | Testing | `codex-test` skill |

Coordination is 100% SQLite-based (`_codex/state.db`). No shared memory, no polling external APIs.

---

## Install

### Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | Runs `codex-agent` CLI | `curl -fsSL https://bun.sh/install \| bash` |
| sqlite3 | State bus queries | `brew install sqlite3` / `apt install sqlite3` / `winget install SQLite` |
| [OpenAI Codex CLI](https://github.com/openai/codex) | Spawns coding agents | `npm install -g @openai/codex` |
| Git | **MANDATORY** — agents silently fail without `.git/` | [git-scm.com](https://git-scm.com) |

### Install Skills

**Unix / macOS / Git Bash on Windows:**

```bash
bash plugins/codex-orchestrator/scripts/install.sh
```

To overwrite an existing install:

```bash
bash plugins/codex-orchestrator/scripts/install.sh --update
```

**Manual:**

```bash
# Skills (the -g suffix identifies this as the graph version)
cp -r plugins/codex-orchestrator/skills/codex-orchestrator  ~/.claude/skills/codex-orchestrator-g
cp -r plugins/codex-orchestrator/skills/codex-implement     ~/.claude/skills/codex-implement-g
cp -r plugins/codex-orchestrator/skills/codex-research      ~/.claude/skills/codex-research-g
cp -r plugins/codex-orchestrator/skills/codex-prd           ~/.claude/skills/codex-prd-g
cp -r plugins/codex-orchestrator/skills/codex-test          ~/.claude/skills/codex-test-g

# Agent
mkdir -p ~/.claude/agents
cp plugins/codex-orchestrator/agents/codex-reviewer.md ~/.claude/agents/codex-reviewer.md
```

### Authenticate

```bash
codex --login
```

### Verify

```bash
codex-agent health
test -d .git && echo "GIT OK" || echo "WARNING: no .git — run git init in your project"
```

---

## File Structure

```
plugins/codex-orchestrator/
├── agents/
│   └── codex-reviewer.md       # Stage 6: dual-model review (Claude agent, model: sonnet)
├── commands/
│   └── codex-orchestrator.md   # Slash command entry point → routes to skill
└── skills/
    ├── codex-orchestrator/     # Graph routing, stage transitions, SQLite state protocol
    ├── codex-implement/        # Stage 5: Codex agent spawning, file locks, build gate
    ├── codex-research/         # Stage 2: Research (claude / codex / hybrid modes)
    ├── codex-prd/              # Stage 4: PRD format + user approval loop
    └── codex-test/             # Stage 7: Spec-first testing + coverage gate
```

---

## Pipeline

```
USER
 │
 ▼
codex-orchestrator  ◄──────── graph routing + SQLite state machine
 │
 ├─[Stage 2]─► codex-research     Research questions → findings in _codex/reviews/
 │              ├── claude mode (default): Claude Task subagents
 │              ├── codex mode: Codex agents
 │              └── hybrid mode: both
 │
 ├─[Stage 4]─► codex-prd          PRD markdown → user approval gate
 │
 ├─[Stage 5]─► codex-implement    Parallel Codex agents (up to 5)
 │              ├── artifact gate (all agents complete, locks released)
 │              └── host build verification gate
 │
 ├─[Stage 6]─► codex-reviewer     Codex CLI + 5 Claude agents → synthesis.md
 │              ├── KEEP / DISCARD / ELEVATE verdicts per finding
 │              └─[ELEVATE or CRITICAL]─► loop back to Stage 5
 │
 └─[Stage 7]─► codex-test         Spec-first: Claude writes specs, agents implement
                ├── host test execution gate
                └── 80% coverage threshold
```

---

## Key Design Decisions

### SQLite as Coordination Bus

All agent state lives in `_codex/state.db`: agent registration, file locks, events, review findings. Claude writes; agents self-report completion with a single sqlite3 heredoc. Agents never query the database — context is pre-written to `_codex/mission-context.md` before each spawn.

### Three-Status Agent Progression

```
pending  →  spawned  →  running  →  completed / failed
```

Eliminates phantom agents from context compaction:
- `pending` = registered, spawn command not yet issued → safe to re-spawn
- `spawned` = command issued, process handed to OS → check `codex-agent jobs --json`
- `running` = agent self-reported it started

### Two-Checkpoint Blackboard Protocol

At each stage gate, two checkpoints are written to memoryd:

- **Checkpoint A (pre-execution):** Before registering any agent. Captures planned work. Recovery anchor if `/compact` happens mid-stage.
- **Checkpoint B (post-gate):** After gate passes and `mission.stage` updates. Full completed picture.

Survives `/compact` and `/clear`. `memory_bootstrap` restores stage context instantly without filesystem reads.

### Spec Files for Complex Tasks

For tasks with >5 bullet points of implementation detail, Claude writes `_codex/specs/{agentId}.md` before spawning. The prompt body stays to one imperative sentence + a spec reference line.

Prevents Windows env-block bloat (`Argument list too long`). Prompt files hard-capped at **3KB**.

### Spec-First Testing (Stage 7 default)

Claude reads source files directly and writes exact test specs (function signatures, input/expected output pairs, edge cases) *before* any Codex agent is spawned. Agents implement from spec only — no invented test cases. Eliminates wrong-expected-value failures.

### Dual-Model Code Review (Stage 6)

Two independent signals combined:
1. `codex review --uncommitted` — Codex CLI static analysis on uncommitted diff
2. 5 parallel Claude subagents — bugs, error handling, security, financial safety, CLAUDE.md compliance

Orchestrating Claude reads source files directly and judges each finding: **KEEP**, **DISCARD**, or **ELEVATE** (flagged independently by both signals).

### workspace-write Sandbox for All Agents

Never use `-s read-only`. SQLite WAL mode requires write access for `-wal`/`-shm` journal files. On Windows/MINGW, the `read-only` sandbox makes `_codex/state.db` completely unreadable — even SELECT queries fail. Read-only behavior is enforced via prompt constraints, not sandbox.

### No `-f` Flag

`codex-agent -f file.txt` appends the entire file content to the `CODEX_PROMPT` env var, which exhausts the Windows ~32KB process environment limit. Agents read files themselves during their turns instead.

---

## Environment Variables

| Variable | Default | Stage | Notes |
|----------|---------|-------|-------|
| `CODEX_IMPL_MODEL` | `gpt-5.3-codex-spark` | 5 | Implementation agents |
| `CODEX_IMPL_REASONING` | `xhigh` | 5 | |
| `CODEX_RESEARCH_MODEL` | `gpt-5.3-codex` | 2 | Codex/hybrid mode only |
| `CODEX_RESEARCH_REASONING` | `high` | 2 | |
| `CODEX_RESEARCH_MODE` | `claude` | 2 | `claude` / `codex` / `hybrid` |
| `CODEX_TEST_MODEL` | `gpt-5.3-codex` | 7 | codex-direct mode only |
| `CODEX_TEST_REASONING` | `high` | 7 | |
| `CODEX_TEST_MODE` | `spec-first` | 7 | `spec-first` / `codex-direct` |
| `CODEX_REVIEW_MODEL` | `gpt-5.3-codex` | 6 | |
| `CODEX_REVIEW_REASONING` | `high` | 6 | |
| `CODEX_AUTO_APPROVE` | `0` | 4 | `1` = skip PRD user approval gate |

---

## Monitoring & Recovery

```bash
# Agent status
codex-agent jobs --json
codex-agent events <id>
codex-agent capture <id>

# Mission state
codex-agent mission status --json --dir .
codex-agent mission reconcile --dir .    # auto-mark dead agents failed, release locks

# SQLite direct
sqlite3 _codex/state.db "SELECT id, task, status FROM agents;"
sqlite3 _codex/state.db "SELECT file_path, agent_id FROM file_locks;"
sqlite3 _codex/state.db "SELECT timestamp, source, message FROM events ORDER BY id DESC LIMIT 20;"
```

### Post-Compaction Recovery

After `/compact` or `/clear`, in this order:

```bash
# 1. Restore stage context from memoryd (before any filesystem reads)
#    memory_bootstrap(query="codex mission checkpoint", tiers=["blackboard"])

# 2. Check live processes
codex-agent jobs --json

# 3. Full mission state
codex-agent mission status --json --dir .

# 4. Reconcile stale state (marks dead agents failed, releases orphan locks)
codex-agent mission reconcile --dir .

# 5. Re-spawn background watcher if agents still running
STILL_RUNNING=$(sqlite3 _codex/state.db \
  "SELECT COUNT(*) FROM agents WHERE status IN ('pending','spawned','running');")
# If > 0, spawn watcher (Bash tool, run_in_background: true)
```

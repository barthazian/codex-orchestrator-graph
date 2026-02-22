---
name: codex-orchestrator
description: Army model — Claude decomposes tasks and spawns N focused Codex agents directly via codex exec --json. No single-lead bottleneck. Claude manages all coordination via _codex/state.db, makes strategic decisions, and orchestrates dual-model code reviews. Cross-platform (macOS, Linux, Windows). Trigger on ANY task involving code, file modifications, codebase research, multi-step work, or implementation. Only skip if the user explicitly asks you to do something yourself.
triggers:
  - codex-orchestrator
  - spawn codex
  - use codex
  - delegate to codex
  - start agent
  - codex agent
  - init
  - setup codex
---

# Codex Orchestrator

## 1. The Command Structure

```
USER — sets vision and approves strategy
    |
    v
CLAUDE (default model) — strategy, decomposition, coordination, review orchestration
    |
    ├── Codex agent (task A)   — focused coder
    ├── Codex agent (task B)   — focused coder
    ├── Codex agent (task C)   — focused coder
    └── ...up to 5 concurrent
```

Two roles:

- **User**: Vision, strategic decisions, plan approval.
- **Claude**: Strategy, task decomposition, PRD creation, agent spawning, coordination via `_codex/state.db`, synthesis, dual-model review orchestration.

Claude decomposes tasks and spawns up to 5 focused Codex agents in parallel. Each agent receives a single, self-contained task. Agents are fire-and-forget coders — they execute their task and exit. Claude handles all coordination.

## 2. Critical Rules

### Rule 1: Claude Decomposes, Agents Execute

Claude breaks work into focused, independent tasks and spawns a Codex agent for each. Agents do NOT decompose work further or spawn sub-agents. They just code.

### Rule 2: Claude Is Orchestrator AND Coordinator

**Claude's job:**
- Discuss strategy with user
- Write PRDs and specs
- Decompose tasks into agent-sized work units
- Spawn Codex agents (up to 5 concurrent)
- Initialize and manage `_codex/state.db`
- Register agents in the `agents` table (status `pending`)
- Monitor agent completion via `codex-agent jobs --json` and SQLite queries
- Make course corrections via `events` table
- Synthesize results
- Run dual-model reviews (Stage 6)
- Run host build verification after each implementation wave (agents write files; Claude verifies — Claude has full network access, agents do not)

**Not Claude's job:**
- Implementing code directly (agents do this)
- Doing extensive file reads for delegation context

**Agent's job:**
- Read the pre-injected mission context (provided as plain text in the prompt — no DB queries needed)
- Execute the focused task from Claude
- Write clean code following existing patterns
- Stay within scope — only modify files listed in YOUR FILES (pre-locked by Claude)
- On completion: run the single sqlite3 heredoc to report status and summary
- Exit when done — output captured automatically via JSONL

**What agents do NOT do:**
- Agents do NOT query the database (context is pre-injected by Claude)
- Agents do NOT manage file locks (Claude pre-locks before spawn, releases after completion)
- Agents do NOT write checkpoints (Claude monitors via `codex-agent capture`)
- Agents do NOT transition their own status to running (Claude does this at spawn time)

### Rule 3: Claude Subagents for Review

Use Claude subagents (Task tool) during Stage 6 (Review) for dual-model code review. Claude subagents return results in-memory — they do NOT write to disk. All code execution goes to Codex agents.

### Rule 4: Write Ownership Is Strict

See Section 5 for the full ownership table and rules. In summary: Claude owns the `mission` table, agent registration, file locks, and all status transitions. Agents own only their completion self-report (UPDATE own row + INSERT completion event). No writer ever modifies another writer's rows.

### Rule 5: Stage Skills Own Their Stage

Each pipeline stage has a dedicated skill that owns its implementation details. The orchestrator invokes the skill via the `Skill` tool and waits for it to return. The orchestrator does NOT re-implement stage internals — it reads the outcome from `state.db` and decides the next transition.

## 3. Prerequisites

Before codex-agent can run, three things must be installed:

1. **Bun** — JavaScript runtime (runs the CLI)
2. **sqlite3** — Database CLI (state bus for coordination)
3. **OpenAI Codex CLI** — The coding agent being orchestrated
4. **Git repo in working directory** — Codex CLI refuses to run outside a trusted git repo (`Not inside a trusted directory and --skip-git-repo-check was not specified`). If `.git/` is absent, agents spawn, consume ~46 min of inactivity timeout, and silently produce zero output.

The user must also be **authenticated with OpenAI** (`codex --login`) so agents can make API calls.

### Quick Check

```bash
codex-agent health    # checks codex is available
test -d .git && echo "GIT OK" || (git init && echo "GIT INITIALIZED — repo created")
```

**MANDATORY:** Always run both checks before spawning any agent. If `.git/` is missing, run `git init` — it is safe, non-destructive, and takes under a second.

### If Not Installed

If the user says "init", "setup", or codex-agent is not found, **run the install script**:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
```

**Always use the install script.** Do NOT manually check dependencies or try to install things yourself step-by-step.

After installation, the user must authenticate with OpenAI if they haven't already:

```bash
codex --login
```

## 4. The Factory Pipeline

```
USER'S REQUEST
     |
     v
1. IDEATION        (Claude + User)
     |
2. RESEARCH        (→ Skill: codex-research)
     |
3. SYNTHESIS       (Claude)
     |
4. PRD             (→ Skill: codex-prd)
     |
5. IMPLEMENTATION  (→ Skill: codex-implement)
     |
6. REVIEW          (→ Agent: codex-reviewer)
     |
7. TESTING         (→ Skill: codex-test)
```

At each stage gate, Claude invokes the relevant skill via the `Skill` tool, waits for it to return, then reads the outcome from `state.db` to decide the next transition.

### Pipeline Stage Detection

| Signal | Stage | Action |
|--------|-------|--------|
| New feature request, vague problem | IDEATION | Discuss with user, clarify scope |
| "investigate", "research", "understand" | RESEARCH | `Skill("codex-research")` |
| Agent findings ready, need synthesis | SYNTHESIS | Claude reviews, filters, combines |
| "let's plan", "create PRD", synthesis done | PRD | `Skill("codex-prd")` |
| PRD exists, "implement", "build" | IMPLEMENTATION | `Skill("codex-implement")` |
| Implementation done, "review" | REVIEW | `Skill("codex-reviewer")` |
| "test", "verify", review passed | TESTING | `Skill("codex-test")` |

### Codebase Map (Auto-Managed)

**Auto-create at mission start:** Before entering any pipeline stage, run both gates:

```bash
# Gate 1: Git repo (HARD REQUIREMENT — agents silently fail without this)
test -d .git && echo "GIT OK" || (git init && echo "GIT INITIALIZED")

# Gate 2: Codebase map
test -f docs/CODEBASE_MAP.md && echo "MAP EXISTS" || echo "NO MAP — run /cartographer first"
```

Do NOT spawn any agent until Gate 1 passes.

**Auto-update after implementation:** After Stage 5 completes and passes the artifact gate, run `/cartographer` in update mode before advancing to Stage 6.

### Stage 1: Ideation (Claude + User)

Talk through the problem with the user. Understand what they want. Plan how to decompose the work into agent-sized tasks.

### Stage 2: Research

```
Skill("codex-research")
```

The `codex-research` skill owns Stage 2 spawn templates, research synthesis pattern, and agent decomposition for research questions. Returns when all research agents complete.

### Stage 3: Synthesis (Claude)

Review agent outputs via `codex-agent jobs --json` and `codex-agent events <id>`. Filter signal from noise. Write synthesis decision to `events` table in `_codex/state.db`.

### Stage 4: PRD

```
Skill("codex-prd")
```

The `codex-prd` skill owns PRD format, user approval loop, and file writing to `docs/prds/`. Returns after user explicitly approves the PRD.

### Stage 5: Implementation

```
Skill("codex-implement")
```

The `codex-implement` skill owns the full spawn template, file pre-locking, artifact gate, host build verification, and map update gate. Returns when all gates pass.

### Stage 6: Review

```
Skill("codex-reviewer")
```

The `codex-reviewer` agent runs the full dual-model review protocol (deterministic gate → codex review → 5 Claude agents → orchestrating Claude judgment → synthesis). It is the authoritative source for Stage 6 — do not re-implement its protocol here.

After it returns, check `_codex/reviews/synthesis.md` for ELEVATE/CRITICAL findings:
- If any exist: loop back to Stage 5 (spawn fix agents via `codex-implement`)
- If none: advance to Stage 7

### Stage 7: Testing

```
Skill("codex-test")
```

The `codex-test` skill owns test agent spawn templates, test execution, and coverage verification. Returns when all tests pass.

## 5. SQLite State Protocol (_codex/state.db)

The `_codex/state.db` SQLite database is the coordination bus. It lives in the project root under `_codex/`.

### Directory Structure

```
_codex/
├── state.db                # SQLite database (WAL mode)
├── state.db-wal            # WAL file (auto-created)
├── state.db-shm            # Shared memory file (auto-created)
└── reviews/
    ├── codex-{focus}.md    # Codex review agent findings
    └── synthesis.md        # Claude writes final synthesis
```

### SQL Schema

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS mission (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stage TEXT NOT NULL,
  mission TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  progress TEXT DEFAULT '',
  blockers TEXT DEFAULT '[]',
  next_steps TEXT DEFAULT '[]',
  summary TEXT DEFAULT '',
  blackboard_checkpoint_id TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  sandbox TEXT DEFAULT 'workspace-write',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at TEXT,
  files_modified TEXT DEFAULT '[]',
  summary TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT
);

CREATE TABLE IF NOT EXISTS file_locks (
  file_path TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT,
  suggested_fix TEXT,
  in_diff INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed','fixed')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_findings_status ON review_findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_path ON review_findings(path);
```

### Write Ownership Table

| Table/File | Writer | Reader |
|------------|--------|--------|
| `mission` table | Claude only | Claude |
| `agents` table (INSERT, status transitions) | Claude only | Claude |
| `agents` table (UPDATE on completion) | Each agent (own row only) | Claude |
| `events` table | Claude (source='claude'), Agents (source='agent-{id}') | Claude |
| `file_locks` table | Claude only (pre-lock before spawn, release after completion) | Claude |
| `review_findings` table | Claude (inserts parsed findings from all reviewers) | Claude, User |
| `reviews/synthesis.md` | Claude | User |

### Blackboard Checkpoint Protocol (Cross-Session Durability)

At every stage gate, Claude writes a checkpoint to memoryd. This survives `/compact` and `/clear` — `memory_bootstrap` restores stage context instantly at session start without requiring filesystem reads.

**When to write:** after mission init (ideation), synthesis→PRD, PRD approval→implement, artifact gate→review, review→test, test→done. Write immediately after the corresponding `UPDATE mission SET stage=...`.

**Step 1 — Create new checkpoint** (via `memory_remember_candidate` MCP tool):

```
tier:       "blackboard"
scope:      "project"
project_id: "{detected_project_id}"   # from memory_detect_project
agent_id:   "claude_code"
title:      "codex-mission-checkpoint:{project_id}"
type:       "mission_checkpoint"
content:    JSON string containing:
              stage, mission_description, completed_agents (id+task+files_modified+summary),
              key_decisions (from events table), next_steps
```

Note the returned `memory_id` as `{new_id}`.

**Step 2 — Supersede old checkpoint** (if `blackboard_checkpoint_id` is not NULL in mission table):

```bash
# {new_id} goes in the PATH (the superseder — stays active)
# {old_id} goes in the BODY superseded_id (gets deprecated/removed from retrieval)
curl -s -X POST http://127.0.0.1:8080/memory/items/{new_id}/supersede \
  -H "Content-Type: application/json" \
  -d '{"superseded_id": "{old_id}", "provenance": {"sources": ["codex-orchestrator"]}}'
```

**Step 3 — Store new id in state.db:**

```bash
sqlite3 _codex/state.db "UPDATE mission SET blackboard_checkpoint_id='{new_id}' WHERE id=1;"
```

**Recovery** (after `/compact`, `/clear`, or fresh session): `memory_bootstrap` automatically returns the active checkpoint. Read `stage` and `content` from it to know where the mission is before touching the filesystem. The supersede chain ensures only the current checkpoint is returned — stale ones are marked deprecated.

### Pre-Initialization: Context Recovery (MANDATORY)

Before creating or reinitializing `_codex/state.db`, Claude MUST check for existing state and recover context. **NEVER skip this step.**

```bash
test -f _codex/state.db && echo "EXISTS" || echo "NEW"
```

If it exists, read ALL context before doing anything else:

```bash
sqlite3 -header -column _codex/state.db "SELECT stage, mission, progress, summary FROM mission WHERE id=1;" 2>/dev/null
sqlite3 -header -column _codex/state.db "SELECT id, task, status, files_modified, summary FROM agents;" 2>/dev/null
sqlite3 -header -column _codex/state.db "SELECT timestamp, type, source, message FROM events ORDER BY id DESC LIMIT 20;" 2>/dev/null
```

### Destructive Action Policy

**NEVER run DELETE, DROP, or TRUNCATE on any table in state.db.** Old mission data is context, not clutter. If tables grow excessively large (>1000 rows in events), ask the user before pruning — NEVER autonomously.

### Initialization

```bash
codex-agent mission init "{mission_description}" --stage "{stage}" --dir "{cwd}"
```

Idempotent — safe to run on existing databases.

## 6. CLI Reference & Monitoring

### Spawning Agents

Spawning is handled by the stage skills (codex-implement, codex-research, codex-test). The orchestrator does not directly write prompt files.

### Monitoring

```bash
codex-agent jobs --json          # structured status of all agents
codex-agent jobs                 # human readable table
codex-agent events <id>          # parsed JSONL events
codex-agent capture <id>         # recent formatted output
codex-agent output <id>          # full output
```

**Mission & state commands:**

```bash
codex-agent mission status --json --dir "{cwd}"   # full mission state
codex-agent mission reconcile --dir "{cwd}"        # auto-mark dead agents failed, release locks
codex-agent locks list --dir "{cwd}"               # list active file locks
codex-agent locks release {agentId} --dir "{cwd}"  # manually release locks
codex-agent resume {jobId}                         # resume failed non-ephemeral agent
```

**SQLite status:**

```bash
sqlite3 -header -column _codex/state.db "SELECT id, task, status, files_modified, summary FROM agents;"
sqlite3 -header -column _codex/state.db "SELECT file_path, agent_id FROM file_locks;"
sqlite3 -header -column _codex/state.db "SELECT timestamp, source, message FROM events WHERE type IN ('agent_complete', 'agent_fail') ORDER BY id;"
```

### Control

```bash
codex-agent kill <id>            # stop agent (last resort)
codex-agent clean                # remove old jobs (>7 days)
codex-agent health               # verify codex available
```

### Flags

| Flag | Short | Values | Description |
|------|-------|--------|-------------|
| `--reasoning` | `-r` | low, medium, high, xhigh | Reasoning depth |
| `--sandbox` | `-s` | read-only, workspace-write, danger-full-access | File access level |
| `--file` | `-f` | glob | Include files (repeatable) |
| `--map` | | flag | Include docs/CODEBASE_MAP.md |
| `--dir` | `-d` | path | Working directory |
| `--model` | `-m` | string | Model override |
| `--json` | | flag | JSON output (jobs only) |

### CLI Defaults

| Setting | Default | Why |
|---------|---------|-----|
| Model | `gpt-5.3-codex` | Latest and most capable Codex model |
| Reasoning | `xhigh` | Maximum reasoning depth |
| Sandbox | `workspace-write` | Agents can modify files by default |

## 7. Operational Policies

### Per-Stage Model and Reasoning Selection — MANDATORY

Always pass `-m` and `-r` explicitly when spawning — never rely on the CLI default.

| Stage | Model env var | Reasoning env var | Default values |
|-------|--------------|-------------------|----------------|
| Research (2), Implementation (5), Testing (7) | `$CODEX_MODEL` | `$CODEX_REASONING` | `gpt-5.3-codex-spark`, `xhigh` |
| Review (6) — Codex review agents only | `$CODEX_REVIEW_MODEL` | `$CODEX_REVIEW_REASONING` | `gpt-5.3-codex`, `high` |

### Stage Regression

- Review findings (Stage 6) can trigger loop back to Implementation (Stage 5).
- Claude invokes `codex-implement` again for fix agents, then re-invokes `codex-reviewer`.

### Data Integrity

- **NEVER run DELETE, DROP, or TRUNCATE on state.db tables** without explicit user approval.
- When an agent fails, only DELETE that agent's file_locks — never bulk delete.

## 8. Error Recovery

### Agent Fails

1. Check what happened:
   ```bash
   codex-agent events <id>
   codex-agent capture <id>
   ```
2. Mark failed and release locks:
   ```bash
   sqlite3 _codex/state.db <<SQL
   UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[failure reason]' WHERE id='{id}';
   INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Agent {id} failed: [reason]');
   DELETE FROM file_locks WHERE agent_id='{id}';
   SQL
   ```
3. Decide: retry with adjusted prompt (max 2 retries), resume if persistent, or skip and inform user.

### Post-Compaction Recovery

After Claude's context compacts, immediately recover state with:

```bash
# 0. Restore stage context from memoryd (fast — before any filesystem reads)
#    Call memory_bootstrap(query="codex mission checkpoint {project_id}", tiers=["blackboard"], agent_id="claude_code")
#    Read stage + mission_description + completed_agents from the returned checkpoint content.
#    This tells you what stage you're in before touching state.db.

# 1. Live agent processes
codex-agent jobs --json

# 2. Full mission state (mission, agents, locks, events — all in one call)
codex-agent mission status --json --dir "{cwd}"

# 3. Reconcile dead agents (auto-marks failed, releases their locks)
codex-agent mission reconcile --dir "{cwd}"

# 4. Re-spawn background watcher if any agents are still running
STILL_RUNNING=$(sqlite3 _codex/state.db \
  "SELECT COUNT(*) FROM agents WHERE status IN ('running','pending');")
# If STILL_RUNNING > 0, re-spawn the background watcher (Bash tool, run_in_background: true)
```

## 9. When NOT to Use This Pipeline

Basically never. Codex agents are the default for all execution work.

**The ONLY exceptions:**
- The user explicitly says "you do it" or "don't use Codex"
- Pure conversation/discussion (no code, no files)
- You need to read a single file to understand context for the conversation

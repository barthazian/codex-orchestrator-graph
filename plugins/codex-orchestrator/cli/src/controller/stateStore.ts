// State store for mission coordination via _codex/state.db (SQLite)
// Provides programmatic access to the mission database that coordinates
// Claude and Codex agents during orchestrated workflows.

import { Database } from "bun:sqlite";

// --- Types ---

export interface Mission {
  id: number;
  stage: string;
  mission: string;
  started_at: string;
  updated_at: string;
  progress: string;
  blockers: string;
  next_steps: string;
  summary: string;
}

export interface Agent {
  id: string;
  task: string;
  status: string;
  sandbox: string | null;
  started_at: string | null;
  completed_at: string | null;
  files_modified: string | null;
  summary: string | null;
}

export interface FileLock {
  file_path: string;
  agent_id: string;
  locked_at: string;
}

export interface Event {
  id: number;
  timestamp: string;
  type: string;
  source: string;
  message: string;
  context: string | null;
}

export interface LockResult {
  acquired: string[];
  conflicts: Array<{ file: string; lockedBy: string }>;
}

export interface ReviewFinding {
  id: number;
  agent_id: string;
  model: string;
  path: string;
  line: number | null;
  severity: string;
  confidence: number;
  category: string;
  description: string;
  evidence: string | null;
  suggested_fix: string | null;
  in_diff: number;
  status: string;
  created_at: string;
}

export interface ReviewSummary {
  total: number;
  by_severity: Record<string, number>;
  by_status: Record<string, number>;
  by_model: Record<string, number>;
  confirmed_by_both: number;
}

// --- Database Lifecycle ---

/**
 * Open a SQLite database with WAL mode, busy timeout, and foreign keys enabled.
 */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/**
 * Create all required tables if they do not already exist.
 */
export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      stage TEXT NOT NULL,
      mission TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      progress TEXT DEFAULT '',
      blockers TEXT DEFAULT '[]',
      next_steps TEXT DEFAULT '[]',
      summary TEXT DEFAULT ''
    )
  `);

  db.exec(`
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
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS file_locks (
      file_path TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      locked_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )
  `);

  db.exec(`
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
    )
  `);
}

// --- Read Operations ---

/**
 * Get the current mission record, or null if no mission exists.
 */
export function getMission(db: Database): Mission | null {
  const row = db.prepare("SELECT id, stage, mission, started_at, updated_at, progress, blockers, next_steps, summary FROM mission LIMIT 1").get();
  return (row as Mission) ?? null;
}

/**
 * Get all registered agents.
 */
export function getAgents(db: Database): Agent[] {
  return db.prepare(
    "SELECT id, task, status, sandbox, started_at, completed_at, files_modified, summary FROM agents"
  ).all() as Agent[];
}

/**
 * Get all active file locks.
 */
export function getFileLocks(db: Database): FileLock[] {
  return db.prepare(
    "SELECT file_path, agent_id, locked_at FROM file_locks"
  ).all() as FileLock[];
}

/**
 * Get recent events, ordered newest first.
 */
export function getRecentEvents(db: Database, limit: number = 20): Event[] {
  return db.prepare(
    "SELECT id, timestamp, type, source, message, context FROM events ORDER BY id DESC LIMIT ?"
  ).all(limit) as Event[];
}

// --- Agent Lifecycle ---

/**
 * Register a new agent and log a spawn event. Runs in a transaction.
 */
export function registerAgent(db: Database, id: string, task: string, sandbox: string): void {
  const insertAgent = db.prepare(
    "INSERT INTO agents (id, task, status, sandbox) VALUES (?, ?, 'pending', ?)"
  );
  const insertEvt = db.prepare(
    "INSERT INTO events (type, source, message) VALUES ('agent_spawn', ?, ?)"
  );

  db.transaction(() => {
    insertAgent.run(id, task, sandbox);
    insertEvt.run(id, `Agent ${id} registered: ${task}`);
  })();
}

/**
 * Mark an agent as running and log a start event. Runs in a transaction.
 */
export function setAgentRunning(db: Database, id: string): void {
  const updateAgent = db.prepare(
    "UPDATE agents SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
  );
  const insertEvt = db.prepare(
    "INSERT INTO events (type, source, message) VALUES ('agent_start', ?, ?)"
  );

  db.transaction(() => {
    updateAgent.run(id);
    insertEvt.run(id, `Agent ${id} started`);
  })();
}

/**
 * Update an agent's status with optional summary and files modified. Logs an event.
 * Runs in a transaction.
 */
export function updateAgentStatus(
  db: Database,
  id: string,
  status: string,
  summary?: string,
  filesModified?: string
): void {
  const isTerminal = status === "completed" || status === "failed";

  const updateAgent = isTerminal
    ? db.prepare(
        "UPDATE agents SET status = ?, summary = ?, files_modified = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
      )
    : db.prepare(
        "UPDATE agents SET status = ?, summary = ?, files_modified = ? WHERE id = ?"
      );

  const insertEvt = db.prepare(
    "INSERT INTO events (type, source, message) VALUES (?, ?, ?)"
  );

  db.transaction(() => {
    updateAgent.run(status, summary ?? null, filesModified ?? null, id);
    insertEvt.run(`agent_${status}`, id, `Agent ${id} status: ${status}`);
  })();
}

// --- File Lock Management ---

/**
 * Attempt to acquire file locks for an agent. Returns acquired files and conflicts.
 * A lock held by a completed or failed agent is considered stale and will be replaced.
 * Runs in a transaction.
 */
export function acquireFileLocks(db: Database, agentId: string, files: string[]): LockResult {
  const checkLock = db.prepare(
    "SELECT fl.agent_id, a.status FROM file_locks fl JOIN agents a ON fl.agent_id = a.id WHERE fl.file_path = ?"
  );
  const deleteLock = db.prepare(
    "DELETE FROM file_locks WHERE file_path = ?"
  );
  const insertLock = db.prepare(
    "INSERT INTO file_locks (file_path, agent_id) VALUES (?, ?)"
  );

  const acquired: string[] = [];
  const conflicts: Array<{ file: string; lockedBy: string }> = [];

  db.transaction(() => {
    for (const file of files) {
      const existing = checkLock.get(file) as { agent_id: string; status: string } | undefined;

      if (existing) {
        const isStale = existing.status === "completed" || existing.status === "failed";
        const isSameAgent = existing.agent_id === agentId;

        if (isStale || isSameAgent) {
          // Stale lock or already owned -- replace it
          deleteLock.run(file);
          insertLock.run(file, agentId);
          acquired.push(file);
        } else {
          // Active lock by another agent -- conflict
          conflicts.push({ file, lockedBy: existing.agent_id });
        }
      } else {
        // No lock exists -- acquire it
        insertLock.run(file, agentId);
        acquired.push(file);
      }
    }
  })();

  return { acquired, conflicts };
}

/**
 * Release all file locks held by an agent. Returns the number of locks released.
 */
export function releaseFileLocks(db: Database, agentId: string): number {
  const stmt = db.prepare("DELETE FROM file_locks WHERE agent_id = ?");
  const result = stmt.run(agentId);
  return result.changes;
}

/**
 * Release all locks for a given agent and log a reconciliation event.
 * This is the "cleanup on failure" function. Returns the count of locks released.
 */
export function reconcileLocksForAgent(db: Database, agentId: string): number {
  const countStmt = db.prepare("SELECT COUNT(*) as cnt FROM file_locks WHERE agent_id = ?");
  const deleteStmt = db.prepare("DELETE FROM file_locks WHERE agent_id = ?");
  const insertEvt = db.prepare(
    "INSERT INTO events (type, source, message) VALUES ('lock_reconcile', ?, ?)"
  );

  let released = 0;
  db.transaction(() => {
    const row = countStmt.get(agentId) as { cnt: number };
    released = row.cnt;
    if (released > 0) {
      deleteStmt.run(agentId);
      insertEvt.run(agentId, `Released ${released} stale locks for agent ${agentId}`);
    }
  })();

  return released;
}

/**
 * For each lock, check if the owning agent is still alive via PID.
 * If the agent has no PID or the PID is dead, and the agent is in "running" status,
 * release its locks. Returns total count of released locks.
 */
export function reconcileAllStaleLocks(
  db: Database,
  isRunningFn: (pid: number) => boolean,
  getPidFn: (agentId: string) => number | null
): number {
  const agents = getAgents(db);
  let totalReleased = 0;

  for (const agent of agents) {
    if (agent.status !== "running") continue;

    const pid = getPidFn(agent.id);
    if (pid && isRunningFn(pid)) continue;

    // Agent is supposed to be running but process is dead
    const released = reconcileLocksForAgent(db, agent.id);
    totalReleased += released;
  }

  return totalReleased;
}

// --- Event Logging ---

/**
 * Insert a single event into the events table.
 */
export function insertEvent(
  db: Database,
  type: string,
  source: string,
  message: string,
  context?: string
): void {
  db.prepare(
    "INSERT INTO events (type, source, message, context) VALUES (?, ?, ?, ?)"
  ).run(type, source, message, context ?? null);
}

// --- Mission Context Generation ---

/**
 * Generate a pre-formatted text block summarizing the current mission state.
 * This is embedded in agent prompts so agents understand the coordination context
 * without needing direct DB access.
 */
export function generateMissionContext(db: Database): string {
  const lines: string[] = [];

  // Mission info
  const mission = getMission(db);
  if (mission) {
    lines.push("## Mission");
    lines.push(`Stage: ${mission.stage}`);
    lines.push(`Description: ${mission.mission}`);
    if (mission.progress) {
      lines.push(`Progress: ${mission.progress}`);
    }
    lines.push("");
  } else {
    lines.push("## Mission");
    lines.push("No active mission.");
    lines.push("");
  }

  // Agent roster
  const agents = getAgents(db);
  lines.push("## Agents");
  if (agents.length === 0) {
    lines.push("No agents registered.");
  } else {
    for (const agent of agents) {
      const parts = [`- ${agent.id}: ${agent.task} [${agent.status}]`];
      if (agent.sandbox) parts.push(`sandbox=${agent.sandbox}`);
      if (agent.files_modified) parts.push(`files=${agent.files_modified}`);
      lines.push(parts.join(" "));
    }
  }
  lines.push("");

  // File locks
  const locks = getFileLocks(db);
  lines.push("## File Locks");
  if (locks.length === 0) {
    lines.push("No files locked.");
  } else {
    for (const lock of locks) {
      lines.push(`- ${lock.file_path} -> ${lock.agent_id} (since ${lock.locked_at})`);
    }
  }

  return lines.join("\n");
}

// --- Review Findings ---

/**
 * Insert a review finding into the review_findings table.
 */
export function insertFinding(
  db: Database,
  agentId: string,
  model: string,
  finding: {
    path: string;
    line?: number;
    severity: string;
    confidence: number;
    category: string;
    description: string;
    evidence?: string;
    suggested_fix?: string;
    in_diff?: boolean;
  }
): number {
  const result = db.prepare(
    `INSERT INTO review_findings (agent_id, model, path, line, severity, confidence, category, description, evidence, suggested_fix, in_diff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    agentId,
    model,
    finding.path,
    finding.line ?? null,
    finding.severity,
    finding.confidence,
    finding.category,
    finding.description,
    finding.evidence ?? null,
    finding.suggested_fix ?? null,
    finding.in_diff === false ? 0 : 1
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get all review findings, optionally filtered by status or minimum confidence.
 */
export function getFindings(
  db: Database,
  opts?: { status?: string; minConfidence?: number; model?: string }
): ReviewFinding[] {
  let sql = "SELECT * FROM review_findings WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }
  if (opts?.minConfidence !== undefined) {
    sql += " AND confidence >= ?";
    params.push(opts.minConfidence);
  }
  if (opts?.model) {
    sql += " AND model = ?";
    params.push(opts.model);
  }

  sql += " ORDER BY severity DESC, confidence DESC";
  return db.prepare(sql).all(...params) as ReviewFinding[];
}

/**
 * Update the status of a finding (open → confirmed/dismissed/fixed).
 */
export function updateFindingStatus(db: Database, findingId: number, status: string): void {
  db.prepare("UPDATE review_findings SET status = ? WHERE id = ?").run(status, findingId);
}

/**
 * Get a summary of review findings for reporting.
 */
export function getReviewSummary(db: Database): ReviewSummary {
  const all = db.prepare("SELECT * FROM review_findings").all() as ReviewFinding[];

  const by_severity: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  const by_model: Record<string, number> = {};

  for (const f of all) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_status[f.status] = (by_status[f.status] ?? 0) + 1;
    by_model[f.model] = (by_model[f.model] ?? 0) + 1;
  }

  // Count findings flagged by both codex and claude on same path+category
  const codexKeys = new Set<string>();
  const claudeKeys = new Set<string>();
  for (const f of all) {
    const key = `${f.path}:${f.line ?? "?"}:${f.category}`;
    if (f.model.includes("codex")) codexKeys.add(key);
    else claudeKeys.add(key);
  }
  let confirmed_by_both = 0;
  for (const key of codexKeys) {
    if (claudeKeys.has(key)) confirmed_by_both++;
  }

  return { total: all.length, by_severity, by_status, by_model, confirmed_by_both };
}

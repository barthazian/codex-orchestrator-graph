// Job management for async codex agent execution with codex exec --json

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import { openDb, releaseFileLocks, updateAgentStatus, insertEvent } from "./controller/stateStore.ts";
import { randomBytes } from "crypto";
import {
  startExec,
  resumeExec,
  isRunning,
  killProcess,
  getStoredPid,
  getAllEvents,
  getEvents,
  getFormattedOutput,
  detectCompletion,
  extractFilesModified,
  extractTokenUsage,
  extractSessionId,
} from "./exec.ts";

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  parentSessionId?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  pid?: number;
  tokensUsed?: { input: number; output: number };
  filesModified?: string[];
  sessionId?: string;
  ephemeral?: boolean;
  error?: string;
  onComplete?: string;
}

function ensureJobsDir(): void {
  mkdirSync(config.jobsDir, { recursive: true });
}

function generateJobId(): string {
  return randomBytes(4).toString("hex");
}

function getJobPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.json`);
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(getJobPath(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(jobId: string): Job | null {
  try {
    const content = readFileSync(getJobPath(jobId), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function listJobs(): Job[] {
  ensureJobsDir();
  const files = readdirSync(config.jobsDir).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        const content = readFileSync(join(config.jobsDir, f), "utf-8");
        return JSON.parse(content) as Job;
      } catch {
        return null;
      }
    })
    .filter((j): j is Job => j !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function computeElapsedMs(job: Job): number {
  const start = job.startedAt ?? job.createdAt;
  const startMs = Date.parse(start);
  const endMs = job.completedAt ? Date.parse(job.completedAt) : Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function getJsonlMtimeMs(jobId: string): number | null {
  const jsonlFile = join(config.jobsDir, `${jobId}.jsonl`);
  try {
    return statSync(jsonlFile).mtimeMs;
  } catch {
    return null;
  }
}

function getLastActivityMs(job: Job): number | null {
  const jsonlMtime = getJsonlMtimeMs(job.id);
  if (jsonlMtime !== null) return jsonlMtime;

  const fallback = job.startedAt ?? job.createdAt;
  const fallbackMs = Date.parse(fallback);
  if (!Number.isFinite(fallbackMs)) return null;
  return fallbackMs;
}

function isInactiveTimedOut(job: Job): boolean {
  const timeoutMinutes = config.defaultTimeout;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return false;

  const lastActivityMs = getLastActivityMs(job);
  if (!lastActivityMs) return false;

  return Date.now() - lastActivityMs > timeoutMinutes * 60 * 1000;
}

/**
 * Extract summary text from JSONL events — last assistant message.
 */
function extractSummary(jobId: string): string | null {
  const events = getAllEvents(jobId);
  let summary: string | null = null;

  for (const event of events) {
    if (event.type === "response_item") {
      const payload = typeof event.payload === "object" && event.payload !== null ? event.payload as Record<string, unknown> : event;
      if (payload.role === "assistant" && Array.isArray(payload.content)) {
        const texts = (payload.content as Array<Record<string, unknown>>)
          .filter((c) => c.type === "output_text" || c.type === "text")
          .map((c) => c.text)
          .filter((t): t is string => typeof t === "string");
        if (texts.length > 0) summary = texts.join("");
      }
    }

    if (event.type === "event_msg") {
      const payload = typeof event.payload === "object" && event.payload !== null ? event.payload as Record<string, unknown> : null;
      if (payload && payload.type === "agent_message" && typeof payload.message === "string") {
        summary = payload.message;
      }
    }
  }

  return summary;
}

/**
 * Best-effort cleanup of agent state in _codex/state.db when a job fails.
 * This is defensive: the catch block is intentional because state.db cleanup
 * must never break the job lifecycle. state.db may not exist, the agent may
 * not be registered in it (not all jobs are orchestrated), or the DB could
 * be corrupted. The job lifecycle in jobs.ts is the primary system;
 * state.db cleanup is secondary and best-effort only.
 */
function tryRunOnComplete(job: Job): void {
  if (!job.onComplete) return;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CODEX_JOB_ID: job.id,
    CODEX_JOB_STATUS: job.status,
    CODEX_JOB_CWD: job.cwd,
    CODEX_JOB_FILES: JSON.stringify(job.filesModified || []),
    CODEX_JOB_ERROR: job.error || "",
  };
  const result = spawnSync("bash", ["-c", job.onComplete], {
    cwd: job.cwd,
    env,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || "";
    console.error(`on-complete callback failed (exit ${result.status}): ${stderr}`);
  }
}

function tryCleanupAgentState(jobId: string, cwd: string, status: string, reason?: string): void {
  const dbPath = join(cwd, "_codex", "state.db");
  if (!existsSync(dbPath)) return;

  try {
    const db = openDb(dbPath);
    updateAgentStatus(db, jobId, status, reason);
    releaseFileLocks(db, jobId);
    insertEvent(db, "agent_cleanup", "runtime", `Auto-cleanup for agent ${jobId}: ${status}`);
    db.close();
  } catch {
    // state.db may not have this agent registered — that's fine, not all jobs are orchestrated.
    // This catch is intentional: job lifecycle must never fail due to state.db issues.
  }
}

export type JobsJsonEntry = {
  id: string;
  status: Job["status"];
  prompt: string;
  model: string;
  reasoning: ReasoningEffort;
  cwd: string;
  elapsed_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tokens: { input: number; output: number } | null;
  files_modified: string[] | null;
  summary: string | null;
};

export type JobsJsonOutput = {
  generated_at: string;
  jobs: JobsJsonEntry[];
};

export function getJobsJson(): JobsJsonOutput {
  const jobs = listJobs();
  const enriched = jobs.map((job) => {
    const refreshed = job.status === "running" ? refreshJobStatus(job.id) : null;
    const effective = refreshed ?? job;
    const elapsedMs = computeElapsedMs(effective);

    let tokens: { input: number; output: number } | null = effective.tokensUsed ?? null;
    let filesModified: string[] | null = effective.filesModified ?? null;
    let summary: string | null = null;

    if (effective.status === "completed" || effective.status === "failed") {
      // Extract from JSONL if not already in job metadata
      if (!tokens) {
        const events = getAllEvents(effective.id);
        tokens = extractTokenUsage(events);
      }
      if (!filesModified || filesModified.length === 0) {
        const events = getAllEvents(effective.id);
        filesModified = extractFilesModified(events);
      }
      const rawSummary = extractSummary(effective.id);
      summary = rawSummary ? truncateText(rawSummary, 500) : null;
    }

    return {
      id: effective.id,
      status: effective.status,
      prompt: truncateText(effective.prompt, 100),
      model: effective.model,
      reasoning: effective.reasoningEffort,
      cwd: effective.cwd,
      elapsed_ms: elapsedMs,
      created_at: effective.createdAt,
      started_at: effective.startedAt ?? null,
      completed_at: effective.completedAt ?? null,
      tokens,
      files_modified: filesModified,
      summary,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    jobs: enriched,
  };
}

export function deleteJob(jobId: string): boolean {
  const job = loadJob(jobId);

  // Kill process if running
  if (job?.pid && isRunning(job.pid)) {
    killProcess(job.pid);
  }

  try {
    unlinkSync(getJobPath(jobId));
    // Clean up associated files
    const extensions = [".prompt", ".jsonl", ".stderr", ".pid"];
    for (const ext of extensions) {
      try {
        unlinkSync(join(config.jobsDir, `${jobId}${ext}`));
      } catch {
        // File may not exist
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface StartJobOptions {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  parentSessionId?: string;
  cwd?: string;
  ephemeral?: boolean;
  onComplete?: string;
}

export function startJob(options: StartJobOptions): Job {
  ensureJobsDir();

  const jobId = generateJobId();
  const cwd = options.cwd || process.cwd();

  const job: Job = {
    id: jobId,
    status: "pending",
    prompt: options.prompt,
    model: options.model || config.model,
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    parentSessionId: options.parentSessionId,
    ephemeral: options.ephemeral !== false, // default true
    cwd,
    createdAt: new Date().toISOString(),
    onComplete: options.onComplete,
  };

  saveJob(job);

  // Spawn codex exec --json process
  const result = startExec({
    jobId,
    prompt: options.prompt,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    sandbox: job.sandbox,
    cwd,
    ephemeral: job.ephemeral,
  });

  if (result.success) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.pid = result.pid;
  } else {
    job.status = "failed";
    job.error = result.error || "Failed to start codex exec";
    job.completedAt = new Date().toISOString();
  }

  saveJob(job);
  return job;
}

export interface ResumeJobOptions {
  originalJobId: string;
  sessionId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  cwd: string;
}

export function startResumeJob(options: ResumeJobOptions): Job {
  ensureJobsDir();
  const jobId = generateJobId();

  const job: Job = {
    id: jobId,
    status: "pending",
    prompt: `[RESUMED from ${options.originalJobId}]`,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.sandbox,
    parentSessionId: options.originalJobId,
    sessionId: options.sessionId,
    ephemeral: false,
    cwd: options.cwd,
    createdAt: new Date().toISOString(),
  };

  saveJob(job);

  const result = resumeExec({
    jobId,
    sessionId: options.sessionId,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.sandbox,
    cwd: options.cwd,
  });

  if (result.success) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.pid = result.pid;
  } else {
    job.status = "failed";
    job.error = result.error || "Failed to resume codex exec";
    job.completedAt = new Date().toISOString();
  }

  saveJob(job);
  return job;
}

export function killJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  // Kill process by PID
  const pid = job.pid || getStoredPid(jobId);
  if (pid) {
    killProcess(pid);
  }

  job.status = "failed";
  job.error = "Killed by user";
  job.completedAt = new Date().toISOString();
  saveJob(job);
  tryCleanupAgentState(jobId, job.cwd, "failed", "Killed by user");
  return true;
}

export function getJobOutput(jobId: string, lines?: number): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  return getFormattedOutput(jobId, lines);
}

export function getJobFullOutput(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  return getFormattedOutput(jobId);
}

export function cleanupOldJobs(maxAgeDays: number = 7): number {
  const jobs = listJobs();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const job of jobs) {
    const jobTime = new Date(job.completedAt || job.createdAt).getTime();
    if (jobTime < cutoff && (job.status === "completed" || job.status === "failed")) {
      if (deleteJob(job.id)) cleaned++;
    }
  }

  return cleaned;
}

export function isJobRunning(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  const pid = job.pid || getStoredPid(jobId);
  if (!pid) return false;

  return isRunning(pid);
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.status !== "running") return job;

  const pid = job.pid || getStoredPid(jobId);
  const processAlive = pid ? isRunning(pid) : false;

  // Check JSONL for completion events
  const completionStatus = detectCompletion(jobId);

  if (completionStatus === "completed") {
    // Explicit success terminal event in JSONL
    job.status = "completed";
    job.completedAt = new Date().toISOString();

    // Extract metadata from JSONL
    const events = getAllEvents(jobId);
    const tokens = extractTokenUsage(events);
    if (tokens) job.tokensUsed = tokens;
    const files = extractFilesModified(events);
    if (files.length > 0) job.filesModified = files;
    if (!job.sessionId) {
      const sid = extractSessionId(events);
      if (sid) job.sessionId = sid;
    }

    saveJob(job);
    // Update state.db with completion status + release file locks
    tryCleanupAgentState(jobId, job.cwd, "completed", `Completed (auto-detected from JSONL). Files: ${JSON.stringify(job.filesModified || [])}`);
    // Run user-provided callback (outside sandbox, after state update)
    tryRunOnComplete(job);
  } else if (completionStatus === "failed") {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = "Agent task failed";
    if (!job.sessionId) {
      const sid = extractSessionId(getAllEvents(jobId));
      if (sid) job.sessionId = sid;
    }
    saveJob(job);
    tryCleanupAgentState(jobId, job.cwd, "failed", job.error);
    tryRunOnComplete(job);
  } else if (!processAlive) {
    // Process died without explicit success terminal event — always treat as failure
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = "process_exit_no_success_event";
    if (!job.sessionId) {
      const sid = extractSessionId(getAllEvents(jobId));
      if (sid) job.sessionId = sid;
    }
    saveJob(job);
    tryCleanupAgentState(jobId, job.cwd, "failed", job.error);
    tryRunOnComplete(job);
  } else if (isInactiveTimedOut(job)) {
    // Still running but no activity for too long
    if (pid) killProcess(pid);
    job.status = "failed";
    job.error = `Timed out after ${config.defaultTimeout} minutes of inactivity`;
    job.completedAt = new Date().toISOString();
    saveJob(job);
    tryCleanupAgentState(jobId, job.cwd, "failed", job.error);
    tryRunOnComplete(job);
  }

  return loadJob(jobId);
}

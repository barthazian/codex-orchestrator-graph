// Configuration for codex-agent

import { homedir } from "os";

export const config = {
  // Default model — override with CODEX_MODEL env var
  model: process.env.CODEX_MODEL ?? "gpt-5.3-codex-spark",

  // Review stage model — override with CODEX_REVIEW_MODEL env var (falls back to CODEX_MODEL)
  reviewModel: process.env.CODEX_REVIEW_MODEL ?? process.env.CODEX_MODEL ?? "gpt-5.3-codex-spark",

  // Reasoning effort levels — override with CODEX_REASONING env var
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: (process.env.CODEX_REASONING ?? "xhigh") as "low" | "medium" | "high" | "xhigh",

  // Review stage reasoning — override with CODEX_REVIEW_REASONING env var (falls back to high)
  reviewReasoningEffort: (process.env.CODEX_REVIEW_REASONING ?? process.env.CODEX_REASONING ?? "high") as "low" | "medium" | "high" | "xhigh",

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Job storage directory
  jobsDir: `${homedir()}/.codex-agent/jobs`,

  // Default inactivity timeout in minutes for running jobs
  defaultTimeout: 60,

  // Default number of jobs to show in listings
  jobsListLimit: 20,

};

export type ReasoningEffort = typeof config.reasoningEfforts[number];
export type SandboxMode = typeof config.sandboxModes[number];

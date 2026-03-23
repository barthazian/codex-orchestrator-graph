#!/usr/bin/env node
// codex-review.mjs — WebSocket client for codex app-server review API
// Robust Windows process-tree cleanup via PID file + taskkill /T /F
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

// --- CLI args ---
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const target = flag("--target");
const cwd = flag("--cwd") || process.cwd();
const output = flag("--output");
const timeout = Number(flag("--timeout") || 0);  // 0 = no timeout (cleanup via PID kill is sufficient)

if (!target || !output) {
  process.stderr.write("Usage: node codex-review.mjs --target <type> --cwd <path> --output <path> [--timeout <ms>]\n");
  process.exit(1);
}

// --- Verify codex on PATH ---
const isWindows = process.platform === "win32";
try {
  execFileSync(isWindows ? "where" : "which", ["codex"], { stdio: "ignore" });
} catch {
  process.stderr.write("codex not found on PATH\n");
  process.exit(1);
}

// --- Resolve WebSocket constructor ---
let WS = globalThis.WebSocket;
if (!WS) {
  try { WS = (await import("ws")).default; }
  catch { process.stderr.write("No WebSocket available (need Node 22+ or ws package)\n"); process.exit(1); }
}

// --- PID file for process-tree cleanup ---
const pidFile = join(cwd, "_codex", "codex-review-server.pid");

function cleanupPidFile() {
  try { if (existsSync(pidFile)) unlinkSync(pidFile); } catch { /* best-effort */ }
}

function killProcessTree(pid) {
  if (!pid) return;
  if (isWindows) {
    // taskkill /T /F kills entire process tree on Windows (cmd.exe → codex.exe → app-server)
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    // Unix: kill process group
    try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

// Pre-cleanup: kill any orphaned app-server from previous runs
if (existsSync(pidFile)) {
  try {
    const stalePid = Number(readFileSync(pidFile, "utf8").trim());
    if (stalePid > 0) {
      process.stderr.write(`Cleaning up stale app-server PID ${stalePid}\n`);
      killProcessTree(stalePid);
    }
  } catch { /* stale PID file — remove it */ }
  cleanupPidFile();
}

// --- Find free port ---
const port = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  srv.on("error", reject);
});

// --- Spawn app-server ---
// Windows: shell: true required for .cmd files. Orphan prevention via taskkill /T /F on PID.
// Unix: no shell needed; detached for process group kill.
const wsUrl = `ws://127.0.0.1:${port}`;
const server = spawn("codex", ["app-server", "--listen", wsUrl], {
  cwd,
  stdio: ["ignore", "ignore", "pipe"],  // capture stderr for debugging
  shell: isWindows,
  detached: !isWindows,
});

// Write PID file for cleanup
if (server.pid) {
  writeFileSync(pidFile, String(server.pid), "utf8");
}

// Capture stderr for diagnostics
let serverStderr = "";
if (server.stderr) {
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString();
    if (serverStderr.length > 4000) serverStderr = serverStderr.slice(-2000);
  });
}

let killed = false;
const cleanup = () => {
  if (killed) return;
  killed = true;
  // Step 1: graceful SIGTERM
  try { server.kill("SIGTERM"); } catch { /* already dead */ }
  // Step 2: force-kill entire process tree after 3 seconds
  setTimeout(() => {
    if (server.pid) killProcessTree(server.pid);
    cleanupPidFile();
  }, 3000);
  // Immediate: also try tree kill (belt + suspenders)
  if (server.pid) killProcessTree(server.pid);
  cleanupPidFile();
};

// Hook ALL exit paths — not just "exit"
process.on("exit", cleanup);
process.on("SIGTERM", () => { cleanup(); process.exit(1); });
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("uncaughtException", (err) => {
  process.stderr.write(`Uncaught exception: ${err.message}\n`);
  cleanup();
  process.exit(1);
});

server.on("exit", (code) => {
  if (!killed) {
    process.stderr.write(`codex app-server exited unexpectedly (code ${code})\n`);
    if (serverStderr) process.stderr.write(`Server stderr: ${serverStderr.slice(-500)}\n`);
    cleanupPidFile();
    process.exit(1);
  }
});

// --- Connect WebSocket with retry ---
const connect = () => new Promise((resolve, reject) => {
  const deadline = Date.now() + 10000;
  const attempt = () => {
    if (Date.now() > deadline) { reject(new Error("WebSocket connect timeout")); return; }
    const sock = new WS(wsUrl);
    let settled = false;
    sock.onopen = () => { settled = true; resolve(sock); };
    sock.onerror = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* retry handles this */ }
      setTimeout(attempt, 500);
    };
  };
  attempt();
});

let ws;
try { ws = await connect(); }
catch (e) { process.stderr.write(`${e.message}\n`); cleanup(); process.exit(1); }

// --- Parse target ---
function parseTarget(raw) {
  if (raw === "uncommittedChanges") return { type: "uncommittedChanges" };
  if (raw.startsWith("baseBranch:")) return { type: "baseBranch", branch: raw.slice(11) };
  if (raw.startsWith("commit:")) return { type: "commit", sha: raw.slice(7) };
  process.stderr.write(`Unknown target format: ${raw}\n`);
  cleanup();
  process.exit(1);
}

// --- JSON-RPC helpers ---
let rpcId = 0;
const send = (method, params) => {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, id: ++rpcId, params });
  ws.send(msg);
};

// --- Timeout guard (only if --timeout was explicitly passed, otherwise no limit) ---
const timer = timeout > 0 ? setTimeout(() => {
  process.stderr.write("review timed out\n");
  if (serverStderr) process.stderr.write(`Server stderr at timeout: ${serverStderr.slice(-500)}\n`);
  cleanup();
  setTimeout(() => process.exit(1), 4000);
}, timeout) : null;

// --- Protocol ---
let threadId;
let phase = "init"; // init → initialized → thread → review → done

ws.onmessage = (ev) => {
  const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  // Response to initialize
  if (phase === "init" && msg.id === 1 && msg.result) {
    phase = "initialized";
    // Send initialized notification (no id — it's a notification)
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    send("thread/start", {});
    return;
  }

  // Response to thread/start
  if (phase === "initialized" && msg.id === 2 && msg.result) {
    threadId = msg.result.threadId || msg.result.thread?.id;
    if (!threadId) {
      process.stderr.write(`No threadId in thread/start response: ${JSON.stringify(msg.result).slice(0, 200)}\n`);
      cleanup();
      process.exit(1);
    }
    phase = "review";
    send("review/start", { threadId, delivery: "inline", target: parseTarget(target) });
    return;
  }

  // Notification: item/completed with exitedReviewMode
  if (msg.method === "item/completed" &&
      msg.params?.item?.type === "exitedReviewMode") {
    phase = "done";
    clearTimeout(timer);
    writeFileSync(output, msg.params.item.review ?? "", "utf8");
    try { ws.close(); } catch { /* best effort */ }
    cleanup();
    // Wait for cleanup to finish then exit
    setTimeout(() => process.exit(0), 1000);
  }
};

ws.onerror = (err) => {
  process.stderr.write(`WebSocket error: ${err.message || err}\n`);
  clearTimeout(timer);
  cleanup();
  setTimeout(() => process.exit(1), 1000);
};

// --- Start: send initialize handshake ---
send("initialize", {
  clientInfo: { name: "codex-review-mjs", title: "Codex Review Script", version: "1.0.1" }
});

#!/usr/bin/env node
// codex-review.mjs — WebSocket client for codex app-server review API
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

// --- CLI args ---
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const target = flag("--target");
const cwd = flag("--cwd") || process.cwd();
const output = flag("--output");
const timeout = Number(flag("--timeout") || 120000);

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

// --- Find free port ---
const port = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  srv.on("error", reject);
});

// --- Spawn app-server ---
const wsUrl = `ws://127.0.0.1:${port}`;
const server = spawn("codex", ["app-server", "--listen", wsUrl], { cwd, stdio: "ignore", shell: isWindows });
let killed = false;
const cleanup = () => { if (!killed) { killed = true; server.kill(); } };
process.on("exit", cleanup);

server.on("exit", (code) => {
  if (!killed) {
    process.stderr.write(`codex app-server exited unexpectedly (code ${code})\n`);
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
    sock.onerror = (err) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch (closeErr) { /* retry handles this — close can re-fire onerror */ }
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

// --- Timeout guard ---
const timer = setTimeout(() => {
  process.stderr.write("review timed out\n");
  cleanup();
  process.exit(1);
}, timeout);

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
    ws.close?.();
    cleanup();
    process.exit(0);
  }
};

ws.onerror = (err) => {
  process.stderr.write(`WebSocket error: ${err.message || err}\n`);
  clearTimeout(timer);
  cleanup();
  process.exit(1);
};

// --- Start: send initialize handshake ---
send("initialize", {
  clientInfo: { name: "codex-review-mjs", title: "Codex Review Script", version: "1.0.0" }
});

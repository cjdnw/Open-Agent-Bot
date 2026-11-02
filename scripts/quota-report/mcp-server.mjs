#!/usr/bin/env node
/**
 * Read-only local quota MCP server (stdio JSON-RPC only).
 * No TCP/HTTP listen — not exposed to the public internet.
 * Never returns API keys, tokens, cookies, or unsanitized provider payloads.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { sanitize, assertNoSecrets, isSensitiveKey } from "./lib/sanitize.mjs";

const REPORT_DIR = process.env.QUOTA_REPORT_DIR || join(homedir(), ".openmausbot", "quota-report");
const DATA_DIR = process.env.QUOTA_DATA_DIR || join(REPORT_DIR, "data");
const TASK_NAME = process.env.QUOTA_TASK_NAME || "XinyunOpen-QuotaDailyReport";

const TOOLS = [
  {
    name: "get_quota_snapshot",
    description:
      "Read the latest local AI quota snapshot (providers + schedule summary). Read-only. Never returns secrets.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_quota_history",
    description:
      "Read recent local quota history entries (newest last). Optional limit (default 14, max 90).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max history rows to return (1-90)." },
      },
    },
  },
  {
    name: "get_schedule_status",
    description:
      "Read the local Windows scheduled-task status for the daily 20:00 quota report.",
    inputSchema: { type: "object", properties: {} },
  },
];

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function harden(payload) {
  const clean = sanitize(payload);
  // Extra hard filter: drop any lingering sensitive keys at top levels of nested objects
  const walk = (v) => {
    if (!v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const o = {};
    for (const [k, child] of Object.entries(v)) {
      if (isSensitiveKey(k)) continue;
      o[k] = walk(child);
    }
    return o;
  };
  const out = walk(clean);
  assertNoSecrets(out, "mcp-response");
  return out;
}

function getSnapshot() {
  const path = join(DATA_DIR, "snapshot.json");
  const snap = readJson(path);
  if (!snap) {
    return {
      available: false,
      message: "No snapshot yet. Run collector.mjs or wait for the 20:00 scheduled task.",
      data_dir: DATA_DIR,
    };
  }
  return harden({ available: true, ...snap });
}

function getHistory(limitRaw) {
  const path = join(DATA_DIR, "history.jsonl");
  if (!existsSync(path)) {
    return { available: false, entries: [], message: "No history yet." };
  }
  const limit = Math.min(90, Math.max(1, Number(limitRaw) || 14));
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const slice = lines.slice(-limit);
  const entries = [];
  for (const line of slice) {
    try {
      entries.push(harden(JSON.parse(line)));
    } catch {
      /* skip corrupt */
    }
  }
  return harden({ available: true, count: entries.length, entries });
}

function getSchedule() {
  const cached = readJson(join(DATA_DIR, "schedule-status.json"));
  const reports = existsSync(join(REPORT_DIR, "reports"))
    ? readdirSync(join(REPORT_DIR, "reports"))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(-7)
        .map((f) => {
          const full = join(REPORT_DIR, "reports", f);
          return { file: f, mtime: statSync(full).mtime.toISOString() };
        })
    : [];
  return harden({
    available: true,
    task_name: TASK_NAME,
    expected_time: "20:00 local",
    cached_status: cached,
    recent_reports: reports,
    note: "Schedule status is local Windows Task Scheduler metadata only.",
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id, obj, isError = false) =>
  ok(id, { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError });

function callTool(name, args) {
  if (name === "get_quota_snapshot") return getSnapshot();
  if (name === "get_quota_history") return getHistory(args?.limit);
  if (name === "get_schedule_status") return getSchedule();
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (!method) return;
  const params = msg.params ?? {};
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "xinyun-quota-readonly", version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        textResult(id, callTool(name, params.arguments ?? {}));
      } catch (e) {
        textResult(id, { error: String(e?.message || e) }, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, String(e?.message || e));
  });
});
rl.on("close", () => process.exit(0));

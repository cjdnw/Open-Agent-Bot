#!/usr/bin/env node
/** Drive the local stdio MCP server and call all three readonly tools. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(here, "mcp-server.mjs");
const reportDir = process.env.QUOTA_REPORT_DIR || join(homedir(), ".openmausbot", "quota-report");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    QUOTA_REPORT_DIR: reportDir,
    QUOTA_DATA_DIR: join(reportDir, "data"),
  },
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout ${method}`));
    }, 20000);
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function textOf(msg) {
  const c = msg?.result?.content?.[0]?.text;
  return c || JSON.stringify(msg);
}

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "quota-verify", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const listed = await request("tools/list", {});
  const names = (listed.result?.tools || []).map((t) => t.name);
  const expected = ["get_quota_snapshot", "get_quota_history", "get_schedule_status"];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`missing tool ${name}; got ${names.join(",")}`);
  }
  const results = {};
  for (const name of expected) {
    const msg = await request("tools/call", { name, arguments: name === "get_quota_history" ? { limit: 3 } : {} });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const text = textOf(msg);
    if (/sk-|Bearer |access_token|refresh_token|api[_-]?key/i.test(text)) {
      throw new Error(`${name} leaked secret-shaped content`);
    }
    results[name] = JSON.parse(text);
  }
  process.stdout.write(JSON.stringify({ ok: true, tools: names, results }, null, 2) + "\n");
  child.kill();
  process.exit(0);
} catch (error) {
  console.error(error);
  child.kill();
  process.exit(1);
}

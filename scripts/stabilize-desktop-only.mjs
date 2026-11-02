#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DESKTOP_EXE = join(homedir(), "Desktop", "XinyunOpen-Bot-0.1.28", "XinyunOpen Bot.exe");
const DESKTOP_SERVER = join(homedir(), "Desktop", "XinyunOpen-Bot-0.1.28", "resources", "server");
const PROGRAMS_EXE = join(homedir(), "AppData", "Local", "Programs", "XinyunOpen Bot", "XinyunOpen Bot.exe");
const BOTS = join(homedir(), ".openmausbot", "bots.json");
const LOG = join(homedir(), "AppData", "Roaming", "openmausbot", "logs", "server.log");

function killXinyun() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process -Name 'XinyunOpen Bot' -ErrorAction SilentlyContinue | Stop-Process -Force"`,
      { stdio: "ignore" },
    );
  } catch {}
}

function clearBusy() {
  if (!existsSync(BOTS)) return;
  const bots = JSON.parse(readFileSync(BOTS, "utf8"));
  for (const b of bots) b.busy = false;
  writeFileSync(BOTS, JSON.stringify(bots, null, 2));
  console.log(
    "busy_cleared",
    bots.map((b) => `${b.name}=${!!b.busy}`).join(", "),
  );
}

function fixLoadEnv() {
  const index = join(DESKTOP_SERVER, "index.js");
  let c = readFileSync(index, "utf8");
  const before = c.slice(0, 40);
  c = c.replace(/import\s+"(\.[^"]+)\.ts"/g, 'import "$1.js"');
  writeFileSync(index, c);
  console.log("load_env", before, "=>", c.slice(0, 40));
}

function checkPatches() {
  for (const f of ["model-fallback.js", "workspace-knowledge.js", "index.js"]) {
    console.log("patch", f, existsSync(join(DESKTOP_SERVER, f)));
  }
  const idx = readFileSync(join(DESKTOP_SERVER, "index.js"), "utf8");
  console.log("has_workspace", idx.includes("workspaceKnowledgePrompt"));
  console.log("has_interrupt_clear", idx.includes("pendingFallbackThreads.delete(bot.threadId)"));
  console.log("programs_exists", existsSync(PROGRAMS_EXE));
  console.log("programs_has_workspace", existsSync(join(homedir(), "AppData", "Local", "Programs", "XinyunOpen Bot", "resources", "server", "workspace-knowledge.js")));
}

async function waitApi(port, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!h.ok) throw new Error("bad health");
      const botsRes = await fetch(`http://127.0.0.1:${port}/api/bots`);
      const body = await botsRes.json();
      const bots = body.bots || body;
      return { port, health: await h.json().catch(() => ({})), bots };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

killXinyun();
await new Promise((r) => setTimeout(r, 2000));
clearBusy();
fixLoadEnv();
checkPatches();
if (!existsSync(DESKTOP_EXE)) throw new Error("desktop exe missing");
spawn(DESKTOP_EXE, [], { detached: true, stdio: "ignore" }).unref();
const api = (await waitApi(8799)) || (await waitApi(18799));
if (!api) {
  console.log("API_FAIL");
  if (existsSync(LOG)) console.log(readFileSync(LOG, "utf8").split(/\r?\n/).slice(-20).join("\n"));
  process.exit(1);
}
console.log("API_OK port", api.port);
console.log(
  "bots",
  api.bots.map((b) => `${b.name}:busy=${!!b.busy}`).join(", "),
);
if (existsSync(LOG)) {
  const lines = readFileSync(LOG, "utf8").trim().split(/\r?\n/).slice(-6);
  console.log("log", lines.join(" | "));
}

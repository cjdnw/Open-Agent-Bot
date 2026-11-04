import { spawnSync, spawn, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEST = join(homedir(), "Desktop", "cjdnw_bot");
const WF = join(ROOT, "dist-server-wf");
const files = [
  "server/workflow.ts",
  "server/workflow-prompts.ts",
  "server/workflow-orchestrator.ts",
  "server/turn-lifecycle.ts",
  "server/model-fallback.ts",
  "server/chief-of-staff.ts",
  "server/reasoning.ts",
  "server/drivers/claude.ts",
  "server/index.ts",
  "server/workspace-knowledge.ts",
];

execSync(
  `powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match 'cjdnw_bot' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
  { stdio: "ignore" },
);

const r = spawnSync(
  `npx -y esbuild ${files.join(" ")} --outdir=${JSON.stringify(WF)} --format=esm --platform=node --packages=external`,
  { cwd: ROOT, encoding: "utf8", shell: true },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

function rewriteTsImports(code) {
  return code.replace(/\.ts"/g, '.js"').replace(/\.ts'/g, ".js'");
}
function copyBuiltTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir)) {
    const src = join(fromDir, name);
    const dest = join(toDir, name);
    if (statSync(src).isDirectory()) {
      copyBuiltTree(src, dest);
      continue;
    }
    if (!name.endsWith(".js")) continue;
    writeFileSync(dest, rewriteTsImports(readFileSync(src, "utf8")));
  }
}
copyBuiltTree(WF, join(DEST, "resources", "server"));

const idxPath = join(DEST, "resources", "server", "index.js");
let idx = readFileSync(idxPath, "utf8");
idx = idx.replace(/app:\s*"openmausbot"/g, 'app: process.env.OMB_APP_NAME || "openmausbot"');
writeFileSync(idxPath, idx);

const chief = readFileSync(join(DEST, "resources", "server", "chief-of-staff.js"), "utf8");
console.log("chief exports ok:", /isCollaborationWorkflowEnabled/.test(chief));

await new Promise((r) => setTimeout(r, 1500));
spawn(join(DEST, "cjdnw_bot.exe"), [], {
  detached: true,
  stdio: "ignore",
  cwd: DEST,
  env: {
    ...process.env,
    OMB_DATA_DIR: join(homedir(), ".cjdnw_bot"),
    OMB_APP_NAME: "cjdnw_bot",
  },
}).unref();

for (let i = 0; i < 40; i++) {
  for (const port of [18899, 28899, 38899]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.app === "cjdnw_bot") {
        console.log("HEALTH_OK", { port, ...body });
        process.exit(0);
      }
    } catch {
      /* retry */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error("HEALTH_FAIL");
process.exit(2);

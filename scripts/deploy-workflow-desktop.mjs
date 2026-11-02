import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist-server-wf");
const dest = join(process.env.USERPROFILE || "", "Desktop", "XinyunOpen-Bot-0.1.28", "resources", "server");

const files = [
  "server/workflow.ts",
  "server/workflow-prompts.ts",
  "server/workflow-orchestrator.ts",
  "server/turn-lifecycle.ts",
  "server/model-fallback.ts",
  "server/index.ts",
];

mkdirSync(out, { recursive: true });
const r = spawnSync(
  "npx",
  ["-y", "esbuild", ...files, `--outdir=${out}`, "--format=esm", "--platform=node", "--packages=external"],
  { cwd: root, encoding: "utf8", shell: true },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if (r.status !== 0) process.exit(r.status || 1);

for (const name of readdirSync(out).filter((f) => f.endsWith(".js"))) {
  const p = join(out, name);
  const fixed = readFileSync(p, "utf8").replace(/\.ts"/g, '.js"').replace(/\.ts'/g, ".js'");
  writeFileSync(p, fixed);
}

if (!existsSync(dest)) {
  console.error("missing desktop server dir", dest);
  process.exit(1);
}

for (const name of [
  "workflow.js",
  "workflow-prompts.js",
  "workflow-orchestrator.js",
  "turn-lifecycle.js",
  "model-fallback.js",
  "index.js",
]) {
  copyFileSync(join(out, name), join(dest, name));
  console.log("copied", name);
}
console.log("DESKTOP_OK", dest);

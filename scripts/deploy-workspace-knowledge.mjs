#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_SERVER = join(homedir(), "Desktop", "XinyunOpen-Bot-0.1.28", "resources", "server");
const outDir = join(ROOT, "dist-server-deploy");
mkdirSync(outDir, { recursive: true });

const files = ["workspace-knowledge.ts", "index.ts"];
for (const f of files) {
  const input = join(ROOT, "server", f);
  const outfile = join(outDir, f.replace(/\.ts$/, ".js"));
  const build = spawnSync(
    "npx.cmd",
    ["--yes", "esbuild@0.28.2", input, `--outfile=${outfile}`, "--format=esm", "--platform=node", "--packages=external", "--target=node20"],
    { cwd: ROOT, encoding: "utf8", shell: true },
  );
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
    process.exit(1);
  }
  let code = readFileSync(outfile, "utf8");
  code = code.replace(/from\s+"(\.[^"]+)\.ts"/g, 'from "$1.js"');
  code = code.replace(/from\s+'(\.[^']+)\.ts'/g, "from '$1.js'");
  code = code.replace(/import\s+"(\.[^"]+)\.ts"/g, 'import "$1.js"');
  code = code.replace(/import\s+'(\.[^']+)\.ts'/g, "import '$1.js'");
  writeFileSync(outfile, code);
  const dest = join(APP_SERVER, f.replace(/\.ts$/, ".js"));
  if (!existsSync(APP_SERVER)) throw new Error(`missing ${APP_SERVER}`);
  copyFileSync(outfile, dest);
  console.log("deployed", f.replace(/\.ts$/, ".js"));
}

// smoke: load handbook
const { workspaceKnowledgePrompt } = await import(join(outDir, "workspace-knowledge.js"));
const text = workspaceKnowledgePrompt();
console.log("handbook chars", text.length);
console.log(text.split("\n").slice(0, 12).join("\n"));
console.log("...");
console.log("skills section present", /## Codex \/ agents skills/.test(text));
console.log("210 section present", /Server 210 knowledge base/.test(text));

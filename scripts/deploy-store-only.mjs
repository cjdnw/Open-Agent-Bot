import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), "dev", "XinyunOpenBot-v0.1.28");
const out = join(ROOT, "dist-server-deploy", "store.js");
const dest = join(homedir(), "Desktop", "XinyunOpen-Bot-0.1.28", "resources", "server", "store.js");
const r = spawnSync(
  "npx.cmd",
  ["--yes", "esbuild@0.28.2", "server/store.ts", `--outfile=${out}`, "--format=esm", "--platform=node", "--packages=external", "--target=node20"],
  { cwd: ROOT, encoding: "utf8", shell: true },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(1);
}
let c = readFileSync(out, "utf8");
c = c.replace(/from\s+"(\.[^"]+)\.ts"/g, 'from "$1.js"');
writeFileSync(out, c);
copyFileSync(out, dest);
console.log("store_ok", c.includes("busy=true on disk") || c.includes("b.busy = false"));

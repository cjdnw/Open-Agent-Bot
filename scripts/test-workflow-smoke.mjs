import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const r = spawnSync(
  process.execPath,
  ["--experimental-strip-types", join(root, "scripts", "test-workflow-smoke-body.ts")],
  { encoding: "utf8", cwd: root },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);

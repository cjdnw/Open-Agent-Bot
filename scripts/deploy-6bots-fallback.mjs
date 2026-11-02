#!/usr/bin/env node
/**
 * Deploy fallback modules into the portable 0.1.28 app and write the six
 * formal bots into ~/.openmausbot/bots.json (idempotent).
 * Never prints API keys.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const APP_SERVER = join(homedir(), "Desktop", "XinyunOpen-Bot-0.1.28", "resources", "server");
const DATA = join(homedir(), ".openmausbot");
const BACKUP = join(DATA, `backup-deploy-6bots-${stamp()}`);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function backupFile(rel) {
  const src = join(DATA, rel);
  if (!existsSync(src)) return;
  const dest = join(BACKUP, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function routing(primary, fallbacks) {
  return {
    enabled: true,
    primary,
    fallbacks,
    defaultEffort: "high",
    maxAttempts: 1 + fallbacks.length,
    cooldownPolicy: "skip_pool_on_quota",
  };
}

const NINEBOT_PRO = "external/deepseek-v4-pro-0813";

const BOT_SPECS = [
  {
    name: "Momo",
    title: "AI Project Manager / Supervisor",
    description:
      "Understand requirements, assess difficulty/risk, design the plan, delegate to specialist bots, collect real results, decide when to raise effort to XHigh, check acceptance criteria, and report to the user. Do not call every employee for simple tasks. Do not pretend work was done.",
    color: "coral",
    chiefOfStaff: true,
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    modelRouting: routing(
      { instanceId: "codex", model: "gpt-6.1-sol", label: "Codex Sol High" },
      [
        { instanceId: "antigravity", model: "gemini-4-argon-high" },
        { instanceId: "antigravity", model: "claude-opus-5-5-high" },
        { instanceId: "claude", model: "claude-opus-5-5" },
        { instanceId: "ninebot", model: NINEBOT_PRO },
        { instanceId: "deepseek-aliyun", model: "deepseek-v4-pro-0813" },
      ],
    ),
  },
  {
    name: "Architect",
    title: "AI Algorithm & Architecture Expert",
    description:
      "Deep learning research, RV+BEV semantic segmentation, network design, loss/training strategy, Drop Recall/Precision tradeoffs, high-complexity algorithm review. Never claim accuracy gains without measured tests.",
    color: "purple",
    modelSelection: { instanceId: "antigravity", model: "claude-opus-5-5-high" },
    modelRouting: routing(
      { instanceId: "antigravity", model: "claude-opus-5-5-high" },
      [
        { instanceId: "claude", model: "claude-opus-5-5" },
        { instanceId: "codex", model: "gpt-6.1-sol" },
        { instanceId: "ninebot", model: NINEBOT_PRO },
        { instanceId: "deepseek-aliyun", model: "deepseek-v4-pro-0813" },
      ],
    ),
  },
  {
    name: "Developer",
    title: "Software Development Engineer",
    description:
      "Python/C++ implementation, refactoring, bugfix, git branch work, unit tests. Skip Bailian Kimi if code-edit/shell/tooling is insufficient for the task. Never use composer-2.5.",
    color: "blue",
    modelSelection: { instanceId: "cursor", model: "grok-4.7" },
    modelRouting: routing(
      { instanceId: "cursor", model: "grok-4.7" },
      [
        { instanceId: "deepseek-aliyun", model: "kimi/kimi-k2.8-preview", requireAgentsMcp: false },
        { instanceId: "codex", model: "gpt-6.1-terra" },
        { instanceId: "claude", model: "claude-sonnet-5-5" },
      ],
    ),
  },
  {
    name: "Deploy",
    title: "Embedded Deployment & Performance Engineer",
    description:
      "ONNX export, RKNN compile/quantize/deploy, RK3576 on-device inference, CPU/NPU optimization, zero-copy/memory, Linux/SSH/C++ deploy troubleshooting. Respect permission gates for flashing, destructive shell, remote deletes. Do not re-run side-effecting steps after a model switch.",
    color: "teal",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-terra" },
    modelRouting: routing(
      { instanceId: "codex", model: "gpt-6.1-terra" },
      [
        { instanceId: "claude", model: "claude-sonnet-5-5" },
        { instanceId: "ninebot", model: NINEBOT_PRO },
        { instanceId: "deepseek-aliyun", model: "deepseek-v4-pro-0813" },
      ],
    ),
  },
  {
    name: "QA",
    title: "Quality Assurance & Test Engineer",
    description:
      "Unit test design/execution, training log triage, regression, runtime error analysis, metric anomaly detection. Base conclusions on real runs/logs — never invent pass results.",
    color: "green",
    modelSelection: { instanceId: "antigravity", model: "gemini-3.8-flash-high" },
    modelRouting: routing(
      { instanceId: "antigravity", model: "gemini-3.8-flash-high" },
      [{ instanceId: "deepseek-aliyun", model: "deepseek-v4.1-flash-1017" }],
    ),
  },
  {
    name: "Reporter",
    title: "Experiment Reporting & Data Analysis Assistant",
    description:
      "Experiment data tables, Markdown technical reports, model comparisons, training summaries, docs. Clearly separate measured data, estimates, and model suggestions.",
    color: "orange",
    modelSelection: { instanceId: "antigravity", model: "gemini-3.8-flash-high" },
    modelRouting: routing(
      { instanceId: "antigravity", model: "gemini-3.8-flash-high" },
      [{ instanceId: "deepseek-aliyun", model: "deepseek-v4.1-flash-1017" }],
    ),
  },
];

function assertNoComposer(bots) {
  const bad = [];
  for (const b of bots) {
    const models = [b.modelSelection?.model, b.modelRouting?.primary?.model, ...(b.modelRouting?.fallbacks?.map((f) => f.model) || [])];
    for (const m of models) if (m && /composer-2\.5/i.test(m)) bad.push(`${b.name}:${m}`);
  }
  must(bad.length === 0, `composer-2.5 forbidden: ${bad.join(",")}`);
}

function upsertBots() {
  const botsPath = join(DATA, "bots.json");
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(botsPath, "utf8"));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }

  const byName = new Map(existing.map((b) => [b.name, b]));
  const next = [];

  for (const spec of BOT_SPECS) {
    const prev = byName.get(spec.name);
    if (prev) {
      next.push({
        ...prev,
        name: spec.name,
        title: spec.title,
        description: spec.description,
        color: spec.color,
        modelSelection: spec.modelSelection,
        modelRouting: spec.modelRouting,
        chiefOfStaff: Boolean(spec.chiefOfStaff),
        hidden: false,
        busy: false,
      });
      byName.delete(spec.name);
    } else if (spec.name === "Momo") {
      // Prefer renaming a single blank auto-bot into Momo
      const blank = [...byName.values()].find(
        (b) =>
          (!b.title || !String(b.title).trim()) &&
          (!b.description || !String(b.description).trim()) &&
          !BOT_SPECS.some((s) => s.name === b.name && s.name !== "Momo"),
      );
      if (blank && byName.size === 1) {
        next.push({
          ...blank,
          name: "Momo",
          title: spec.title,
          description: spec.description,
          color: spec.color,
          modelSelection: spec.modelSelection,
          modelRouting: spec.modelRouting,
          chiefOfStaff: true,
          hidden: false,
          busy: false,
        });
        byName.delete(blank.name);
      } else {
        const id = randomUUID();
        const threadId = randomUUID();
        const createdAt = Date.now();
        next.push({
          id,
          threadId,
          name: spec.name,
          title: spec.title,
          description: spec.description,
          notifications: true,
          color: spec.color,
          unread: false,
          modelSelection: spec.modelSelection,
          modelRouting: spec.modelRouting,
          resumeCursors: {},
          createdAt,
          tasks: [{ threadId, title: "New task", createdAt, resumeCursors: {} }],
          chiefOfStaff: true,
          busy: false,
        });
      }
    } else {
      const id = randomUUID();
      const threadId = randomUUID();
      const createdAt = Date.now();
      next.push({
        id,
        threadId,
        name: spec.name,
        title: spec.title,
        description: spec.description,
        notifications: true,
        color: spec.color,
        unread: false,
        modelSelection: spec.modelSelection,
        modelRouting: spec.modelRouting,
        resumeCursors: {},
        createdAt,
        tasks: [{ threadId, title: "New task", createdAt, resumeCursors: {} }],
        chiefOfStaff: false,
        busy: false,
      });
    }
  }

  // Drop leftover non-formal bots so the fleet is exactly six
  for (const leftover of byName.values()) {
    console.log(`removing non-formal bot: ${leftover.name} (${leftover.id})`);
  }

  // Ensure exactly one chief
  for (const b of next) b.chiefOfStaff = b.name === "Momo";
  assertNoComposer(next);
  must(next.length === 6, `expected 6 bots, got ${next.length}`);
  must(next.filter((b) => b.chiefOfStaff).length === 1, "Momo must be sole chief");

  writeFileSync(botsPath, JSON.stringify(next, null, 2));
  return next;
}

function buildServer() {
  const outDir = join(ROOT, "dist-server-deploy");
  mkdirSync(outDir, { recursive: true });
  const files = [
    "model-fallback.ts",
    "workspace-knowledge.ts",
    "reasoning.ts",
    "contracts.ts",
    "store.ts",
    "index.ts",
  ];
  for (const f of files) {
    const input = join(ROOT, "server", f);
    const outfile = join(outDir, f.replace(/\.ts$/, ".js"));
    const r = spawnSync(
      process.execPath,
      [
        join(homedir(), ".local", "nodejs", "node_modules", "npm", "bin", "npx-cli.js"),
      ],
      { encoding: "utf8" },
    );
    // Prefer direct npx.cmd on Windows
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const build = spawnSync(
      npx,
      [
        "--yes",
        "esbuild@0.28.2",
        input,
        "--outfile=" + outfile,
        "--format=esm",
        "--platform=node",
        "--packages=external",
        "--target=node20",
      ],
      { cwd: ROOT, encoding: "utf8", shell: true },
    );
    if (build.status !== 0) {
      console.error(build.stdout);
      console.error(build.stderr);
      throw new Error(`esbuild failed for ${f}`);
    }
    // Rewrite .ts imports to .js for packaged runtime (including side-effect imports)
    let code = readFileSync(outfile, "utf8");
    code = code.replace(/from\s+"(\.[^"]+)\.ts"/g, 'from "$1.js"');
    code = code.replace(/from\s+'(\.[^']+)\.ts'/g, "from '$1.js'");
    code = code.replace(/import\s+"(\.[^"]+)\.ts"/g, 'import "$1.js"');
    code = code.replace(/import\s+'(\.[^']+)\.ts'/g, "import '$1.js'");
    writeFileSync(outfile, code);
  }
  return outDir;
}

function deployJs(outDir) {
  must(existsSync(APP_SERVER), `app server missing: ${APP_SERVER}`);
  const bak = join(APP_SERVER, `_bak_fallback_${stamp()}`);
  mkdirSync(bak, { recursive: true });
  const names = [
    "model-fallback.js",
    "workspace-knowledge.js",
    "reasoning.js",
    "contracts.js",
    "store.js",
    "index.js",
  ];
  for (const n of names) {
    const dest = join(APP_SERVER, n);
    if (existsSync(dest)) copyFileSync(dest, join(bak, n));
    copyFileSync(join(outDir, n), dest);
    console.log(`deployed ${n}`);
  }
}

function main() {
  must(existsSync(DATA), `data dir missing: ${DATA}`);
  mkdirSync(BACKUP, { recursive: true });
  backupFile("config.json");
  backupFile("bots.json");
  for (const f of readdirSync(DATA)) {
    if (f.startsWith("messages-") && f.endsWith(".json")) backupFile(f);
  }
  console.log(`backup -> ${BACKUP}`);

  const outDir = buildServer();
  deployJs(outDir);
  const bots = upsertBots();
  console.log(
    "bots:",
    bots.map((b) => ({
      name: b.name,
      id: b.id,
      chief: !!b.chiefOfStaff,
      primary: `${b.modelSelection.instanceId}/${b.modelSelection.model}`,
      fallbacks: (b.modelRouting?.fallbacks || []).map((f) => `${f.instanceId}/${f.model}`),
      effort: b.modelRouting?.defaultEffort,
    })),
  );
}

main();

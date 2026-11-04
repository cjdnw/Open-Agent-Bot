#!/usr/bin/env node
/**
 * Redeploy the modified Open-Agent-Bot as an isolated Desktop app: cjdnw_bot.
 * Separate folder, exe name, userData, data dir, and ports from XinyunOpen Bot.
 */
import { spawnSync, spawn, execSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP = join(homedir(), "Desktop");
const DEST_APP = join(DESKTOP, "cjdnw_bot");
function resolveSrcApp() {
  // Prefer in-place when already installed; else bootstrap from archive/install.
  if (existsSync(join(DEST_APP, "cjdnw_bot.exe"))) return DEST_APP;
  const candidates = [
    join(DESKTOP, "XinyunOpen-Bot-0.1.28"),
    join(DESKTOP, "_archive_XinyunOpen-Bot-0.1.28"),
  ];
  for (const p of candidates) {
    if (
      existsSync(join(p, "resources", "app.asar")) ||
      existsSync(join(p, "XinyunOpen Bot.exe"))
    ) {
      return p;
    }
  }
  return candidates[0];
}
const DATA_DIR = join(homedir(), ".cjdnw_bot");
const APP_NAME = "cjdnw_bot";
const APP_ID = "com.cjdnw.bot";
const PORTS = [18899, 28899, 38899];
const WF_OUT = join(ROOT, "dist-server-wf");

function sh(cmd, opts = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    cwd: ROOT,
    ...opts,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if ((r.status ?? 1) !== 0 && !opts.allowFail) {
    throw new Error(`cmd failed (${r.status}): ${cmd}`);
  }
  return r;
}

function killXinyun() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match 'XinyunOpen|cjdnw_bot' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
      { stdio: "ignore" },
    );
  } catch {
    /* ignore */
  }
}

function buildServer() {
  mkdirSync(WF_OUT, { recursive: true });
  const lgOut = join(WF_OUT, "langgraph");
  mkdirSync(lgOut, { recursive: true });
  sh(
    `npx -y esbuild server/langgraph/index.ts --bundle --outfile=${JSON.stringify(join(lgOut, "index.js"))} --format=esm --platform=node`,
  );
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
  ].filter((f) => existsSync(join(ROOT, f)));
  sh(
    `npx -y esbuild ${files.join(" ")} --outdir=${JSON.stringify(WF_OUT)} --format=esm --platform=node --packages=external`,
  );
  for (const name of readdirSync(WF_OUT).filter((f) => f.endsWith(".js"))) {
    const p = join(WF_OUT, name);
    const fixed = readFileSync(p, "utf8").replace(/\.ts"/g, '.js"').replace(/\.ts'/g, ".js'");
    writeFileSync(p, fixed);
  }
}

function patchHealth(serverIndexPath) {
  let c = readFileSync(serverIndexPath, "utf8");
  // Brand health identity via env so Electron probe can match.
  c = c.replace(
    /app:\s*"openmausbot"/g,
    'app: process.env.OMB_APP_NAME || "openmausbot"',
  );
  // Soft-replace persona strings in this packaged copy only.
  c = c.replace(/XinyunOpen Bot/g, "cjdnw_bot");
  writeFileSync(serverIndexPath, c);
}

function patchMainAsar(asarPath) {
  const unpack = join(DEST_APP, "resources", "_asar_unpack");
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  sh(`npx -y @electron/asar extract ${JSON.stringify(asarPath)} ${JSON.stringify(unpack)}`);
  const mainPath = join(unpack, "electron", "main.mjs");
  if (!existsSync(mainPath)) throw new Error("asar missing electron/main.mjs");
  // Prefer current repo main.mjs (env-aware), then force cjdnw defaults for this package.
  const srcMain = join(ROOT, "electron", "main.mjs");
  let main = existsSync(srcMain) ? readFileSync(srcMain, "utf8") : readFileSync(mainPath, "utf8");
  main = main
    .replace(
      /const APP_BRAND = process\.env\.OMB_APP_NAME \|\| "XinyunOpen Bot";/,
      `const APP_BRAND = process.env.OMB_APP_NAME || "${APP_NAME}";`,
    )
    .replace(
      /process\.env\.OMB_APP_USER_MODEL_ID \|\| "com\.dongpen\.xinyunopenbot"/,
      `process.env.OMB_APP_USER_MODEL_ID || "${APP_ID}"`,
    )
    .replace(/XinyunOpen Bot/g, APP_NAME);
  // Legacy asar (pre env-aware): still force names/paths/ports.
  main = main
    .replace(/app\.setName\("[^"]+"\)/, `app.setName("${APP_NAME}")`)
    .replace(
      /path\.join\(app\.getPath\("appData"\), "openmausbot"\)/,
      `path.join(app.getPath("appData"), "${APP_NAME}")`,
    )
    .replace(
      /for \(const port of \[8799, 18799, 28799\]\)/,
      `for (const port of [${PORTS.join(", ")}])`,
    );
  if (!main.includes("OMB_DATA_DIR")) {
    main = main.replace(
      "OMB_STATIC_DIR: path.join(process.resourcesPath, \"ui\"),\n      OMB_PORT: String(port),",
      `OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),\n      OMB_PORT: String(port),\n      OMB_DATA_DIR: process.env.OMB_DATA_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".${APP_NAME}"),\n      OMB_APP_NAME: process.env.OMB_APP_NAME || "${APP_NAME}",`,
    );
  }
  writeFileSync(mainPath, main);
  const pkgPath = join(unpack, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = APP_NAME;
    pkg.productName = APP_NAME;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
  const packed = join(DEST_APP, "resources", "app.asar");
  sh(`npx -y @electron/asar pack ${JSON.stringify(unpack)} ${JSON.stringify(packed)}`);
  rmSync(unpack, { recursive: true, force: true });
}

function seedDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  const legacy = join(homedir(), ".openmausbot");
  // Copy fleet once if destination empty — keeps 7 bots, then stays isolated.
  if (!existsSync(join(DATA_DIR, "bots.json")) && existsSync(join(legacy, "bots.json"))) {
    for (const name of readdirSync(legacy)) {
      if (["events", "native"].includes(name)) continue; // skip bulky logs
      const from = join(legacy, name);
      const to = join(DATA_DIR, name);
      try {
        cpSync(from, to, { recursive: true });
      } catch (e) {
        console.warn("seed skip", name, e.message);
      }
    }
    console.log("seeded", DATA_DIR, "from", legacy);
  } else {
    console.log("data_dir", DATA_DIR, "exists_or_no_legacy");
  }
}

function makeShortcut(exePath) {
  const lnk = join(DESKTOP, "cjdnw_bot.lnk");
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut(${JSON.stringify(lnk)})
$s.TargetPath = ${JSON.stringify(exePath)}
$s.WorkingDirectory = ${JSON.stringify(DEST_APP)}
$s.WindowStyle = 1
$s.Description = "cjdnw_bot (Open-Agent-Bot fork)"
$s.IconLocation = ${JSON.stringify(exePath)}
$s.Save()
Write-Output "shortcut=$($s.FullName)"
`;
  const script = join(homedir(), "AppData", "Local", "Temp", "make-cjdnw-shortcut.ps1");
  writeFileSync(script, ps, "utf8");
  sh(`powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(script)}`);
}

async function waitAnyHealth(ports, tries = 80) {
  for (let i = 0; i < tries; i++) {
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          const body = await res.json();
          if (body?.app === APP_NAME) return { port, ...body };
        }
      } catch {
        /* retry */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  const SRC_APP = resolveSrcApp();
  if (!existsSync(SRC_APP)) throw new Error(`missing source app: ${SRC_APP}`);
  console.log("kill running bots…");
  killXinyun();
  await new Promise((r) => setTimeout(r, 1500));

  console.log("build server…");
  buildServer();

  console.log("build UI…");
  sh("pnpm exec vite build");

  const inPlace = SRC_APP === DEST_APP && existsSync(join(DEST_APP, "cjdnw_bot.exe"));
  if (!inPlace) {
    console.log("copy app →", DEST_APP, "(from", SRC_APP + ")");
    rmSync(DEST_APP, { recursive: true, force: true });
    cpSync(SRC_APP, DEST_APP, { recursive: true });
  } else {
    console.log("in-place update →", DEST_APP);
  }

  const oldExe = join(DEST_APP, "XinyunOpen Bot.exe");
  const newExe = join(DEST_APP, "cjdnw_bot.exe");
  if (existsSync(oldExe)) renameSync(oldExe, newExe);
  if (!existsSync(newExe)) throw new Error("exe rename failed");

  console.log("patch asar…");
  patchMainAsar(join(DEST_APP, "resources", "app.asar"));

  console.log("deploy server…");
  const serverDest = join(DEST_APP, "resources", "server");
  for (const name of readdirSync(WF_OUT).filter((f) => f.endsWith(".js"))) {
    copyFileSync(join(WF_OUT, name), join(serverDest, name));
  }
  const lgDest = join(serverDest, "langgraph");
  mkdirSync(lgDest, { recursive: true });
  const lgSrc = join(WF_OUT, "langgraph");
  if (existsSync(lgSrc)) {
    for (const name of readdirSync(lgSrc).filter((f) => f.endsWith(".js"))) {
      copyFileSync(join(lgSrc, name), join(lgDest, name));
    }
  }
  // Keep previously deployed helpers if present in src app.
  for (const extra of ["workspace-knowledge.js", "model-fallback.js"]) {
    const p = join(WF_OUT, extra);
    if (existsSync(p)) copyFileSync(p, join(serverDest, extra));
  }
  patchHealth(join(serverDest, "index.js"));

  console.log("deploy UI…");
  const uiSrc = join(ROOT, "dist");
  const uiDest = join(DEST_APP, "resources", "ui");
  if (!existsSync(join(uiSrc, "index.html"))) throw new Error("vite build missing dist/index.html");
  rmSync(uiDest, { recursive: true, force: true });
  cpSync(uiSrc, uiDest, { recursive: true });
  // Soft brand the SPA title so it matches cjdnw_bot.
  const uiIndex = join(uiDest, "index.html");
  if (existsSync(uiIndex)) {
    writeFileSync(
      uiIndex,
      readFileSync(uiIndex, "utf8").replace(/XinyunOpen Bot/g, APP_NAME).replace(/OpenMausBot/g, APP_NAME),
    );
  }

  // Disable auto-update pointing at XinyunOpen releases.
  const updateYml = join(DEST_APP, "resources", "app-update.yml");
  if (existsSync(updateYml)) {
    writeFileSync(
      updateYml,
      `# cjdnw_bot — auto-update disabled (fork of Open-Agent-Bot)\nprovider: generic\nurl: https://127.0.0.1/disabled\n`,
    );
  }

  seedDataDir();
  makeShortcut(newExe);

  // README beside install
  writeFileSync(
    join(DEST_APP, "README-cjdnw_bot.txt"),
    [
      "cjdnw_bot — isolated fork of Open-Agent-Bot / XinyunOpenBot",
      "",
      `Install dir: ${DEST_APP}`,
      `Data dir:    ${DATA_DIR}`,
      `Ports:       ${PORTS.join(", ")}`,
      "",
      "Do NOT use Desktop\\XinyunOpen-Bot-0.1.28 for this fork.",
      "That folder remains the upstream-branded install.",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log("launch…");
  spawn(newExe, [], {
    detached: true,
    stdio: "ignore",
    cwd: DEST_APP,
    env: {
      ...process.env,
      OMB_DATA_DIR: DATA_DIR,
      OMB_APP_NAME: APP_NAME,
    },
  }).unref();

  const health = await waitAnyHealth(PORTS, 80);
  if (!health) {
    console.error("HEALTH_FAIL — app launched but API not ready; open cjdnw_bot.lnk manually");
    process.exit(2);
  }
  console.log("HEALTH_OK", health);
  console.log("DONE", {
    exe: newExe,
    shortcut: join(DESKTOP, "cjdnw_bot.lnk"),
    data: DATA_DIR,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

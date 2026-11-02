#!/usr/bin/env node
/**
 * Local AI quota collector for XinyunOpen Bot (deterministic, no LLM).
 * Six pools: Codex, Claude, Cursor, Antigravity, Alibaba Bailian, Ninebot.
 * Never fabricates subscription remaining from token counts.
 * Never logs API keys / tokens / cookies.
 */
import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitize, assertNoSecrets } from "./lib/sanitize.mjs";

const REPORT_DIR = process.env.QUOTA_REPORT_DIR || join(homedir(), ".openmausbot", "quota-report");
const DATA_DIR = process.env.QUOTA_DATA_DIR || join(REPORT_DIR, "data");
const REPORTS_DIR = join(REPORT_DIR, "reports");
const LOG_DIR = join(REPORT_DIR, "logs");
const TASK_NAME = process.env.QUOTA_TASK_NAME || "XinyunOpen-QuotaDailyReport";
const TASK_DISPLAY_ZH = "每日 AI 模型额度汇报";
const CONFIG_PATH = join(homedir(), ".openmausbot", "config.json");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function appendLog(line) {
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(LOG_DIR, `collector-${day}.log`), `[${new Date().toISOString()}] ${scrubLog(line)}\n`, "utf8");
}

function scrubLog(text) {
  return String(text).replace(
    /\b(?:sk-[A-Za-z0-9_-]{8,}|ck-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gi,
    "[REDACTED]",
  );
}

async function fetchJson(url, headers, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw_kind: "non_json", length: text.length };
    }
    return { ok: res.ok, status: res.status, body: sanitize(body) };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function safe(fn, provider) {
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      appendLog(`${provider} failed: ${error?.message || error}`);
      return sanitize({
        provider,
        status: "adapter_error",
        remaining: null,
        remaining_kind: "n/a",
        error: String(error?.message || error).slice(0, 240),
        notes: "independent adapter failure; other providers continue",
      });
    });
}

async function collectCodex() {
  const authPath = join(homedir(), ".codex", "auth.json");
  const auth = readJson(authPath);
  const base = {
    provider: "codex",
    auth_present: Boolean(auth?.tokens?.access_token || auth?.OPENAI_API_KEY),
    auth_mode: typeof auth?.auth_mode === "string" ? auth.auth_mode : null,
    quota_kind: "subscription_window",
  };
  if (!auth?.tokens?.access_token) {
    return {
      ...base,
      status: auth?.OPENAI_API_KEY ? "api_key_only" : "unauthenticated",
      remaining: null,
      remaining_kind: "n/a",
      notes: "no ChatGPT session token; cannot read subscription window",
    };
  }
  const headers = {
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id || "",
    "content-type": "application/json",
  };
  const candidates = [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/usage",
  ];
  for (const url of candidates) {
    const r = await fetchJson(url, headers);
    if (!r.ok) continue;
    const b = r.body || {};
    const plan = b.plan_type || b.planType || b.subscription_plan || null;
    const rate = b.rate_limit || b.rateLimit || b["rate-limit"] || {};
    const primary = rate.primary_window || rate.primaryWindow || rate.window || {};
    const secondary = rate.secondary_window || rate.secondaryWindow || {};
    const used = primary.used_percent ?? primary.usedPercent ?? b.used_percent ?? null;
    const reset = primary.reset_after_seconds ?? primary.resetAfterSeconds ?? null;
    return sanitize({
      ...base,
      status: "ok",
      source: url.replace(/^https?:\/\//, ""),
      plan: typeof plan === "string" ? plan : null,
      used_percent: used == null ? null : Number(used),
      remaining_percent: used == null ? null : Math.max(0, Math.round((100 - Number(used)) * 10) / 10),
      remaining_kind: used == null ? "n/a" : "subscription_window_remaining_percent",
      reset_after_seconds: reset == null ? null : Number(reset),
      secondary_used_percent: secondary.used_percent ?? secondary.usedPercent ?? null,
      notes: "ChatGPT/Codex subscription window usage (not API prepaid balance)",
    });
  }
  return { ...base, status: "usage_unavailable", remaining: null, remaining_kind: "n/a" };
}

async function collectClaude() {
  const credPath = join(homedir(), ".claude", ".credentials.json");
  const cred = readJson(credPath);
  const oauth = cred?.claudeAiOauth || {};
  const token = oauth.accessToken || oauth.access_token;
  const base = {
    provider: "claude",
    auth_present: Boolean(token),
    quota_kind: "subscription_window",
  };
  if (!token) {
    return { ...base, status: "unauthenticated", remaining: null, remaining_kind: "n/a" };
  }
  const headers = {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "content-type": "application/json",
  };
  const candidates = [
    "https://api.anthropic.com/api/oauth/usage",
    "https://api.anthropic.com/api/oauth/claude_cli/usage",
  ];
  for (const url of candidates) {
    const r = await fetchJson(url, headers);
    if (!r.ok) continue;
    const b = r.body || {};
    const five = b.five_hour || b.fiveHour || {};
    const seven = b.seven_day || b.sevenDay || {};
    const used5 = five.utilization ?? five.used_percent ?? null;
    const used7 = seven.utilization ?? seven.used_percent ?? null;
    return sanitize({
      ...base,
      status: "ok",
      source: url.replace(/^https?:\/\//, ""),
      five_hour_used_percent: used5 == null ? null : Number(used5),
      five_hour_remaining_percent: used5 == null ? null : Math.max(0, Math.round((100 - Number(used5)) * 10) / 10),
      seven_day_used_percent: used7 == null ? null : Number(used7),
      seven_day_remaining_percent: used7 == null ? null : Math.max(0, Math.round((100 - Number(used7)) * 10) / 10),
      remaining_kind: "subscription_window_remaining_percent",
      notes: "Claude subscription utilization windows (not API prepaid balance)",
    });
  }
  return { ...base, status: "usage_unavailable", remaining: null, remaining_kind: "n/a" };
}

function collectCursor() {
  const versionsRoot = join(homedir(), "AppData", "Local", "cursor-agent", "versions");
  let cliPresent = false;
  let version = null;
  if (existsSync(versionsRoot)) {
    try {
      const dirs = readdirSync(versionsRoot).filter((n) => !n.startsWith("."));
      cliPresent = dirs.length > 0;
      version = dirs.sort().at(-1) || null;
    } catch {
      cliPresent = false;
    }
  }
  const which = spawnSync("where.exe", ["cursor-agent"], { encoding: "utf8" });
  const pathLine = (which.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  const authHints = {
    cursor_dir: existsSync(join(homedir(), ".cursor")),
    mcp_json: existsSync(join(homedir(), ".cursor", "mcp.json")),
    cli_config: existsSync(join(homedir(), ".cursor", "cli-config.json")),
  };
  return sanitize({
    provider: "cursor",
    auth_present: Boolean(pathLine) || cliPresent || authHints.cursor_dir,
    status: pathLine || cliPresent ? "local_signals_only" : "missing",
    cli_path_present: Boolean(pathLine) || cliPresent,
    version,
    signals: authHints,
    remaining: null,
    remaining_kind: "n/a",
    quota_kind: "unknown",
    notes: "No reliable authorized remaining-quota API used; local CLI/config presence only. Not inferred from tokens.",
  });
}

function collectAntigravity() {
  const configured = "C:\\Users\\runhe.gan\\Desktop\\gemini\\agy.exe";
  const candidates = [];
  if (existsSync(configured)) candidates.push(configured);
  const which = spawnSync("where.exe", ["agy"], { encoding: "utf8" });
  for (const line of (which.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!candidates.includes(line)) candidates.push(line);
  }
  const pathLine = candidates[0] || null;
  let version = null;
  if (pathLine) {
    const v = spawnSync(pathLine, ["--version"], { encoding: "utf8", timeout: 8000 });
    version = ((v.stdout || v.stderr || "").trim().split(/\r?\n/)[0] || null);
  }
  return sanitize({
    provider: "antigravity",
    auth_present: Boolean(pathLine),
    status: pathLine ? "local_signals_only" : "missing",
    cli_path_present: Boolean(pathLine),
    version,
    remaining: null,
    remaining_kind: "n/a",
    quota_kind: "unknown",
    notes: "agy has no stable public remaining-quota API in this collector; CLI presence only",
  });
}

function instanceEnvKey(instanceId, envName) {
  const cfg = readJson(CONFIG_PATH);
  const inst = cfg?.instances?.[instanceId];
  const env = inst?.environment || {};
  const val = env[envName];
  return typeof val === "string" && val.length > 0;
}

function instanceUrl(instanceId) {
  const cfg = readJson(CONFIG_PATH);
  return cfg?.instances?.[instanceId]?.config?.url || null;
}

async function collectOpenAiCompatible({ provider, instanceId, envName, label }) {
  const url = instanceUrl(instanceId);
  const hasKey = instanceEnvKey(instanceId, envName);
  const base = {
    provider,
    label,
    auth_present: hasKey,
    endpoint_configured: Boolean(url),
    quota_kind: "api_balance_or_prepaid",
  };
  if (!hasKey || !url) {
    return {
      ...base,
      status: !hasKey ? "unauthenticated" : "misconfigured",
      remaining: null,
      remaining_kind: "n/a",
      notes: "API key/url from local Xinyun config; no remaining-quota field without a provider billing API",
    };
  }
  // models list is typically free / not a paid completion; used only as connectivity probe
  const cfg = readJson(CONFIG_PATH);
  const apiKey = cfg?.instances?.[instanceId]?.environment?.[envName];
  const modelsUrl = String(url).replace(/\/$/, "") + "/models";
  const r = await fetchJson(
    modelsUrl,
    { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    12000,
  );
  const modelCount = Array.isArray(r.body?.data) ? r.body.data.length : null;
  return sanitize({
    ...base,
    status: r.ok ? "reachable_no_remaining_api" : "probe_failed",
    http_status: r.status || null,
    models_visible: modelCount,
    remaining: null,
    remaining_kind: "n/a",
    source: modelsUrl.replace(/^https?:\/\//, "").replace(/\/models$/, "/*"),
    notes: "OpenAI-compatible endpoint reachable check only. Remaining prepaid/API balance is N/A (no authorized billing API).",
    error: r.ok ? undefined : r.error || `HTTP ${r.status}`,
  });
}

function queryTask(name) {
  // Prefer PowerShell CIM info — schtasks LIST/V on zh-CN consoles is often GBK and
  // loses field labels when decoded as UTF-8.
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$t=Get-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if(-not $t){ Write-Output '{"ok":false}'; exit 0 }; $i=Get-ScheduledTaskInfo -TaskName '${name.replace(/'/g, "''")}'; $a=$t.Actions | Select-Object -First 1; (@{ok=$true;status=[string]$t.State;next_run=($i.NextRunTime.ToString('s'));last_run=($i.LastRunTime.ToString('s'));last_result=$i.LastTaskResult;task_to_run=([string]$a.Execute+' '+[string]$a.Arguments).Trim();start_time='20:00:00'} | ConvertTo-Json -Compress)`,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  try {
    const body = JSON.parse((ps.stdout || "").trim() || '{"ok":false}');
    return {
      name,
      ok: Boolean(body.ok),
      status: body.status || (body.ok ? "Ready" : "Missing"),
      next_run: body.next_run || null,
      last_run: body.last_run || null,
      last_result: body.last_result == null ? null : String(body.last_result),
      start_time: body.start_time || null,
      task_to_run: body.task_to_run || null,
      raw_ok: Boolean(body.ok),
    };
  } catch {
    return {
      name,
      ok: false,
      status: "Missing",
      next_run: null,
      last_run: null,
      last_result: null,
      start_time: null,
      task_to_run: null,
      raw_ok: false,
    };
  }
}

function collectScheduleStatus() {
  // Prefer schtasks by ASCII name; also detect via PowerShell runner match for resilience.
  const primary = queryTask(TASK_NAME);
  let installed = Boolean(primary.ok);
  let status = primary.status;
  let next = primary.next_run;
  let last = primary.last_run;
  let lastResult = primary.last_result;
  let start = primary.start_time;
  let taskToRun = primary.task_to_run;
  if (!installed) {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-ScheduledTask | Where-Object { (($_.Actions | ForEach-Object Arguments) -join ' ') -match 'quota-report\\\\run-daily\\.mjs' } | Measure-Object).Count",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    const count = Number((ps.stdout || "").trim());
    if (Number.isFinite(count) && count > 0) {
      installed = true;
      status = status === "Missing" ? "Ready" : status;
    }
  }
  return sanitize({
    task_name: TASK_NAME,
    display_name_zh: TASK_DISPLAY_ZH,
    installed,
    status,
    next_run: next,
    last_run: last,
    last_result: lastResult,
    start_time: start,
    task_to_run: taskToRun,
    queried_at: new Date().toISOString(),
  });
}

function ymdShanghai(d = new Date()) {
  // Asia/Shanghai calendar day for report filename
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}

function writeMarkdown(snapshot) {
  const day = ymdShanghai(new Date(snapshot.collected_at));
  const compact = day.replace(/-/g, "");
  const path = join(REPORTS_DIR, `daily-quota-${compact}.md`);
  const alias = join(REPORTS_DIR, `${day}.md`);
  const lines = [
    `# AI 额度日报 ${day}`,
    "",
    `采集时间：${snapshot.collected_at}`,
    `时区：Asia/Shanghai`,
    `投递：本地文件（Xinyun 无独立推送 API；见 status 字段）`,
    "",
    "## 提供商",
    "",
  ];
  for (const p of snapshot.providers || []) {
    lines.push(`### ${p.provider}${p.label ? ` (${p.label})` : ""}`);
    lines.push(`- status: ${p.status}`);
    lines.push(`- remaining_kind: ${p.remaining_kind ?? "n/a"}`);
    if (p.remaining_percent != null) lines.push(`- remaining_percent: ${p.remaining_percent}`);
    if (p.five_hour_remaining_percent != null) {
      lines.push(`- five_hour_remaining_percent: ${p.five_hour_remaining_percent}`);
    }
    if (p.seven_day_remaining_percent != null) {
      lines.push(`- seven_day_remaining_percent: ${p.seven_day_remaining_percent}`);
    }
    if (p.notes) lines.push(`- notes: ${p.notes}`);
    lines.push("```json");
    lines.push(JSON.stringify(p, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## 定时任务");
  lines.push("```json");
  lines.push(JSON.stringify(snapshot.schedule || {}, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## 投递状态");
  lines.push("```json");
  lines.push(JSON.stringify(snapshot.delivery || {}, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("_本报告不含 API Key / Token / Cookie。_");
  const body = lines.join("\n");
  writeFileSync(path, body, "utf8");
  writeFileSync(alias, body, "utf8");
  return path;
}

function tryToast(reportPath) {
  try {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('额度日报已写入:\\n${reportPath.replace(/'/g, "''")}', 'XinyunOpen Quota', 'OK', 'Information') | Out-Null
`;
    // Non-blocking toast alternative: balloon via PowerShell if available; avoid modal MessageBox in scheduled runs.
    const balloon = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
`;
    // Prefer writing a .done marker; optional notify via msg.exe to current user session is too noisy.
    writeFileSync(join(DATA_DIR, "last-delivery.json"), JSON.stringify({
      at: new Date().toISOString(),
      reportPath,
      method: "local_file",
    }, null, 2));
    void ps;
    void balloon;
    return { ok: true, method: "local_file", reportPath };
  } catch (error) {
    return { ok: false, method: "local_file", error: String(error?.message || error) };
  }
}

export async function collectOnce() {
  const providers = await Promise.all([
    safe(collectCodex, "codex"),
    safe(collectClaude, "claude"),
    safe(() => collectCursor(), "cursor"),
    safe(() => collectAntigravity(), "antigravity"),
    safe(
      () =>
        collectOpenAiCompatible({
          provider: "deepseek-aliyun",
          instanceId: "deepseek-aliyun",
          envName: "BAILIAN_API_KEY",
          label: "Alibaba Bailian",
        }),
      "deepseek-aliyun",
    ),
    safe(
      () =>
        collectOpenAiCompatible({
          provider: "ninebot",
          instanceId: "ninebot",
          envName: "SEGWAY_API_KEY",
          label: "Ninebot",
        }),
      "ninebot",
    ),
  ]);
  const schedule = collectScheduleStatus();
  const snapshotBase = {
    schema: "xinyun.quota.snapshot.v2",
    collected_at: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    host: "localhost-only",
    providers,
    schedule,
    security: {
      secrets_exported: false,
      transport: "local files",
      network_bind: "none",
    },
  };
  const reportPath = writeMarkdown({ ...snapshotBase, delivery: { pending: true } });
  const delivery = {
    ...tryToast(reportPath),
    xinyun_push: "unavailable",
    reason: "no verified Xinyun notification push API; persisted local markdown report",
  };
  const snapshot = sanitize({ ...snapshotBase, delivery });
  assertNoSecrets(snapshot, "snapshot");

  const snapshotPath = join(DATA_DIR, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  appendFileSync(join(DATA_DIR, "history.jsonl"), JSON.stringify(snapshot) + "\n", "utf8");
  writeFileSync(join(DATA_DIR, "schedule-status.json"), JSON.stringify(schedule, null, 2), "utf8");
  // rewrite markdown with final delivery block
  writeMarkdown(snapshot);
  appendLog(`collectOnce ok report=${reportPath}`);
  return { snapshot, snapshotPath, reportPath, schedule, delivery };
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  collectOnce()
    .then((r) => {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            snapshotPath: r.snapshotPath,
            reportPath: r.reportPath,
            delivery: r.delivery,
            providers: r.snapshot.providers.map((p) => ({
              provider: p.provider,
              status: p.status,
              remaining_kind: p.remaining_kind,
            })),
          },
          null,
          2,
        ) + "\n",
      );
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

/**
 * Lightweight Antigravity one-shot classifier for the Gate bot.
 * Uses agy print mode with gemini-3.8-flash-low (light) — no F_final chain.
 */
import { spawnCli, killCliTree } from "../../procs.ts";
import { augmentedPath } from "../../env-path.ts";
import { AI_GATE_SYSTEM_PROMPT, buildAiGateUserPrompt } from "./prompt.ts";
import { parseAndValidateGateJson } from "./schema.ts";
import {
  AI_GATE_MODEL_ID,
  gateConfig,
  type AiGateClassification,
  type GateFailureReason,
  type MessageContext,
} from "./types.ts";

export interface GeminiClassifyOk {
  ok: true;
  classification: AiGateClassification;
  rawText: string;
  modelId: string;
  elapsedMs: number;
  upgraded: boolean;
}

export interface GeminiClassifyErr {
  ok: false;
  failure: GateFailureReason;
  detail: string;
  rawText?: string;
  modelId: string;
  elapsedMs: number;
}

export type GeminiClassifyResult = GeminiClassifyOk | GeminiClassifyErr;

function classifySpawnFailure(message: string): GateFailureReason {
  const m = message.toLowerCase();
  if (/enoent|not found|is not recognized|spawn/i.test(m)) return "MODEL_UNAVAILABLE";
  if (/auth|login|unauthorized|401|403/i.test(m)) return "AUTH_ERROR";
  if (/quota|rate.?limit|resource.?exhausted|429/i.test(m)) return "QUOTA_EXHAUSTED";
  if (/timeout|etimedout|econnreset|network|enotfound|eai_again/i.test(m)) {
    return /timeout|etimedout/.test(m) ? "TIMEOUT" : "NETWORK_ERROR";
  }
  return "UNKNOWN_ERROR";
}

/**
 * Probe whether agy lists the configured Gate model. Best-effort; failures → unavailable.
 */
export async function probeAiGateModel(
  cli = gateConfig().cli,
  modelId = gateConfig().modelId,
  timeoutMs = 8_000,
): Promise<{ available: boolean; detail: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawnCli(cli, ["models"], {
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const finish = (available: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        killCliTree(child);
      } catch {
        /* ignore */
      }
      resolve({ available, detail });
    };
    const timer = setTimeout(() => finish(false, "agy models timeout"), timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      out += c;
    });
    child.stderr?.on("data", (c: string | Buffer) => {
      err += String(c);
    });
    child.on("error", (e) => finish(false, e.message));
    child.on("close", (code) => {
      const blob = `${out}\n${err}`;
      if (code !== 0 && !blob.includes(modelId)) {
        finish(false, `agy models exit ${code}: ${err.slice(-200)}`);
        return;
      }
      finish(blob.includes(modelId), blob.includes(modelId) ? `model listed: ${modelId}` : `model missing: ${modelId}`);
    });
  });
}

export async function classifyWithGeminiFlash(
  userRequest: string,
  history?: MessageContext[],
  opts?: { timeoutMs?: number; modelId?: string; cli?: string },
): Promise<GeminiClassifyResult> {
  const cfg = gateConfig();
  const modelId = opts?.modelId || cfg.modelId || AI_GATE_MODEL_ID;
  const cli = opts?.cli || cfg.cli;
  const timeoutMs = opts?.timeoutMs ?? cfg.timeoutMs;
  const started = Date.now();

  const userPrompt = buildAiGateUserPrompt(userRequest, history);
  // System + user as single argv print prompt (agy print mode does not use stdin).
  const prompt = `${AI_GATE_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  if (Buffer.byteLength(prompt) > 200 * 1024) {
    return {
      ok: false,
      failure: "UNKNOWN_ERROR",
      detail: "gate prompt too large",
      modelId,
      elapsedMs: Date.now() - started,
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let responseText = "";
    let stderr = "";
    let sawResult = false;

    const finish = (result: GeminiClassifyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        killCliTree(child);
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    // Use `--print=<prompt>` form so later flags are not swallowed as the prompt
    // (agy rejects `--print --output-format ...` with a clear error).
    // `--mode plan` avoids tool execution; Gate must never act on user tasks.
    const args = [
      `--print=${prompt}`,
      "--output-format",
      "stream-json",
      "--print-timeout",
      `${Math.max(3, Math.ceil(timeoutMs / 1000))}s`,
      "--model",
      modelId,
      "--mode",
      "plan",
    ];

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, args, {
        env: { ...process.env, PATH: augmentedPath() },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish({
        ok: false,
        failure: "MODEL_UNAVAILABLE",
        detail: e instanceof Error ? e.message : String(e),
        modelId,
        elapsedMs: Date.now() - started,
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        failure: "TIMEOUT",
        detail: `AI Gate timed out after ${timeoutMs}ms`,
        rawText: responseText.slice(0, 2000),
        modelId,
        elapsedMs: Date.now() - started,
      });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (e) => {
      finish({
        ok: false,
        failure: classifySpawnFailure(e.message),
        detail: e.message,
        modelId,
        elapsedMs: Date.now() - started,
      });
    });

    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.event === "result") {
            sawResult = true;
            const payload = o.result ?? o[o.event] ?? {};
            responseText = typeof payload.response === "string" ? payload.response : "";
            const status = String(payload.status || "");
            if (/quota|resource.?exhausted/i.test(status + responseText)) {
              finish({
                ok: false,
                failure: "QUOTA_EXHAUSTED",
                detail: status || "quota exhausted",
                rawText: responseText,
                modelId,
                elapsedMs: Date.now() - started,
              });
              return;
            }
            if (status && status !== "SUCCESS") {
              const failure = classifySpawnFailure(status + " " + responseText);
              finish({
                ok: false,
                failure,
                detail: status,
                rawText: responseText,
                modelId,
                elapsedMs: Date.now() - started,
              });
              return;
            }
            const parsed = parseAndValidateGateJson(responseText);
            if (!parsed.ok) {
              finish({
                ok: false,
                failure: parsed.error,
                detail: parsed.detail,
                rawText: responseText,
                modelId,
                elapsedMs: Date.now() - started,
              });
              return;
            }
            finish({
              ok: true,
              classification: parsed.value,
              rawText: responseText,
              modelId,
              elapsedMs: Date.now() - started,
              upgraded: parsed.upgraded,
            });
          }
        } catch {
          /* ignore non-json lines */
        }
      }
    });

    child.stderr?.on("data", (c: string | Buffer) => {
      stderr += String(c);
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
      if (/quota|resource.?exhausted|rate.?limit/i.test(stderr)) {
        finish({
          ok: false,
          failure: "QUOTA_EXHAUSTED",
          detail: stderr.slice(-300),
          modelId,
          elapsedMs: Date.now() - started,
        });
      } else if (/auth|login required|unauthorized/i.test(stderr)) {
        finish({
          ok: false,
          failure: "AUTH_ERROR",
          detail: stderr.slice(-300),
          modelId,
          elapsedMs: Date.now() - started,
        });
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      if (!sawResult) {
        finish({
          ok: false,
          failure: classifySpawnFailure(stderr || `exit ${code}`),
          detail: `agy exited ${code} before result${stderr ? `: ${stderr.slice(-200)}` : ""}`,
          rawText: responseText,
          modelId,
          elapsedMs: Date.now() - started,
        });
      }
    });
  });
}

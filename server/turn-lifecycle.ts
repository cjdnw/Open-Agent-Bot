/**
 * Logical Turn lifecycle for Open-Agent-Bot.
 *
 * Separates a user/bot logical task from a provider Attempt. Fallback may
 * spawn many Attempts under one LogicalTurn; ask_bot waits for the logical
 * task, not a single failed attempt. Stale provider events after cancel /
 * timeout / generation bump are ignored.
 */
import type { RuntimeEvent } from "./contracts.ts";

export type LogicalTurnState =
  | "running"
  | "switching"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface AttemptRecord {
  attemptId: string;
  providerInstanceId: string;
  providerTurnId?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  error?: string;
}

export interface LogicalTurn {
  logicalTurnId: string;
  botId: string;
  threadId: string;
  generation: number;
  state: LogicalTurnState;
  attempts: AttemptRecord[];
  activeAttemptId: string | null;
  hadSideEffects: boolean;
  userAbort: boolean;
  finalText: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TurnOutcome {
  ok: boolean;
  error?: string;
  hadSideEffects: boolean;
  userAbort: boolean;
  logicalTurnId: string;
  text?: string;
}

type BusSubscribe = (listener: (event: RuntimeEvent) => void) => () => void;

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export class TurnLifecycle {
  /** threadId → active logical turn */
  private readonly byThread = new Map<string, LogicalTurn>();
  /** generation counters so late events from a killed attempt cannot finish a new turn */
  private readonly generation = new Map<string, number>();

  get(threadId: string): LogicalTurn | undefined {
    return this.byThread.get(threadId);
  }

  isBusy(threadId: string): boolean {
    const t = this.byThread.get(threadId);
    return Boolean(t && (t.state === "running" || t.state === "switching" || t.state === "paused"));
  }

  begin(botId: string, threadId: string): LogicalTurn {
    const gen = (this.generation.get(threadId) ?? 0) + 1;
    this.generation.set(threadId, gen);
    const turn: LogicalTurn = {
      logicalTurnId: newId("lt"),
      botId,
      threadId,
      generation: gen,
      state: "running",
      attempts: [],
      activeAttemptId: null,
      hadSideEffects: false,
      userAbort: false,
      finalText: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byThread.set(threadId, turn);
    return turn;
  }

  beginAttempt(
    threadId: string,
    providerInstanceId: string,
    model?: string,
  ): AttemptRecord | null {
    const turn = this.byThread.get(threadId);
    if (!turn || turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled") {
      return null;
    }
    const attempt: AttemptRecord = {
      attemptId: newId("at"),
      providerInstanceId,
      model,
      startedAt: Date.now(),
    };
    turn.attempts.push(attempt);
    turn.activeAttemptId = attempt.attemptId;
    turn.state = turn.attempts.length > 1 ? "switching" : "running";
    turn.updatedAt = Date.now();
    return attempt;
  }

  bindProviderTurn(threadId: string, providerTurnId: string | undefined): void {
    const turn = this.byThread.get(threadId);
    if (!turn?.activeAttemptId || !providerTurnId) return;
    const attempt = turn.attempts.find((a) => a.attemptId === turn.activeAttemptId);
    if (attempt && !attempt.providerTurnId) attempt.providerTurnId = providerTurnId;
  }

  markSideEffects(threadId: string): void {
    const turn = this.byThread.get(threadId);
    if (turn) {
      turn.hadSideEffects = true;
      turn.updatedAt = Date.now();
    }
  }

  appendAssistantText(threadId: string, text: string): void {
    const turn = this.byThread.get(threadId);
    if (!turn || !text) return;
    turn.finalText = turn.finalText ? `${turn.finalText}\n${text}` : text;
    turn.updatedAt = Date.now();
  }

  /**
   * Record that the active provider attempt finished. Does NOT close the
   * logical turn when the orchestrator still intends to Fallback.
   */
  finishAttempt(
    threadId: string,
    result: { ok: boolean; error?: string; userAbort?: boolean; providerTurnId?: string },
  ): AttemptRecord | null {
    const turn = this.byThread.get(threadId);
    if (!turn?.activeAttemptId) return null;
    const attempt = turn.attempts.find((a) => a.attemptId === turn.activeAttemptId);
    if (!attempt) return null;
    if (result.providerTurnId) attempt.providerTurnId = result.providerTurnId;
    attempt.ok = result.ok;
    attempt.error = result.error;
    attempt.endedAt = Date.now();
    if (result.userAbort) turn.userAbort = true;
    if (!result.ok && result.error) turn.error = result.error;
    turn.updatedAt = Date.now();
    return attempt;
  }

  completeLogical(threadId: string, ok: boolean, error?: string): LogicalTurn | undefined {
    const turn = this.byThread.get(threadId);
    if (!turn) return undefined;
    if (turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled") return turn;
    turn.state = turn.userAbort ? "cancelled" : ok ? "completed" : "failed";
    if (error) turn.error = error;
    turn.activeAttemptId = null;
    turn.updatedAt = Date.now();
    // Bump generation so any late provider events are ignored.
    this.generation.set(threadId, turn.generation + 1);
    return turn;
  }

  /** Drop the active logical turn after the orchestrator has released busy. */
  release(threadId: string): void {
    this.byThread.delete(threadId);
  }

  /** True when an event belongs to the current generation / active attempt. */
  acceptsEvent(threadId: string, event: RuntimeEvent): boolean {
    const turn = this.byThread.get(threadId);
    if (!turn) return false;
    if (turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled") return false;
    const gen = this.generation.get(threadId) ?? 0;
    if (turn.generation !== gen) return false;
    const attempt = turn.attempts.find((a) => a.attemptId === turn.activeAttemptId);
    if (event.turnId && attempt?.providerTurnId && event.turnId !== attempt.providerTurnId) {
      // Different provider turn id → stale attempt (e.g. after interrupt).
      return false;
    }
    return true;
  }

  /**
   * Wait until the active provider attempt emits turn.completed (or fatal
   * runtime.error / timeout). Filters by generation + optional provider turn id.
   */
  waitForActiveAttempt(
    subscribe: BusSubscribe,
    threadId: string,
    opts?: { timeoutMs?: number; onTimeout?: () => void | Promise<void> },
  ): Promise<TurnOutcome> {
    // Idle timeout: resets whenever the agent is still producing tools/text.
    // Agentic Claude/Codex turns commonly exceed a fixed 4-minute wall clock.
    const timeoutMs = opts?.timeoutMs ?? 20 * 60_000;
    const turn = this.byThread.get(threadId);
    if (!turn) {
      return Promise.resolve({
        ok: false,
        error: "no active logical turn",
        hadSideEffects: false,
        userAbort: false,
        logicalTurnId: "",
      });
    }
    const logicalTurnId = turn.logicalTurnId;
    const expectedGen = turn.generation;
    const expectedAttemptId = turn.activeAttemptId;

    return new Promise((resolve) => {
      let done = false;
      let errorMsg = "";
      let userAbort = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsub();
        const latest = this.byThread.get(threadId);
        this.finishAttempt(threadId, {
          ok,
          error: errorMsg || undefined,
          userAbort,
        });
        resolve({
          ok,
          error: errorMsg || undefined,
          hadSideEffects: Boolean(latest?.hadSideEffects),
          userAbort,
          logicalTurnId,
          text: latest?.finalText,
        });
      };
      const armTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void (async () => {
            if (!errorMsg) errorMsg = "turn timed out waiting for completion";
            try {
              await opts?.onTimeout?.();
            } catch {
              /* interrupt best-effort */
            }
            finish(false);
          })();
        }, timeoutMs);
      };
      const unsub = subscribe((e: RuntimeEvent) => {
        if (e.threadId !== threadId) return;
        const latest = this.byThread.get(threadId);
        if (!latest || latest.generation !== expectedGen) return;
        if (expectedAttemptId && latest.activeAttemptId !== expectedAttemptId) return;
        if (!this.acceptsEvent(threadId, e)) return;

        if (e.type === "turn.started" && e.turnId) {
          this.bindProviderTurn(threadId, e.turnId);
          armTimer();
        } else if (e.type === "runtime.error") {
          errorMsg = e.message || errorMsg;
          if (/aborted|interrupted|cancelled|canceled|stopped by user/i.test(e.message)) userAbort = true;
          if (
            /exited \d+|spawn_error|exit_before_result|rmcp::transport|worker quit with fatal|transport/i.test(
              e.message,
            )
          ) {
            finish(false);
          }
        } else if (e.type === "item.completed" && e.itemType === "tool" && e.ok) {
          this.markSideEffects(threadId);
          armTimer();
        } else if (e.type === "item.completed" && e.itemType === "assistant_text") {
          this.appendAssistantText(threadId, e.text);
          armTimer();
        } else if (e.type === "item.started" || e.type === "content.delta") {
          armTimer();
        } else if (e.type === "turn.completed") {
          if (e.ok === false && !errorMsg) errorMsg = e.stopReason || "turn failed";
          if (e.stopReason && /abort|interrupt|cancel/i.test(e.stopReason)) userAbort = true;
          finish(e.ok !== false && !errorMsg);
        }
      });
      armTimer();
    });
  }

  /** Snapshot of stuck turns for boot recovery. */
  listActive(): LogicalTurn[] {
    return [...this.byThread.values()].filter((t) =>
      t.state === "running" || t.state === "switching" || t.state === "paused",
    );
  }
}

export const turnLifecycle = new TurnLifecycle();

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

export type CheckpointSaverType = BaseCheckpointSaver;

function sanitizeSecretFields(obj: unknown, depth = 0): unknown {
  if (depth > 8 || !obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitizeSecretFields(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("password") ||
      lower.includes("apikey") ||
      lower.includes("api_key") ||
      lower.includes("authorization")
    ) {
      result[k] = "[REDACTED_BY_CHECKPOINTER]";
    } else {
      result[k] = sanitizeSecretFields(v, depth + 1);
    }
  }
  return result;
}

export class FileCheckpointSaver extends MemorySaver {
  public readonly storageDir: string;

  constructor(storageDir: string) {
    super();
    this.storageDir = storageDir;
    mkdirSync(this.storageDir, { recursive: true });
    this.hydrateFromDisk();
  }

  private hydrateFromDisk(): void {
    if (!existsSync(this.storageDir)) return;
    try {
      const threadDirs = readdirSync(this.storageDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const threadId of threadDirs) {
        const threadPath = join(this.storageDir, threadId);
        const files = readdirSync(threadPath);
        for (const file of files) {
          if (!file.endsWith(".json") || file.startsWith("writes_")) continue;
          try {
            const raw = readFileSync(join(threadPath, file), "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.checkpointId && parsed.checkpointData) {
              const ns = parsed.checkpointNs || "";
              if (!this.storage[threadId]) this.storage[threadId] = Object.create(null);
              if (!this.storage[threadId][ns]) this.storage[threadId][ns] = Object.create(null);

              const rawCheckpointBytes = new Uint8Array(Buffer.from(parsed.checkpointData, "base64"));
              const rawMetadataBytes = new Uint8Array(Buffer.from(parsed.metadataData, "base64"));

              this.storage[threadId][ns][parsed.checkpointId] = [
                rawCheckpointBytes,
                rawMetadataBytes,
                parsed.parentCheckpointId || undefined,
              ];
            }
          } catch {
            /* skip corrupt checkpoint file */
          }
        }
      }
    } catch {
      /* ignore read errors during init */
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: any,
    metadata: any,
  ): Promise<RunnableConfig> {
    const updatedConfig = await super.put(config, checkpoint, metadata);
    const threadId = config.configurable?.thread_id;
    if (!threadId) return updatedConfig;

    const checkpointNamespace = config.configurable?.checkpoint_ns || "";
    const threadDir = join(this.storageDir, String(threadId));
    mkdirSync(threadDir, { recursive: true });

    const safeCheckpoint = sanitizeSecretFields(checkpoint);
    const safeMetadata = sanitizeSecretFields(metadata);

    try {
      const [typedCheckpoint, typedMetadata] = await Promise.all([
        this.serde.dumpsTyped(safeCheckpoint),
        this.serde.dumpsTyped(safeMetadata),
      ]);

      const payload = {
        threadId,
        checkpointNs: checkpointNamespace,
        checkpointId: checkpoint.id,
        checkpointType: typedCheckpoint[0],
        checkpointData: Buffer.from(typedCheckpoint[1]).toString("base64"),
        metadataType: typedMetadata[0],
        metadataData: Buffer.from(typedMetadata[1]).toString("base64"),
        parentCheckpointId: config.configurable?.checkpoint_id,
        savedAt: Date.now(),
      };

      const filePath = join(threadDir, `${checkpoint.id}.json`);
      const tmpPath = `${filePath}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      writeFileSync(filePath, readFileSync(tmpPath, "utf8"), "utf8");
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
    } catch (err) {
      console.warn("Failed to write checkpoint to disk:", err);
    }

    return updatedConfig;
  }

  async putWrites(
    config: RunnableConfig,
    writes: any[],
    taskId: string,
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    const threadId = config.configurable?.thread_id;
    if (!threadId) return;

    const threadDir = join(this.storageDir, String(threadId));
    mkdirSync(threadDir, { recursive: true });

    const safeWrites = sanitizeSecretFields(writes);
    const filePath = join(threadDir, `writes_${taskId.replace(/[^\w-]/g, "_")}.json`);
    try {
      writeFileSync(filePath, JSON.stringify({ taskId, writes: safeWrites, at: Date.now() }, null, 2), "utf8");
    } catch (err) {
      console.warn("Failed to write pending writes to disk:", err);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    const threadDir = join(this.storageDir, String(threadId));
    if (existsSync(threadDir)) {
      try {
        rmSync(threadDir, { recursive: true, force: true });
      } catch (err) {
        console.warn("Failed to delete thread directory:", err);
      }
    }
  }

  listThreadIds(): string[] {
    return Object.keys(this.storage);
  }
}

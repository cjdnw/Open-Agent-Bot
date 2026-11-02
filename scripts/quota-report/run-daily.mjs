#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectOnce } from "./collector.mjs";

const logDir = join(homedir(), ".openmausbot", "quota-report", "logs");
mkdirSync(logDir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const logPath = join(logDir, `run-daily-${day}.log`);

function log(msg) {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

log("start");
collectOnce()
  .then((result) => {
    const summary = {
      ok: true,
      collected_at: result.snapshot.collected_at,
      snapshotPath: result.snapshotPath,
      reportPath: result.reportPath,
      schedule_installed: result.schedule.installed,
      delivery: result.delivery,
      providers: (result.snapshot.providers || []).map((p) => ({
        provider: p.provider,
        status: p.status,
        auth_present: p.auth_present,
        remaining_kind: p.remaining_kind,
      })),
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    log("ok " + JSON.stringify(summary));
  })
  .catch((error) => {
    console.error(error);
    log("fail " + String(error?.stack || error));
    process.exit(1);
  });

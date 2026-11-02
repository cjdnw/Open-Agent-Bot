#!/usr/bin/env node
/** Minimal Momo turn: only call list_bots; watch events for success. */
import { readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA = join(homedir(), ".openmausbot");
const raw = JSON.parse(readFileSync(join(DATA, "bots.json"), "utf8"));
const bots = Array.isArray(raw) ? raw : raw.bots || [];
const momo = bots.find((b) => b.name === "Momo");
if (!momo) throw new Error("Momo not found");
const eventsPath = join(DATA, "events", `${momo.threadId}.ndjson`);
const startSize = statSync(eventsPath).size;

const prompt =
  "【验收探针·勿扩展】只调用一次 list_bots（或 mcp__agents__list_bots），把工具返回的原文完整贴出后立刻结束。不要 Computer Use，不要 shell，不要 ask_bot，不要改任何配置。";

const res = await fetch(`http://127.0.0.1:8799/api/bots/${momo.id}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: prompt }),
});
if (!res.ok) throw new Error(`POST messages HTTP ${res.status} ${await res.text()}`);
console.log(JSON.stringify({ posted: true, botId: momo.id, threadId: momo.threadId, startSize }, null, 2));

const deadline = Date.now() + 180_000;
let offset = startSize;
const fd = openSync(eventsPath, "r");
let buf = Buffer.alloc(0);
const seen = [];
let listStarted = false;
let listOk = null;
let rejected = false;
let turnDone = false;
const listItemIds = new Set();

function consume(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) break;
    const line = buf.subarray(0, nl).toString("utf8");
    buf = buf.subarray(nl + 1);
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "item.started" && /list_bots/i.test(String(ev.title || ""))) {
      listStarted = true;
      if (ev.itemId) listItemIds.add(ev.itemId);
      seen.push({ t: ev.type, title: ev.title, itemId: ev.itemId });
    }
    if (ev.type === "item.completed" && ev.itemType === "tool" && listItemIds.has(ev.itemId)) {
      seen.push({ t: ev.type, ok: ev.ok, itemId: ev.itemId });
      listOk = ev.ok === true;
      if (ev.ok === false) rejected = true;
    }
    if (ev.type === "item.completed" && ev.itemType === "assistant_text") {
      const text = String(ev.text || "");
      if (/user rejected MCP tool call/i.test(text)) rejected = true;
      if (/\[id:/.test(text) || /Other bots you can message/i.test(text) || /Judge|Architect|Developer/.test(text)) {
        if (listOk == null) listOk = true;
      }
      seen.push({ t: "assistant", preview: text.slice(0, 240) });
    }
    if (ev.type === "turn.completed") {
      turnDone = true;
      seen.push({ t: "turn.completed", ok: ev.ok });
    }
  }
}

while (Date.now() < deadline && !turnDone) {
  const st = statSync(eventsPath);
  if (st.size > offset) {
    const len = st.size - offset;
    const chunk = Buffer.alloc(len);
    readSync(fd, chunk, 0, len, offset);
    offset = st.size;
    consume(chunk);
  } else {
    await new Promise((r) => setTimeout(r, 400));
  }
}
closeSync(fd);

const result = {
  listStarted,
  listOk,
  rejected,
  turnDone,
  seen: seen.slice(-20),
  pass: listStarted && listOk === true && !rejected,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 2);

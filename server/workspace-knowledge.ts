// Xinyun-unified workspace handbook: local skills catalog + server-210 memory rules.
// Injected into every bot turn so engines that are not Codex still see the same
// assignment. Keeps the prompt compact — points at files instead of dumping
// the full CODEX_MEMORY.md body.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_ROOTS = [
  { label: "Codex / agents skills", dir: join(homedir(), ".codex", "skills") },
  { label: "Agents skills mirror", dir: join(homedir(), ".agents", "skills") },
  { label: "Cursor built-in skills", dir: join(homedir(), ".cursor", "skills-cursor") },
];

const AGENTS_MD = join(homedir(), ".codex", "AGENTS.md");
const LOCAL_MEMORY = join(homedir(), ".codex", "CODEX_MEMORY.md");
const REMOTE_MEMORY = "/data/ganrh/CODEX_MEMORY.md";
const REMOTE_HOST = "ganrh@10.10.192.210";

let cached: { text: string; builtAt: number; stamp: string } | null = null;
const CACHE_MS = 60_000;

function listSkills(dir: string): Array<{ name: string; path: string; summary: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; path: string; summary: string }> = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const skillPath = join(dir, ent.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let summary = "";
    try {
      const head = readFileSync(skillPath, "utf8").slice(0, 1200);
      const desc = /(?:^|\n)(?:description|Description)\s*:\s*(.+)/.exec(head)?.[1]?.trim();
      const firstPara = head
        .replace(/^---[\s\S]*?---\s*/, "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#") && !l.startsWith("<!--"));
      summary = (desc || firstPara || "").slice(0, 140);
    } catch {
      summary = "";
    }
    out.push({ name: ent.name, path: skillPath, summary });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function stampRoots(): string {
  const parts: string[] = [];
  for (const root of SKILL_ROOTS) {
    try {
      parts.push(`${root.dir}:${statSync(root.dir).mtimeMs}`);
    } catch {
      parts.push(`${root.dir}:missing`);
    }
  }
  for (const f of [AGENTS_MD, LOCAL_MEMORY]) {
    try {
      parts.push(`${f}:${statSync(f).mtimeMs}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return parts.join("|");
}

function extractAgentsRules(): string {
  if (!existsSync(AGENTS_MD)) {
    return `- 210 = SSH ${REMOTE_HOST}; authoritative memory ${REMOTE_MEMORY}; local mirror ${LOCAL_MEMORY}.`;
  }
  try {
    const raw = readFileSync(AGENTS_MD, "utf8");
    // Keep the standing rules; trim very long files.
    return raw.trim().slice(0, 3500);
  } catch {
    return `- 210 = SSH ${REMOTE_HOST}; read ${LOCAL_MEMORY} after syncing from ${REMOTE_MEMORY}.`;
  }
}

/** Compact handbook shared by every Xinyun bot turn. */
export function workspaceKnowledgePrompt(): string {
  const stamp = stampRoots();
  const now = Date.now();
  if (cached && cached.stamp === stamp && now - cached.builtAt < CACHE_MS) return cached.text;

  const sections: string[] = [];
  sections.push(
    [
      "[Xinyun unified workspace assignment — applies to EVERY bot/engine in this app]",
      "You MUST follow these shared rules even if you are not Codex CLI.",
      "When a matching skill applies, open its SKILL.md and follow it before improvising.",
      "Do not pretend a skill ran if you did not read/follow it.",
    ].join("\n"),
  );

  sections.push(["## Standing workspace rules (from ~/.codex/AGENTS.md)", extractAgentsRules()].join("\n"));

  sections.push(
    [
      "## Server 210 knowledge base",
      `- Host: ${REMOTE_HOST}`,
      `- Authoritative: ${REMOTE_MEMORY}`,
      `- Local mirror: ${LOCAL_MEMORY} (${existsSync(LOCAL_MEMORY) ? "present" : "MISSING — sync before relying on it"})`,
      "- If the task mentions 210 / server210 / 知识库 / CODEX_MEMORY: sync remote→local first (scp/rsync), then read relevant sections of the local mirror before acting.",
      "- Default sync direction is remote→local. Never overwrite remote memory unless the user explicitly asks to save/update it.",
    ].join("\n"),
  );

  const seen = new Set<string>();
  for (const root of SKILL_ROOTS) {
    const skills = listSkills(root.dir).filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
    if (!skills.length) continue;
    const lines = skills.map((s) => `- ${s.name}: ${s.path}${s.summary ? ` — ${s.summary}` : ""}`);
    sections.push([`## ${root.label} (${skills.length})`, ...lines].join("\n"));
  }

  if (!seen.size) {
    sections.push("## Skills\n- No SKILL.md catalogs found under ~/.codex/skills, ~/.agents/skills, or ~/.cursor/skills-cursor.");
  }

  const text = sections.join("\n\n");
  cached = { text, builtAt: now, stamp };
  return text;
}

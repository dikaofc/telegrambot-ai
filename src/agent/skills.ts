import fs from "node:fs";
import path from "node:path";

export interface Skill { name: string; description: string; instructions: string; }

export function listSkills(skillsRoot = "skills"): Skill[] {
  const out: Skill[] = [];
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(skillsRoot, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(skillsRoot, d.name, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    try {
      const raw = fs.readFileSync(f, "utf8");
      const desc = (/description:\s*(.+)/i.exec(raw)?.[1] ?? d.name).trim();
      out.push({ name: d.name, description: desc, instructions: raw.slice(0, 4000) });
    } catch { /* skip */ }
  }
  return out;
}

const ROUTES: Array<{ re: RegExp; skill: string }> = [
  { re: /graph|knowledge graph|what connects|how.*relat|explain \w+|architecture/i, skill: "graphify" },
  { re: /debug|error|fail|crash|bug|leak|stack/i, skill: "debugging" },
  { re: /test|coverage|vitest|pytest/i, skill: "debugging" },
  { re: /git|commit|branch|merge|rebase|pr\b/i, skill: "git" },
  { re: /react|vue|css|tailwind|dark mode|frontend|component/i, skill: "frontend" },
  { re: /api|server|endpoint|auth|backend|database|sql/i, skill: "backend" },
  { re: /python|pip|django|fastapi/i, skill: "python" },
  { re: /node|npm|typescript|pnpm/i, skill: "node" },
  { re: /docker|container|compose|kubernetes/i, skill: "docker" },
];

export function pickSkill(input: string, skillsRoot = "skills"): Skill | null {
  for (const r of ROUTES) {
    if (r.re.test(input)) {
      const f = path.join(skillsRoot, r.skill, "SKILL.md");
      if (fs.existsSync(f)) {
        const raw = fs.readFileSync(f, "utf8");
        return { name: r.skill, description: r.skill, instructions: raw.slice(0, 4000) };
      }
    }
  }
  const coding = path.join(skillsRoot, "coding", "SKILL.md");
  if (fs.existsSync(coding)) {
    return { name: "coding", description: "general coding workflow", instructions: fs.readFileSync(coding, "utf8").slice(0, 4000) };
  }
  return null;
}

export function loadSkillPrompt(input: string, skillsRoot = "skills"): string {
  const s = pickSkill(input, skillsRoot);
  if (!s) return "";
  return `\nActive skill [${s.name}]: ${s.description}\n${s.instructions}\n`;
}

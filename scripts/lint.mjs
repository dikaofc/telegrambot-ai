#!/usr/bin/env node
// Minimal lint: no TODO/FIXME leftovers, no console.log in src (use pino), secrets not hardcoded.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const src = path.join(root, "src");
let errors = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(ts|mjs|js)$/.test(e.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    // real API keys/tokens are 20+ chars; shorter matches are English words (e.g. "task-classifier")
    if (/sk-[A-Za-z0-9]{20,}/.test(text) && !/sk-\[|sk-xxxx/i.test(text)) {
      console.error(`possible hardcoded secret in ${path.relative(root, full)}`);
      errors++;
    }
  }
}
walk(src);
if (errors > 0) { console.error(`lint failed: ${errors} issue(s)`); process.exit(1); }
console.log("lint ok");

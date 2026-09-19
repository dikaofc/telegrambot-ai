#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const dirs = ["data", "workspaces/default", "skills"];
for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
if (!fs.existsSync(path.join(root, ".env")) && fs.existsSync(path.join(root, ".env.example"))) {
  fs.copyFileSync(path.join(root, ".env.example"), path.join(root, ".env"));
  console.log("created .env from .env.example — fill in TELEGRAM_BOT_TOKEN and provider keys");
}
try {
  execSync("npm install", { stdio: "inherit", cwd: root });
} catch { /* deps may already be installed */ }
console.log("setup complete. Run: npm run dev");

import { RiskLevel } from "./risk.js";

const CRITICAL_PATTERNS = [
  /\brm\s+-rf\s+\/$/, /\brm\s+-rf\s+\/\s*$/, /mkfs/, /:KATEX_INLINE_OPEN\(\):KATEX_INLINE_CLOSE:/,
  /shutdown/, /reboot/, /halt/, /poweroff/, /iptables/, /ufw\s+(disable|reset)/,
  /useradd/, /userdel/, /passwd/, /\/etc\/shadow/, /\/etc\/passwd/,
  /dd\s+.*of=\/dev\//, /curl.*\|\s*(sh|bash)/,
];

const HIGH_PATTERNS = [
  /\brm\s+-rf\b/, /git\s+push/, /git\s+push\s+--force/, /docker\s+rm/, /docker\s+system\s+prune/,
  /kubectl\s+delete/, /DROP\s+TABLE/i, /DROP\s+DATABASE/i, /shutdown/i,
];

const MEDIUM_PATTERNS = [
  /npm\s+install/, /pnpm\s+add/, /yarn\s+add/, /pip\s+install/, /cargo\s+add/, /go\s+get/,
  /git\s+commit/, /git\s+checkout/, /git\s+reset/, /chmod\s+-R/, /chown/,
];

export interface CommandVerdict { risk: RiskLevel; reasons: string[]; normalized: string; }

export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

export function classifyCommand(raw: string): CommandVerdict {
  const normalized = normalizeCommand(raw);
  const reasons: string[] = [];
  for (const re of CRITICAL_PATTERNS) {
    if (re.test(normalized)) { reasons.push(`critical pattern: ${re.source}`); return { risk: RiskLevel.CRITICAL, reasons, normalized }; }
  }
  // host filesystem escape
  if (/\.\.\//.test(normalized) && /(etc|root|home)\//.test(normalized)) {
    reasons.push("host filesystem access outside workspace");
    return { risk: RiskLevel.CRITICAL, reasons, normalized };
  }
  for (const re of HIGH_PATTERNS) {
    if (re.test(normalized)) reasons.push(`high pattern: ${re.source}`);
  }
  if (reasons.length > 0) return { risk: RiskLevel.HIGH, reasons, normalized };
  for (const re of MEDIUM_PATTERNS) {
    if (re.test(normalized)) reasons.push(`medium pattern: ${re.source}`);
  }
  if (reasons.length > 0) return { risk: RiskLevel.MEDIUM, reasons, normalized };
  if (/^(ls|cat|head|tail|echo|pwd|whoami|git\s+(status|diff|log|branch)|npm\s+(test|run\s+\w+|ls)|node\s+--version)/.test(normalized)) {
    return { risk: RiskLevel.SAFE, reasons: ["read-only/safe command"], normalized };
  }
  return { risk: RiskLevel.LOW, reasons: ["default low-risk shell"], normalized };
}

export function isDestructiveCommand(raw: string): boolean {
  const v = classifyCommand(raw);
  return v.risk === RiskLevel.HIGH || v.risk === RiskLevel.CRITICAL;
}

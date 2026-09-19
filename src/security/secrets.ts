const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /api[_-]?key\s*[:=]\s*['"]?([^'"\s]+)/gi, label: "api_key" },
  { re: /token\s*[:=]\s*['"]?([^'"\s]+)/gi, label: "token" },
  { re: /password\s*[:=]\s*['"]?([^'"\s]+)/gi, label: "password" },
  { re: /secret\s*[:=]\s*['"]?([^'"\s]+)/gi, label: "secret" },
  { re: /sk-[A-Za-z0-9-_]{8,}/g, label: "token" },
  { re: /xox[bpas]-[A-Za-z0-9-_]+/g, label: "token" },
  { re: /ghp_[A-Za-z0-9]+/g, label: "token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: "private-key" },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, `${label}=********`);
  }
  return out;
}

const PROTECTED_PATHS = [".env", ".ssh", ".git/config", "credentials", ".npmrc", ".aws", "id_rsa", "id_ed25519", ".pypirc"];

export function isProtectedPath(p: string): boolean {
  const low = p.toLowerCase();
  return PROTECTED_PATHS.some((s) => low.includes(s));
}

export function stripSecretsFromContext(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    if (isProtectedPath(k)) {
      out[k] = "[protected: redacted by secret policy]";
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

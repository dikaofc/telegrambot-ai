export function truncateForTelegram(text: string, limit = 3500): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit - 200) + `\n…[truncated ${text.length - (limit - 200)} chars, full log attached]`, truncated: true };
}

export function progressBar(pct: number, width = 14): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function needsAttachment(text: string): boolean {
  return text.length > 3500;
}

export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    out.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  return out.slice(0, 10);
}

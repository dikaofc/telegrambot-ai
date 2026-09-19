import type { InlineKeyboardButton } from "grammy/types";

function btn(text: string, data: string): InlineKeyboardButton {
  return { text, callback_data: data };
}

export function runControlsKeyboard(runId: string): InlineKeyboardButton[][] {
  return [[btn("⏹ Stop", `run:stop:${runId}`), btn("⏸ Pause", `run:pause:${runId}`), btn("▶️ Resume", `run:resume:${runId}`)]];
}

export function approvalKeyboard(approvalId: string): InlineKeyboardButton[][] {
  return [[btn("✅ Approve", `appr:ok:${approvalId}`), btn("❌ Reject", `appr:no:${approvalId}`)]];
}

export function afterRunKeyboard(runId: string): InlineKeyboardButton[][] {
  return [
    [btn("📄 View Diff", `run:diff:${runId}`), btn("🧾 View Logs", `run:logs:${runId}`)],
    [btn("🔁 Retry", `run:retry:${runId}`)],
  ];
}

// Auto: only show relevant buttons — chat (no files) gets no diff/logs
export function afterRunKeyboardAuto(runId: string, o: { filesChanged: number; hasLogs?: boolean }): InlineKeyboardButton[][] | undefined {
  const hasChanges = o.filesChanged > 0;
  const hasLogs = o.hasLogs ?? hasChanges;
  if (!hasChanges && !hasLogs) return undefined; // pure chat → no buttons (clean)
  if (hasChanges) return afterRunKeyboard(runId);
  // edge: no files but has logs (rare) → only Retry + Logs
  return [[btn("🧾 View Logs", `run:logs:${runId}`), btn("🔁 Retry", `run:retry:${runId}`)]];
}

export function settingsKeyboard(): InlineKeyboardButton[][] {
  return [
    [btn("🤖 Model", "set:model"), btn("🔌 Provider", "set:provider")],
    [btn("📁 Workspace", "set:workspace"), btn("🛡 Permissions", "set:perms")],
    [btn("💾 Memory", "set:memory"), btn("🔔 Notifications", "set:notif")],
    [btn("👤 Access", "set:access"), btn("⚙️ Agent", "set:agent")],
  ];
}

export function providerKeyboard(providers: string[]): InlineKeyboardButton[][] {
  return providers.map((p) => [btn(p, `setp:${p}`)]);
}

export function setupKeyboard(): InlineKeyboardButton[][] {
  return [
    [btn("9Router", "setup:9router"), btn("OpenAI", "setup:openai")],
    [btn("xAI", "setup:xai"), btn("Ollama", "setup:ollama")],
    [btn("Custom /v1", "setup:custom")],
    [btn("✅ Test Connection", "setup:test")],
  ];
}

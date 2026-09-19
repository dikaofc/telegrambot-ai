import { getEnv, parseIdList } from "../config/env.js";

export type AccessMode = "owner" | "private" | "public" | "allowlist";

export function isAuthorized(userId: number | string, chatId?: number | string): { ok: boolean; reason: string } {
  const env = getEnv();
  const mode = env.BOT_ACCESS_MODE as AccessMode;
  const owners = parseIdList(env.OWNER_IDS).map(String);
  if (owners.includes(String(userId))) return { ok: true, reason: "owner" };
  switch (mode) {
    case "owner":
      return { ok: false, reason: "owner only mode" };
    case "private":
    case "allowlist": {
      const allowedUsers = parseIdList(env.ALLOWED_USER_IDS).map(String);
      const allowedChats = parseIdList(env.ALLOWED_CHAT_IDS).map(String);
      if (allowedUsers.includes(String(userId))) return { ok: true, reason: "allowlisted user" };
      if (chatId !== undefined && allowedChats.includes(String(chatId))) return { ok: true, reason: "allowlisted chat" };
      return { ok: false, reason: "not in allowlist" };
    }
    case "public":
      return { ok: true, reason: "public mode" };
  }
}

export function requireOwner(userId: number | string): void {
  const owners = parseIdList(getEnv().OWNER_IDS).map(String);
  if (!owners.includes(String(userId))) throw new Error("owner authorization required");
}

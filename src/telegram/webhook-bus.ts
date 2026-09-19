import type { Update } from "grammy/types";

/**
 * Small indirection between the API server and the bot process.
 *
 * The API owns the HTTP route (`POST /telegram/webhook`); the bot owns the
 * middleware stack. They live in different processes/entrypoints, so the bot
 * registers a handler here at startup and the route dispatches into it.
 * Keeping this separate means the api-only entrypoint never has to import
 * grammy, the tool registry, or the rest of the telegram stack.
 */
export type WebhookHandler = (update: Update) => Promise<void>;

let handler: WebhookHandler | null = null;

export function setWebhookHandler(next: WebhookHandler | null): void {
  handler = next;
}

export function webhookHandlerReady(): boolean {
  return handler !== null;
}

/** Returns false when no bot is attached (api-only process). */
export async function dispatchWebhookUpdate(update: Update): Promise<boolean> {
  if (!handler) return false;
  await handler(update);
  return true;
}

import { store } from "../database/store.js";

export function isDuplicateUpdate(updateId: string | number): boolean {
  return store.wasProcessed(String(updateId));
}

export function markUpdateProcessed(updateId: string | number): boolean {
  return store.markUpdate(String(updateId));
}

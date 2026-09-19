export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: never[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export async function aggregateEdits(edit: (text: string) => Promise<void>, ms = 1200): Promise<(text: string) => void> {
  let latest = "";
  let scheduled = false;
  return (text: string) => {
    latest = text;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void edit(latest).catch(() => undefined);
    }, ms);
  };
}

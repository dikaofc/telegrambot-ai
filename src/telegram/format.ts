/**
 * Telegram HTML formatting: auto markdown → HTML, blockquote, split.
 * Uses HTML parse_mode (supports <blockquote> since Bot API 7.3).
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Convert common markdown to Telegram HTML
export function mdToHtml(md: string): string {
  // Extract code blocks to placeholders
  const codeBlocks: string[] = [];
  let tmp = md.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    const idx = codeBlocks.length;
    const esc = escapeHtml(code.trimEnd());
    const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
    codeBlocks.push(`<pre><code${cls}>${esc}</code></pre>`);
    return `\uE000${idx}\uE001`;
  });
  // Inline code
  const inlineCodes: string[] = [];
  tmp = tmp.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\uE002${idx}\uE003`;
  });

  // Now escape remaining HTML (except placeholders)
  tmp = tmp.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Restore placeholders after escaping?
  // Placeholders use private use chars, so safe

  // Links [text](url)
  tmp = tmp.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, (_m, text: string, url: string) => {
    return `<a href="${escapeAttr(url)}">${text}</a>`;
  });

  // Bold **text** or __text__
  tmp = tmp.replace(/\*\*([^\*\n]+)\*\*/g, "<b>$1</b>");
  tmp = tmp.replace(/__([^_\n]+)__/g, "<i>$1</i>");
  // Single * italic (avoid **)
  tmp = tmp.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, "<i>$1</i>");
  // _italic_ (telegram html uses <i>)
  tmp = tmp.replace(/(?<!_)_\b([^_\n]+)_\b(?!_)/g, "<i>$1</i>");

  // Restore inline codes
  tmp = tmp.replace(/\uE002(\d+)\uE003/g, (_m, idx: string) => inlineCodes[Number(idx)] ?? "");
  // Blockquote lines: > text (group consecutive)
  const lines = tmp.split("\n");
  const out: string[] = [];
  let bqBuf: string[] = [];
  const flushBq = () => {
    if (bqBuf.length) {
      out.push(`<blockquote>${bqBuf.join("\n")}</blockquote>`);
      bqBuf = [];
    }
  };
  for (const line of lines) {
    const m = /^&gt;\s?(.*)/.exec(line); // &gt; because we escaped >
    if (m) bqBuf.push(m[1] ?? "");
    else {
      flushBq();
      out.push(line);
    }
  }
  flushBq();
  tmp = out.join("\n");

  // Restore code blocks
  tmp = tmp.replace(/\uE000(\d+)\uE001/g, (_m, idx: string) => codeBlocks[Number(idx)] ?? "");

  return tmp;
}

// Wrap plain summary in blockquote if not already has blockquote/pre/code
export function wrapBlockquoteIfNeeded(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) return html;
  if (/<blockquote|<pre|<code/.test(trimmed)) return html;
  // Also don't wrap if it's already rich HTML with many tags
  return `<blockquote>${trimmed}</blockquote>`;
}

export function splitHtml(html: string, limit = 3800): string[] {
  if (html.length <= limit) return [html];
  const chunks: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    // Prefer split at \n\n or \n near limit
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.6) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.6) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.6) cut = limit;
    // Avoid cutting inside tag: if we cut inside <...>, move cut to after >
    const snippet = rest.slice(0, cut);
    const openLt = snippet.lastIndexOf("<");
    const closeGt = snippet.lastIndexOf(">");
    if (openLt > closeGt) {
      const nextGt = rest.indexOf(">", cut);
      if (nextGt !== -1 && nextGt < cut + 200) cut = nextGt + 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.slice(0, 10);
}

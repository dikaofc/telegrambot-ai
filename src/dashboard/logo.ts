/** TeleAgent logo — neo-brutalist bot mark (red square, black border). */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="TeleAgent logo"><rect x="2" y="2" width="60" height="60" fill="#ff3b30" stroke="#0a0a0a" stroke-width="4"/><line x1="32" y1="10" x2="32" y2="18" stroke="#ffffff" stroke-width="4"/><circle cx="32" cy="8" r="3.5" fill="#ffffff" stroke="#0a0a0a" stroke-width="2"/><rect x="16" y="18" width="32" height="24" fill="#ffffff" stroke="#0a0a0a" stroke-width="4"/><rect x="22" y="25" width="6" height="9" fill="#0a0a0a"/><rect x="36" y="25" width="6" height="9" fill="#0a0a0a"/><rect x="22" y="46" width="20" height="5" fill="#0a0a0a"/></svg>`;

export function logoDataUri(): string {
  return "data:image/svg+xml," + encodeURIComponent(LOGO_SVG);
}

/* An HTML file previewed in a sandboxed iframe may run its own inline scripts and styles, but loads nothing from the
 * network: no beacons, no fetches carrying what it read from the page. A page's own CSP can only add to this one. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'unsafe-inline'";

/** the CSP meta comes first, after a doctype if there is one (before it, the page would render in quirks mode) */
export function withPreviewCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : `${meta}${html}`;
}

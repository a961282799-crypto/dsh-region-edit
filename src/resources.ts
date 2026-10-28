/**
 * Which local resources a static HTML preview embeds. The live preview (html-document.ts) and the
 * frozen history snapshot (history.ts) both follow these rules, so a record always holds every file
 * its comparison needs.
 */
export const PREVIEW_LIMITS = { files: 32, fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 } as const;
export const MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
};
/** Relative references only: no scheme, protocol-relative, root-absolute or fragment-only value. */
export function isLocalReference(value: string): boolean {
  return !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(value);
}
/** Resolve a reference against the file that contains it, dropping query and fragment. Leading ".." is kept. */
export function resolveReference(reference: string, base = ''): string {
  const parts: string[] = [];
  for (const part of (base.slice(0, base.lastIndexOf('/') + 1) + reference.split(/[?#]/)[0]!).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}
/** Lower-case extension of the path part, without query or fragment; empty when there is none. */
export function extensionOf(reference: string): string {
  return /\.([^./\\]+)$/.exec(reference.split(/[?#]/)[0]!)?.[1]?.toLowerCase() ?? '';
}
/** `<link rel="stylesheet" href="local.css">`. Link types are ASCII case-insensitive. */
export function isStylesheetLink(rel: string, href: string): boolean {
  return rel.toLowerCase().split(/\s+/).includes('stylesheet') && isLocalReference(href) && extensionOf(href) === 'css';
}
/** Media type for a local `<img src>`, or undefined when the preview does not embed it. */
export function imageSourceMime(src: string): string | undefined {
  const mime = isLocalReference(src) ? MIME_TYPES[extensionOf(src)] : undefined;
  return mime?.startsWith('image/') ? mime : undefined;
}
/** A CSS url() or @import target: a nested stylesheet, an embedded asset, or nothing to load. */
export function cssResource(url: string, imported: boolean): { kind: 'stylesheet' } | { kind: 'asset'; mime: string } | undefined {
  if (!isLocalReference(url)) return;
  const extension = extensionOf(url);
  if (imported || extension === 'css') return { kind: 'stylesheet' };
  const mime = MIME_TYPES[extension];
  return mime ? { kind: 'asset', mime } : undefined;
}

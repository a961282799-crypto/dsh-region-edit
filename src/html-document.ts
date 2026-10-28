import { randomToken } from './token.ts';
import { rewriteCssAssets } from './css-assets.ts';
import { annotateHtml } from './source-map.ts';
import { PREVIEW_LIMITS, cssResource, imageSourceMime, isLocalReference, isStylesheetLink, resolveReference } from './resources.ts';
import type { SourceIndex } from './source-map.ts';
export interface HtmlDocument { html: string; sources: SourceIndex }
export type AssetReader = (reference: string, signal: AbortSignal) => Promise<{ data: Uint8Array; resourceAddress?: string }>;
/** Builds a file preview in an opaque origin; only the picker bridge runs in static mode. */
export async function htmlDocument(source: string, picker: string, interactive: boolean, read: AssetReader, signal: AbortSignal): Promise<HtmlDocument> {
  const annotated = annotateHtml(source);
  const doc = new DOMParser().parseFromString(annotated.html, 'text/html');
  const nonce = randomToken();
  doc.querySelectorAll('base,meta[http-equiv],iframe,object,embed,portal').forEach(n => n.remove());
  if (!interactive) {
    doc.querySelectorAll('script,template').forEach(n => n.remove());
    for (const node of doc.querySelectorAll('*')) for (const a of [...node.attributes]) if (/^on/i.test(a.name)) node.removeAttribute(a.name);
  }
  doc.querySelectorAll('a,area').forEach(n => n.removeAttribute('href'));
  let bytes = 0, count = 0;
  const assets = new Map<string, Promise<Uint8Array>>();
  const readBounded = async (reference: string) => {
    signal.throwIfAborted();
    const cached = assets.get(reference); if (cached) return cached;
    if (++count > PREVIEW_LIMITS.files) throw new Error(`关联文件超过 ${PREVIEW_LIMITS.files} 个，请使用普通预览。`);
    const loading = read(reference, signal).then(asset => {
      bytes += asset.data.byteLength;
      if (asset.data.byteLength > PREVIEW_LIMITS.fileBytes || bytes > PREVIEW_LIMITS.totalBytes) throw new Error('关联文件过大，请使用普通预览。');
      return asset.data;
    });
    assets.set(reference, loading); return loading;
  };
  const base64 = (data: Uint8Array) => {
    let binary = ''; for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    return btoa(binary);
  };
  // One encoding per resource: repeated images, fonts and imports reuse the same data URI string.
  const dataUris = new Map<string, Promise<string>>();
  const dataUri = (reference: string, mime: string, load: () => Promise<Uint8Array>) => {
    const key = `${mime} ${reference}`; let uri = dataUris.get(key);
    if (!uri) { uri = load().then(data => `data:${mime};base64,${base64(data)}`); dataUris.set(key, uri); }
    return uri;
  };
  const stylesheets = new Map<string, Promise<string>>();
  const rewriteStyle = (css: string, base = '', ancestors = new Set<string>()): Promise<string> => rewriteCssAssets(css, async (url, imported) => {
    const resource = cssResource(url, imported); if (!resource) return;
    const reference = resolveReference(url, base);
    if (resource.kind === 'stylesheet') {
      // CSS imports can form cycles; omit only the repeated edge as browsers do.
      if (ancestors.has(reference)) return 'data:text/css;base64,';
      let loading = stylesheets.get(reference);
      if (!loading) {
        loading = readBounded(reference).then(data => rewriteStyle(new TextDecoder('utf-8', { fatal: true }).decode(data), reference, new Set([...ancestors, reference])));
        stylesheets.set(reference, loading);
      }
      const rewritten = loading;
      return dataUri(reference, 'text/css', async () => new TextEncoder().encode(await rewritten));
    }
    const fragment = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    return `${await dataUri(reference, resource.mime, () => readBounded(reference))}${fragment}`;
  });
  for (const node of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const href = node.getAttribute('href')!;
    if (!isStylesheetLink(node.getAttribute('rel') ?? '', href)) { node.remove(); continue; }
    const reference = resolveReference(href);
    const style = doc.createElement('style'); style.setAttribute('data-region-stylesheet', reference);
    if (node.hasAttribute('media')) style.setAttribute('media', node.getAttribute('media')!);
    style.textContent = await rewriteStyle(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(reference)), reference, new Set([reference]));
    node.replaceWith(style);
  }
  for (const node of doc.querySelectorAll('style')) node.textContent = (await rewriteStyle(node.textContent ?? '')).replace(/<\/style/gi, '<\\/style');
  for (const node of doc.querySelectorAll('[style]')) node.setAttribute('style', await rewriteStyle(node.getAttribute('style')!));
  for (const node of doc.querySelectorAll('script')) {
    const src = node.getAttribute('src');
    if (src) {
      // Scripts run only in the live interactive preview; frozen comparisons are always scriptless.
      if (!isLocalReference(src) || !/\.(?:js|mjs)(?:[?#]|$)/i.test(src)) { node.remove(); continue; }
      node.textContent = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(resolveReference(src)));
      node.removeAttribute('src');
    }
    node.setAttribute('nonce', nonce);
    node.textContent = (node.textContent ?? '').replace(/<\/script/gi, '<\\/script');
  }
  for (const node of doc.querySelectorAll('img[src]')) {
    const src = node.getAttribute('src')!;
    node.removeAttribute('srcset');
    if (!isLocalReference(src)) continue;
    const mime = imageSourceMime(src);
    if (!mime) { node.removeAttribute('src'); continue; }
    const reference = resolveReference(src);
    node.setAttribute('src', await dataUri(reference, mime, () => readBounded(reference)));
  }
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  // Running page scripts can replace or copy initial nodes before the bridge binds them.
  const sources = interactive && doc.querySelector('script') ? {} : annotated.sources;
  const bridge = doc.createElement('script'); bridge.setAttribute('nonce', nonce);
  bridge.textContent = picker.replace(/<\/script/gi, '<\\/script'); doc.head.prepend(bridge); doc.head.prepend(policy);
  signal.throwIfAborted();
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, sources };
}

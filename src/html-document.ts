import { randomToken } from './token.ts';
import { toBase64 } from './base64.ts';
import { rewriteCssAssets } from './css-assets.ts';
import { annotateHtml } from './source-map.ts';
import { PREVIEW_LIMITS, cssResource, imageReference, imageSourceMime, isLocalReference, isStylesheetLink, resolveReference } from './resources.ts';
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
  // Links keep their href so :link and a[href] styles apply. The picker script keeps them from leaving the preview;
  // a frozen comparison has no script, so its links cannot be followed at all.
  if (!picker) {
    const guard = doc.createElement('style'); guard.textContent = 'a[href],area[href]{pointer-events:none!important}';
    doc.body.append(guard);
  }
  // A <picture> falls back to its <img>, whose source is embedded below like any other image.
  doc.querySelectorAll('picture > source').forEach(n => n.remove());
  let bytes = 0, count = 0;
  // One failed read fails the preview; the others stop instead of finishing in the background.
  const failed = new AbortController(), reading = AbortSignal.any([signal, failed.signal]);
  const assets = new Map<string, Promise<Uint8Array>>();
  const readBounded = (reference: string): Promise<Uint8Array> => {
    const cached = assets.get(reference); if (cached) return cached;
    const loading = (async () => {
      reading.throwIfAborted();
      if (++count > PREVIEW_LIMITS.files) throw new Error(`关联文件超过 ${PREVIEW_LIMITS.files} 个，请使用普通预览。`);
      const asset = await read(reference, reading);
      bytes += asset.data.byteLength;
      if (asset.data.byteLength > PREVIEW_LIMITS.fileBytes || bytes > PREVIEW_LIMITS.totalBytes) throw new Error('关联文件过大，请使用普通预览。');
      return asset.data;
    })();
    // Prefetched reads may never be awaited when another one fails first.
    loading.catch(() => undefined);
    assets.set(reference, loading); return loading;
  };
  const utf8 = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(data);
  // One encoding per resource: repeated images, fonts and imports reuse the same data URI string.
  const dataUris = new Map<string, Promise<string>>();
  const dataUri = (reference: string, mime: string, load: () => Promise<Uint8Array>) => {
    const key = `${mime} ${reference}`; let uri = dataUris.get(key);
    if (!uri) { uri = load().then(data => `data:${mime};base64,${toBase64(data)}`); dataUris.set(key, uri); }
    return uri;
  };
  /**
   * Start reading everything a stylesheet refers to, and as each nested stylesheet arrives, what it refers to.
   * The rewrite below then finds the bytes already loading; it reads the same set of files, so limits hold alike.
   */
  const scanned = new Set<string>();
  const prefetchCss = (css: string, base: string): void => {
    void rewriteCssAssets(css, async (url, imported) => {
      const resource = cssResource(url, imported); if (!resource) return;
      const reference = resolveReference(url, base);
      if (resource.kind === 'stylesheet') prefetchSheet(reference); else void readBounded(reference);
      return undefined;
    }).catch(() => undefined);
  };
  const prefetchSheet = (reference: string): void => {
    if (scanned.has(reference)) return; scanned.add(reference);
    readBounded(reference).then(data => prefetchCss(utf8(data), reference), () => undefined);
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
        loading = readBounded(reference).then(data => rewriteStyle(utf8(data), reference, new Set([...ancestors, reference])));
        stylesheets.set(reference, loading);
      }
      const rewritten = loading;
      return dataUri(reference, 'text/css', async () => new TextEncoder().encode(await rewritten));
    }
    const fragment = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    return `${await dataUri(reference, resource.mime, () => readBounded(reference))}${fragment}`;
  });
  const links: { node: Element; reference: string }[] = [];
  for (const node of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const href = node.getAttribute('href')!;
    if (isStylesheetLink(node.getAttribute('rel') ?? '', href)) links.push({ node, reference: resolveReference(href) }); else node.remove();
  }
  const styles = [...doc.querySelectorAll('style')], styled = [...doc.querySelectorAll('[style]')];
  try {
    for (const { reference } of links) prefetchSheet(reference);
    for (const node of styles) prefetchCss(node.textContent ?? '', '');
    for (const node of styled) prefetchCss(node.getAttribute('style')!, '');
    // Scripts and images do not depend on each other and are embedded concurrently.
    const embedded = [...doc.querySelectorAll('script')].map(async node => {
      const src = node.getAttribute('src');
      if (src) {
        // Scripts run only in the live interactive preview; frozen comparisons are always scriptless.
        if (!isLocalReference(src) || !/\.(?:js|mjs)(?:[?#]|$)/i.test(src)) { node.remove(); return; }
        node.textContent = utf8(await readBounded(resolveReference(src)));
        node.removeAttribute('src');
      }
      node.setAttribute('nonce', nonce);
      node.textContent = (node.textContent ?? '').replace(/<\/script/gi, '<\\/script');
    }).concat([...doc.querySelectorAll('img')].map(async node => {
      const src = node.getAttribute('src') ?? '', srcset = node.getAttribute('srcset') ?? '';
      node.removeAttribute('srcset'); node.removeAttribute('sizes');
      if (src && !isLocalReference(src)) return;
      const chosen = imageReference(src, srcset);
      if (!chosen) { node.removeAttribute('src'); return; }
      const reference = resolveReference(chosen);
      node.setAttribute('src', await dataUri(reference, imageSourceMime(chosen)!, () => readBounded(reference)));
    }));
    embedded.forEach(job => job.catch(() => undefined));
    // Style rewrites share one stylesheet cache and imports may be cyclic, so they run one at a time.
    const closeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style');
    for (const { node, reference } of links) {
      const style = doc.createElement('style'); style.setAttribute('data-region-stylesheet', reference);
      if (node.hasAttribute('media')) style.setAttribute('media', node.getAttribute('media')!);
      style.textContent = closeStyle(await rewriteStyle(utf8(await readBounded(reference)), reference, new Set([reference])));
      node.replaceWith(style);
    }
    for (const node of styles) node.textContent = closeStyle(await rewriteStyle(node.textContent ?? ''));
    for (const node of styled) node.setAttribute('style', await rewriteStyle(node.getAttribute('style')!));
    await Promise.all(embedded);
  } catch (error) { failed.abort(); throw error; }
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  // Running page scripts can replace or copy initial nodes before the bridge binds them.
  const sources = interactive && doc.querySelector('script') ? {} : annotated.sources;
  const bridge = doc.createElement('script'); bridge.setAttribute('nonce', nonce);
  bridge.textContent = picker.replace(/<\/script/gi, '<\\/script'); doc.head.prepend(bridge); doc.head.prepend(policy);
  signal.throwIfAborted();
  // srcdoc frames always render in no-quirks mode (HTML spec), whatever doctype the file has.
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, sources };
}

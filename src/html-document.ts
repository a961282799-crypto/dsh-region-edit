import { randomToken } from './token.ts';
import { rewriteCssAssets } from './css-assets.ts';
export type AssetReader = (reference: string, signal: AbortSignal) => Promise<{ data: Uint8Array; resourceAddress?: string }>;
/** Builds a file preview in an opaque origin; only the picker bridge runs in static mode. */
export async function htmlDocument(source: string, picker: string, interactive: boolean, read: AssetReader, signal: AbortSignal): Promise<string> {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const nonce = randomToken();
  doc.querySelectorAll('base,meta[http-equiv],iframe,object,embed,portal').forEach(n => n.remove());
  if (!interactive) {
    doc.querySelectorAll('script,template').forEach(n => n.remove());
    for (const node of doc.querySelectorAll('*')) for (const a of [...node.attributes]) if (/^on/i.test(a.name)) node.removeAttribute(a.name);
  }
  doc.querySelectorAll('a,area').forEach(n => n.removeAttribute('href'));
  const local = (value: string) => !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(value);
  const relative = (reference: string, base = '') => {
    const parts: string[] = [];
    for (const part of (base.slice(0, base.lastIndexOf('/') + 1) + reference.split(/[?#]/)[0]!).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  };
  let bytes = 0, count = 0;
  const assets = new Map<string, Promise<Uint8Array>>();
  const readBounded = async (reference: string) => {
    signal.throwIfAborted();
    const cached = assets.get(reference); if (cached) return cached;
    if (++count > 32) throw new Error('关联文件超过 32 个，请使用普通预览。');
    const loading = read(reference, signal).then(asset => {
      bytes += asset.data.byteLength;
      if (asset.data.byteLength > 4 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error('关联文件过大，请使用普通预览。');
      return asset.data;
    });
    assets.set(reference, loading); return loading;
  };
  const base64 = (data: Uint8Array) => {
    let binary = ''; for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    return btoa(binary);
  };
  const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
  const stylesheets = new Map<string, Promise<string>>();
  const rewriteStyle = (css: string, base = '', ancestors = new Set<string>()): Promise<string> => rewriteCssAssets(css, async (url, stylesheet) => {
    if (!local(url)) return;
    const reference = relative(url, base), extension = reference.split('.').at(-1)?.toLowerCase();
    if (stylesheet || extension === 'css') {
      // CSS imports can form cycles; omit only the repeated edge as browsers do.
      if (ancestors.has(reference)) return 'data:text/css;base64,';
      let loading = stylesheets.get(reference);
      if (!loading) {
        loading = readBounded(reference).then(data => rewriteStyle(new TextDecoder('utf-8', { fatal: true }).decode(data), reference, new Set([...ancestors, reference])));
        stylesheets.set(reference, loading);
      }
      return `data:text/css;base64,${base64(new TextEncoder().encode(await loading))}`;
    }
    const mime = mimeTypes[extension ?? '']; if (!mime) return;
    const fragment = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    return `data:${mime};base64,${base64(await readBounded(reference))}${fragment}`;
  });
  for (const node of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const href = node.getAttribute('href')!;
    if (!local(href) || !/\.css(?:[?#]|$)/i.test(href)) { node.remove(); continue; }
    const reference = relative(href);
    const style = doc.createElement('style'); style.textContent = await rewriteStyle(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(reference)), reference, new Set([reference]));
    node.replaceWith(style);
  }
  for (const node of doc.querySelectorAll('style')) node.textContent = (await rewriteStyle(node.textContent ?? '')).replace(/<\/style/gi, '<\\/style');
  for (const node of doc.querySelectorAll('[style]')) node.setAttribute('style', await rewriteStyle(node.getAttribute('style')!));
  for (const node of doc.querySelectorAll('script')) {
    const src = node.getAttribute('src');
    if (src) {
      if (!local(src) || !/\.(?:js|mjs)(?:[?#]|$)/i.test(src)) { node.remove(); continue; }
      node.textContent = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(relative(src)));
      node.removeAttribute('src');
    }
    node.setAttribute('nonce', nonce);
    node.textContent = (node.textContent ?? '').replace(/<\/script/gi, '<\\/script');
  }
  for (const node of doc.querySelectorAll('img[src]')) {
    const src = node.getAttribute('src')!;
    node.removeAttribute('srcset');
    if (!local(src)) continue;
    const ext = src.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase();
    const mime = mimeTypes[ext ?? ''];
    if (!mime?.startsWith('image/')) { node.removeAttribute('src'); continue; }
    node.setAttribute('src', `data:${mime};base64,${base64(await readBounded(relative(src)))}`);
  }
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  doc.head.prepend(policy);
  const bridge = doc.createElement('script'); bridge.setAttribute('nonce', nonce);
  bridge.textContent = picker.replace(/<\/script/gi, '<\\/script'); doc.head.prepend(bridge); doc.head.prepend(policy);
  signal.throwIfAborted();
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

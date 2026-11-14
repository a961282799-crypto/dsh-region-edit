import { collectRegion } from './selection.ts';
import { validPoints } from './lasso.ts';
import { ElementReader, enrichRegion, rememberSources } from './element.ts';
// This channel exposes one read-only operation inside the opaque preview origin.
let active: MessagePort | undefined;
const elements = new ElementReader(document);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => rememberSources(document), { once: true });
else rememberSources(document);
window.addEventListener('pagehide', () => active?.close(), { once: true });
// Following any link, even "#id", would replace this sandboxed preview with another document. In-page anchors
// scroll to their target instead.
document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a[href],area[href]') : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href')!;
  if (!href.startsWith('#')) return;
  let id = href.slice(1); try { id = decodeURIComponent(id); } catch { /* Literal percent sign. */ }
  const target = !id || id.toLowerCase() === 'top' ? document.documentElement : document.getElementById(id) ?? document.getElementsByName(id)[0];
  target?.scrollIntoView();
}, true);
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.kind !== 'dsh-region/connect' || event.ports.length !== 1) return;
  const port = event.ports[0]!;
  active?.close(); active = port;
  port.onmessage = message => {
    const { id, selection, kind, x, y, elementId } = message.data ?? {}, box = selection?.box;
    if (typeof id !== 'string' || id.length > 100) return;
    try {
      if ((kind === 'point' || kind === 'hover') && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e7 && Math.abs(y) < 1e7) {
        port.postMessage({ id, region: elements.at(x, y, kind === 'hover') });
      } else if (kind === 'element' && typeof elementId === 'string' && elementId.length <= 64) {
        port.postMessage({ id, region: elements.read(elementId) });
      } else if (!kind && box && ['x','y','width','height'].every(k => Number.isFinite(box[k])) && box.width >= 0 && box.height >= 0 && validPoints(selection.points)) {
        port.postMessage({ id, region: enrichRegion(collectRegion(document.body, selection), document.body) });
      }
    } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : '无法读取这个选区，请重新选择。' }); }
  };
  port.start();
}, { once: false });

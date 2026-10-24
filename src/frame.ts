import { collectRegion } from './selection.ts';
import { validPoints } from './lasso.ts';
// This channel exposes one read-only operation inside the opaque preview origin.
let active: MessagePort | undefined;
window.addEventListener('pagehide', () => active?.close(), { once: true });
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.kind !== 'dsh-region/connect' || event.ports.length !== 1) return;
  const port = event.ports[0]!;
  active?.close(); active = port;
  port.onmessage = message => {
    const { id, selection } = message.data ?? {}, box = selection?.box;
    if (typeof id !== 'string' || !box || !['x','y','width','height'].every(k => Number.isFinite(box[k])) || box.width < 0 || box.height < 0 || !validPoints(selection.points)) return;
    try { port.postMessage({ id, region: collectRegion(document.body, selection) }); }
    catch { port.postMessage({ id, error: '无法读取这个选区，请重新圈选。' }); }
  };
  port.start();
}, { once: false });

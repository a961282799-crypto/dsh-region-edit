import { validRegion } from './selection.ts';
import type { Region } from './selection.ts';
import { area, boundsOf, clip } from './lasso.ts';
import type { Lasso } from './lasso.ts';
import { randomToken } from './token.ts';
import { collectImage } from './image.ts';
const frames = new WeakMap<HTMLIFrameElement, { port: MessagePort; close(): void; request(selection: Lasso, signal: AbortSignal): Promise<Region> }>();
export function connectFrame(frame: HTMLIFrameElement): () => void {
  frames.get(frame)?.close();
  const channel = new MessageChannel();
  const pending = new Map<string, { resolve(region: Region): void; reject(error: Error): void }>();
  channel.port1.onmessage = ({ data }) => {
    const request = typeof data?.id === 'string' ? pending.get(data.id) : undefined;
    if (!request) return;
    const candidate: unknown = data.region;
    if (validRegion(candidate)) {
      const { box, viewport, text, elements, truncated, polygon } = candidate;
      request.resolve({ box, viewport, text, truncated, ...(polygon ? { polygon } : {}), elements: elements.map(({ tag, selector, text, html, page, cell }) => ({
        tag, selector, text, html, ...(page === undefined ? {} : { page }), ...(cell === undefined ? {} : { cell })
      })) });
    }
    else request.reject(new Error('无法读取预览中的选区，请重新圈选。'));
  };
  const state = {
    port: channel.port1,
    close() {
      for (const request of pending.values()) request.reject(new Error('预览已刷新，请重新圈选。'));
      pending.clear(); channel.port1.close();
      if (frames.get(frame) === state) { frames.delete(frame); delete frame.dataset.regionConnected; }
    },
    request(selection: Lasso, signal: AbortSignal): Promise<Region> {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = randomToken();
        const finish = (result?: Region, error?: Error) => {
          clearTimeout(timeout); pending.delete(id); signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(undefined, new Error('圈选已取消。'));
        const timeout = setTimeout(() => finish(undefined, new Error('预览没有响应，请重新载入后再试。')), 2500);
        pending.set(id, { resolve: region => finish(region), reject: error => finish(undefined, error) });
        signal.addEventListener('abort', abort, { once: true });
        channel.port1.postMessage({ id, selection });
      });
    }
  };
  frames.set(frame, state);
  frame.dataset.regionConnected = '';
  frame.contentWindow?.postMessage({ kind: 'dsh-region/connect' }, '*', [channel.port2]);
  return () => state.close();
}
export async function readRegion(root: HTMLElement, selection: Lasso, signal: AbortSignal): Promise<Region> {
  const { box, points } = selection;
  signal.throwIfAborted();
  const image = root.querySelector<HTMLImageElement>('[data-image-preview] img');
  if (image) return collectImage(image, selection);
  const { collectRegion, overlaps } = await import('./selection.ts');
  for (const frame of root.querySelectorAll('iframe')) {
    const rect = frame.getBoundingClientRect();
    if (!overlaps(box, rect)) continue;
    const localPoints = clip(points, rect).map(p => ({ x: p.x - rect.x, y: p.y - rect.y }));
    if (localPoints.length < 3 || area(localPoints) < .01) continue;
    const clipped = { box: boundsOf(localPoints), points: localPoints };
    const bridge = frames.get(frame);
    if (bridge) return bridge.request(clipped, signal);
    try { if (frame.contentDocument?.body) return collectRegion(frame.contentDocument.body, clipped); } catch { /* Opaque frame. */ }
    throw new Error('请在预览方式中选择「圈选预览」，再圈选页面里的元素。');
  }
  return collectRegion(root, selection);
}

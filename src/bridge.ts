import { cleanElement, validRegion } from './selection.ts';
import type { Region } from './selection.ts';
import { area, boundsOf, clip } from './lasso.ts';
import type { Lasso } from './lasso.ts';
import { randomToken } from './token.ts';
import { collectImage } from './image.ts';
import type { SourceIndex } from './source-map.ts';
export interface ElementSelection { kind: 'element'; frame: HTMLIFrameElement; elementId: string }
export type Selection = Lasso | ElementSelection;
type FrameRequest = { selection: Lasso } | { kind: 'point' | 'hover'; x: number; y: number } | { kind: 'element'; elementId: string };
const frames = new WeakMap<HTMLIFrameElement, { source: string; close(): void; request(request: FrameRequest, signal: AbortSignal): Promise<Region> }>();
export function connectFrame(frame: HTMLIFrameElement, sources: SourceIndex = {}, source = ''): () => void {
  frames.get(frame)?.close();
  const channel = new MessageChannel();
  const pending = new Map<string, { resolve(region: Region): void; reject(error: Error): void }>();
  channel.port1.onmessage = ({ data }) => {
    const request = typeof data?.id === 'string' ? pending.get(data.id) : undefined;
    if (!request) return;
    const candidate: unknown = data.region;
    if (validRegion(candidate)) {
      const { box, viewport, text, elements, truncated, polygon, element } = candidate;
      request.resolve({ box, viewport, text, truncated, ...(polygon ? { polygon } : {}),
        ...(element ? { element: { id: element.id, ...(element.parentId ? { parentId: element.parentId } : {}) } } : {}),
        elements: elements.map(raw => {
          const { sourceKey, ...element } = cleanElement(raw);
          return { ...element, ...(sourceKey && Object.hasOwn(sources, sourceKey) ? { source: sources[sourceKey]! } : {}) };
        }) });
    }
    else request.reject(new Error(typeof data?.error === 'string' ? data.error.slice(0, 160) : '无法读取预览中的选区，请重新选择。'));
  };
  const state = {
    source,
    close() {
      for (const request of pending.values()) request.reject(new Error('预览已刷新，请重新圈选。'));
      pending.clear(); channel.port1.close();
      if (frames.get(frame) === state) { frames.delete(frame); delete frame.dataset.regionConnected; }
    },
    request(request: FrameRequest, signal: AbortSignal): Promise<Region> {
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
        channel.port1.postMessage({ id, ...request });
      });
    }
  };
  frames.set(frame, state);
  frame.dataset.regionConnected = '';
  frame.contentWindow?.postMessage({ kind: 'dsh-region/connect' }, '*', [channel.port2]);
  return () => state.close();
}
export async function readRegion(root: HTMLElement, selection: Selection, signal: AbortSignal): Promise<Region> {
  if ('kind' in selection) {
    const bridge = frames.get(selection.frame);
    if (!root.contains(selection.frame) || !bridge) throw new Error('页面预览已刷新，请重新点选。');
    return bridge.request({ kind: 'element', elementId: selection.elementId }, signal);
  }
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
    if (bridge) return bridge.request({ selection: clipped }, signal);
    try { if (frame.contentDocument?.body) return collectRegion(frame.contentDocument.body, clipped); } catch { /* Opaque frame. */ }
    throw new Error('请在预览方式中选择「圈选预览」，再圈选页面里的元素。');
  }
  return collectRegion(root, selection);
}
export function checkPreviewSource(root: HTMLElement, source: string): void {
  if (!source) return;
  for (const frame of root.querySelectorAll('iframe[data-region-frame]')) {
    const state = frames.get(frame as HTMLIFrameElement);
    if (state && state.source !== source) throw new Error('文件与页面预览版本不一致，请等待预览刷新后重新选择。');
  }
}
export function elementBox(selection: ElementSelection, region: Region) {
  const rect = selection.frame.getBoundingClientRect();
  const sx = rect.width / region.viewport.width, sy = rect.height / region.viewport.height;
  const x = Math.max(rect.left, rect.x + region.box.x * sx), y = Math.max(rect.top, rect.y + region.box.y * sy);
  return { x, y, width: Math.max(0, Math.min(rect.right, rect.x + (region.box.x + region.box.width) * sx) - x),
    height: Math.max(0, Math.min(rect.bottom, rect.y + (region.box.y + region.box.height) * sy) - y) };
}
export async function pickElement(root: HTMLElement, x: number, y: number, signal: AbortSignal, hover = false) {
  for (const frame of root.querySelectorAll('iframe')) {
    const rect = frame.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue;
    const bridge = frames.get(frame);
    if (!bridge) break;
    const region = await bridge.request({ kind: hover ? 'hover' : 'point',
      x: (x - rect.x) * frame.clientWidth / rect.width, y: (y - rect.y) * frame.clientHeight / rect.height }, signal);
    if (!hover && !region.element) throw new Error('无法定位该元素，请重新选择。');
    const selection: ElementSelection = { kind: 'element', frame, elementId: region.element?.id ?? '' };
    return { selection, region, box: elementBox(selection, region) };
  }
  throw new Error('请在预览方式中选择「圈选预览」，再点选页面元素。');
}

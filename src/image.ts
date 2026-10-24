import type { Box, Region } from './selection.ts';
import { area, boundsOf, clip } from './lasso.ts';
import type { Lasso, Point } from './lasso.ts';
export interface ImageSelection {
  width: number; height: number;
  pixels: Box; normalized: Box;
  polygon: { pixels: Point[]; normalized: Point[] };
}
/** Map a displayed image selection to the original file, including zoom and contain/cover. */
export function imageSelection(box: Box, bounds: Box, width: number, height: number, points?: readonly Point[]): ImageSelection {
  if (![box.x, box.y, box.width, box.height, bounds.x, bounds.y, bounds.width, bounds.height, width, height].every(Number.isFinite)
    || box.width <= 0 || box.height <= 0) throw new Error('请重新圈选有效的图片区域。');
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) throw new Error('图片尚未载入，请稍后重试。');
  const left = Math.max(bounds.x, box.x), top = Math.max(bounds.y, box.y);
  const right = Math.min(bounds.x + bounds.width, box.x + box.width), bottom = Math.min(bounds.y + bounds.height, box.y + box.height);
  if (right <= left || bottom <= top) throw new Error('请在图片里面圈选，空白区域无法定位。');
  const contour = clip(points ?? [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }], bounds);
  if (contour.length < 3 || area(contour) < .01) throw new Error('请把目标圈在图片里面，空白区域无法定位。');
  const normalized = contour.map(p => ({ x: (p.x - bounds.x) / bounds.width, y: (p.y - bounds.y) / bounds.height }));
  const pixelPoints = normalized.map(p => ({ x: +(p.x * width).toFixed(3), y: +(p.y * height).toFixed(3) }));
  const envelope = boundsOf(pixelPoints), x = Math.max(0, Math.floor(envelope.x)), y = Math.max(0, Math.floor(envelope.y));
  const pixels = { x, y, width: Math.min(width, Math.ceil(envelope.x + envelope.width)) - x, height: Math.min(height, Math.ceil(envelope.y + envelope.height)) - y };
  return { width, height, pixels, normalized: { x: pixels.x / width, y: pixels.y / height, width: pixels.width / width, height: pixels.height / height },
    polygon: { pixels: pixelPoints, normalized: normalized.map(p => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6) })) } };
}
export function collectImage(image: HTMLImageElement, selection: Lasso): Region {
  const { box, points } = selection;
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error('图片尚未载入，请稍后重试。');
  const rect = image.getBoundingClientRect(), style = getComputedStyle(image);
  let bounds: Box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const fit = style.objectFit;
  if (fit === 'contain' || fit === 'cover' || fit === 'none' || fit === 'scale-down') {
    let scale = fit === 'cover' ? Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
      : fit === 'none' ? 1 : Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    if (fit === 'scale-down') scale = Math.min(1, scale);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    const positions = style.objectPosition.split(/\s+/);
    const offset = (value: string, free: number) => value.endsWith('%') ? parseFloat(value) / 100 * free : parseFloat(value) || 0;
    bounds = { x: rect.x + offset(positions[0] ?? '50%', rect.width - width),
      y: rect.y + offset(positions[1] ?? '50%', rect.height - height), width, height };
  }
  // The image element clips contain/cover painting; a drag in its letterbox is rejected.
  const clipped = { x: Math.max(box.x, rect.x), y: Math.max(box.y, rect.y),
    width: Math.min(box.x + box.width, rect.right) - Math.max(box.x, rect.x),
    height: Math.min(box.y + box.height, rect.bottom) - Math.max(box.y, rect.y) };
  if (clipped.width <= 0 || clipped.height <= 0) throw new Error('请在图片里面圈选，空白区域无法定位。');
  const view = image.ownerDocument.defaultView!;
  return { box, viewport: { width: view.innerWidth, height: view.innerHeight, scrollX: view.scrollX, scrollY: view.scrollY },
    text: '', elements: [], truncated: false, polygon: points,
    image: imageSelection(clipped, bounds, image.naturalWidth, image.naturalHeight, clip(points, rect)) };
}

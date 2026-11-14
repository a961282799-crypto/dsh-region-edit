import type { Point } from './lasso.ts';
import { MARKER_MAX_BYTES, MARKER_SIDE } from './recognition.ts';

/**
 * Optional locating aid: a reduced copy drawn from the original file's own pixels, never from the screen. The outside
 * of the contour is dimmed and the outline drawn in two contrasting strokes so it shows on light and dark images.
 * `contour` is the normalized polygon (0–1 of the original image).
 */
export async function markerImage(data: Uint8Array, mediaType: string, width: number, height: number, contour: readonly Point[]): Promise<Uint8Array> {
  const scale = Math.min(1, MARKER_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: mediaType }), { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
    if (!g) throw new Error('无法生成标记图');
    // JPEG has no transparency: transparent areas become white, as most viewers show them.
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bitmap, 0, 0, w, h);
    const outline = new Path2D();
    contour.forEach((p, i) => { if (i) outline.lineTo(p.x * w, p.y * h); else outline.moveTo(p.x * w, p.y * h); });
    outline.closePath();
    const outside = new Path2D(); outside.rect(0, 0, w, h); outside.addPath(outline);
    g.fillStyle = 'rgba(0, 0, 0, .4)'; g.fill(outside, 'evenodd');
    const line = Math.max(2, Math.round(Math.max(w, h) / 320));
    g.lineJoin = 'round';
    g.strokeStyle = '#fff'; g.lineWidth = line * 2.5; g.stroke(outline);
    g.strokeStyle = '#ff1f4b'; g.lineWidth = line; g.stroke(outline);
    for (const quality of [.88, .72, .55]) {
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
      if (bytes.byteLength <= MARKER_MAX_BYTES) return bytes;
    }
    throw new Error('标记图过大');
  } finally { bitmap.close(); }
}

const SETTING = 'dsh-region-edit:marker';
/** A per-user choice kept in this app's local storage; off unless turned on. Storage may be unavailable. */
export function markerSetting(): boolean { try { return localStorage.getItem(SETTING) === '1'; } catch { return false; } }
export function saveMarkerSetting(on: boolean): void { try { if (on) localStorage.setItem(SETTING, '1'); else localStorage.removeItem(SETTING); } catch { /* Kept for this window only. */ } }

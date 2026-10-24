import { intersects, validPoints } from './lasso.ts';
import type { Lasso, Point } from './lasso.ts';
export interface Box { x: number; y: number; width: number; height: number }
export interface SelectedElement {
  tag: string; selector: string; text: string; html: string;
  page?: string; cell?: string;
}
export interface Region {
  box: Box; viewport: { width: number; height: number; scrollX: number; scrollY: number };
  text: string; elements: SelectedElement[]; truncated: boolean;
  image?: import('./image.ts').ImageSelection;
  polygon?: Point[];
}
export const LIMIT = { text: 6000, elements: 12, nodes: 12000, html: 700 } as const;
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function overlaps(a: Box, b: Box): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function rectBox(rect: DOMRect): Box { return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }
function selectorOf(element: Element, root: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== root && parts.length < 6; node = node.parentElement) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const same = node.parentElement ? [...node.parentElement.children].filter(n => n.tagName === node!.tagName) : [];
    parts.unshift(node.localName + (same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''));
  }
  return parts.join(' > ') || root.localName;
}
/** Reads layout and text only. No pixels, canvas extraction, form values, or screenshot APIs. */
export function collectRegion(root: Element, selection: Box | Lasso): Region {
  const { box, points } = 'points' in selection ? selection : { box: selection, points: undefined };
  const hit = (rect: Box) => overlaps(box, rect) && (!points || intersects(points, rect));
  const doc = root.ownerDocument, view = doc.defaultView!;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const snippets: string[] = [], elements = new Map<Element, SelectedElement>();
  let textLength = 0, visited = 0, truncated = false;
  const addElement = (target: Element, text: string) => {
    if (elements.has(target) || elements.size >= LIMIT.elements) return;
    const clean = target.cloneNode(true) as Element;
    clean.querySelectorAll('script,style,input,textarea,select').forEach(n => n.remove());
    for (const element of [clean, ...clean.querySelectorAll('*')]) for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === 'value') element.removeAttribute(attribute.name);
    }
    const page = target.closest('[data-page-number],[data-pdf-page]');
    const cell = target.closest('td,th') as HTMLTableCellElement | null;
    elements.set(target, { tag: target.localName, selector: selectorOf(target, root), text: text.slice(0, 600), html: clean.outerHTML.slice(0, LIMIT.html),
      ...(page ? { page: page.getAttribute('data-page-number') ?? page.getAttribute('data-pdf-page') ?? '' } : {}),
      ...(cell ? { cell: `row ${cell.parentElement ? (cell.parentElement as HTMLTableRowElement).rowIndex + 1 : '?'}, column ${cell.cellIndex + 1}` } : {}) });
  };
  const clips = new Map<Element, Box | null>();
  const visibleRect = (rect: DOMRect, element: Element): Box | undefined => {
    if (!clips.has(element)) {
      let clip: Box | null = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
      if (element.closest('script,style,noscript,template,[hidden],[data-region-ui]')
        || view.getComputedStyle(element).visibility !== 'visible') clip = null;
      // Geometry remains measurable for transparent and overflow-clipped descendants.
      // Clip each glyph against the actual scrollports, not just its layout rectangle.
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (!clip) break;
        const style = view.getComputedStyle(node);
        if (style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden') { clip = null; break; }
        if (style.display === 'inline') continue;
        const clipX = style.overflowX !== 'visible', clipY = style.overflowY !== 'visible';
        if (!clipX && !clipY) continue;
        const bounds = node.getBoundingClientRect(), html = node as HTMLElement;
        const scaleX = html.offsetWidth ? bounds.width / html.offsetWidth : 1;
        const scaleY = html.offsetHeight ? bounds.height / html.offsetHeight : 1;
        const left = bounds.left + node.clientLeft * scaleX, top = bounds.top + node.clientTop * scaleY;
        const right = left + node.clientWidth * scaleX, bottom = top + node.clientHeight * scaleY;
        const x = clipX ? Math.max(clip.x, left) : clip.x, y = clipY ? Math.max(clip.y, top) : clip.y;
        clip = { x, y, width: (clipX ? Math.min(clip.x + clip.width, right) : clip.x + clip.width) - x,
          height: (clipY ? Math.min(clip.y + clip.height, bottom) : clip.y + clip.height) - y };
        if (clip.width <= 0 || clip.height <= 0) clip = null;
      }
      clips.set(element, clip);
    }
    const clip = clips.get(element);
    if (!clip) return;
    const x = Math.max(rect.x, clip.x), y = Math.max(rect.y, clip.y);
    const width = Math.min(rect.right, clip.x + clip.width) - x, height = Math.min(rect.bottom, clip.y + clip.height) - y;
    if (width > 0 && height > 0) return { x, y, width, height };
  };
  const visibleHit = (rect: DOMRect, element: Element) => {
    if (!hit(rectBox(rect))) return false;
    const visible = visibleRect(rect, element); return !!visible && hit(visible);
  };
  const range = doc.createRange();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  while (walker.nextNode()) {
    if (++visited > LIMIT.nodes || textLength >= LIMIT.text) { truncated = true; break; }
    const node = walker.currentNode, parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"],[data-region-ui]')) continue;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    if (!rects.some(r => visibleHit(r, parent))) continue;
    // Trim the two boundary lines by actual glyph geometry rather than including an entire paragraph.
    const runs: string[] = []; let run = '';
    const value = node.textContent;
    for (const { index, segment } of segmenter.segment(value)) {
      if (index > 30000) { truncated = true; break; }
      range.setStart(node, index); range.setEnd(node, index + segment.length);
      if ([...range.getClientRects()].some(r => visibleHit(r, parent))) run += segment;
      else if (run) { runs.push(run); run = ''; }
    }
    if (run) runs.push(run);
    const text = runs.map(s => s.trim()).filter(Boolean).join('\n');
    if (!text) continue;
    snippets.push(text.slice(0, LIMIT.text - textLength)); textLength += text.length;
    const target = parent.closest('button,a,h1,h2,h3,h4,li,td,th,label,p,pre,svg,text') ?? parent;
    addElement(target, text);
  }
  // Empty controls still carry a semantic label, without reading user-entered values.
  for (const node of root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],[aria-label]')) {
    if (elements.size >= LIMIT.elements) break;
    if (node.closest('[aria-hidden="true"]') || !visibleHit(node.getBoundingClientRect(), node)) continue;
    const text = node.getAttribute('aria-label') ?? node.getAttribute('title') ?? '';
    if (text && !elements.has(node)) elements.set(node, { tag: node.localName, selector: selectorOf(node, root), text: text.slice(0, 600), html: '' });
  }
  // Decorative graphics remain visible even when aria-hidden excludes them from the accessibility tree.
  for (const node of root.querySelectorAll('img,svg,[role="img"]')) {
    if (elements.size >= LIMIT.elements) break;
    if (!visibleHit(node.getBoundingClientRect(), node)
      || [...elements.keys()].some(selected => selected.contains(node) || node.contains(selected))) continue;
    addElement(node, node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title')
      || (node.localName === 'svg' ? node.querySelector('title')?.textContent || 'SVG 图标' : '图片'));
  }
  // When a blank area is circled, identify the smallest intersecting painted container.
  if (!elements.size && !snippets.length) {
    let background: Element | undefined, smallest = Infinity, scanned = 0;
    for (const node of root.querySelectorAll('*')) {
      if (++scanned > LIMIT.nodes) { truncated = true; break; }
      const rect = node.getBoundingClientRect();
      if (!visibleHit(rect, node)) continue;
      const style = view.getComputedStyle(node), size = rect.width * rect.height;
      const color = style.backgroundColor;
      if (size < smallest && (style.backgroundImage !== 'none' || color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)')) {
        background = node; smallest = size;
      }
    }
    if (background) addElement(background, background.getAttribute('aria-label') || background.getAttribute('title') || '背景区域');
  }
  return { box, viewport: { width: view.innerWidth, height: view.innerHeight, scrollX: view.scrollX, scrollY: view.scrollY },
    text: snippets.join('\n').slice(0, LIMIT.text), elements: [...elements.values()], truncated: truncated || textLength > LIMIT.text, ...(points ? { polygon: points } : {}) };
}
/** Treat sandbox messages as untrusted data, even when they come from the expected frame. */
export function validRegion(value: unknown): value is Region {
  if (!value || typeof value !== 'object') return false;
  const r = value as Region;
  const box = (b: Box) => b && ['x','y','width','height'].every(k => Number.isFinite(b[k as keyof Box]) && Math.abs(b[k as keyof Box]) < 1e7) && b.width >= 0 && b.height >= 0;
  return !!box(r.box) && !!r.viewport && ['width','height','scrollX','scrollY'].every(k => Number.isFinite(r.viewport[k as keyof Region['viewport']]))
    && typeof r.text === 'string' && r.text.length <= LIMIT.text && typeof r.truncated === 'boolean' && (r.polygon === undefined || validPoints(r.polygon))
    && Array.isArray(r.elements) && r.elements.length <= LIMIT.elements && r.elements.every(e => e && typeof e.tag === 'string' && e.tag.length < 100
      && typeof e.selector === 'string' && e.selector.length < 1500 && typeof e.text === 'string' && e.text.length <= 600
      && typeof e.html === 'string' && e.html.length <= LIMIT.html
      && (e.page === undefined || typeof e.page === 'string' && e.page.length < 100)
      && (e.cell === undefined || typeof e.cell === 'string' && e.cell.length < 100));
}

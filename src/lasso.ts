import type { Box } from './selection.ts';
export interface Point { x: number; y: number }
export interface Lasso { box: Box; points: Point[] }
export const MAX_POINTS = 256;
export function boundsOf(points: readonly Point[]): Box {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function area(points: readonly Point[]): number {
  return Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]!; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
}
function selfIntersects(points: readonly Point[]): boolean {
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < 1e-6
    && p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6
    && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
  for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    if (i === 0 && j === points.length - 1) continue;
    const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[j]!, d = points[(j + 1) % points.length]!;
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
      || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return true;
  }
  return false;
}
function distance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
/** Iterative Douglas–Peucker keeps corners without storing thousands of pointer events. */
export function simplify(points: readonly Point[], tolerance = .8): Point[] {
  if (points.length < 3) return [...points];
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!; let farthest = tolerance, index = -1;
    for (let i = first! + 1; i < last!; i++) { const d = distance(points[i]!, points[first!]!, points[last!]!); if (d > farthest) { farthest = d; index = i; } }
    if (index >= 0) { keep.add(index); stack.push([first!, index], [index, last!]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => ({ ...points[i]! }));
}
export function lasso(points: readonly Point[]): Lasso {
  if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('请按住鼠标画一圈，松开后自动闭合。');
  let contour = simplify(points), tolerance = 1;
  while (contour.length > MAX_POINTS) contour = simplify(points, tolerance *= 1.4);
  if (contour.length > 3 && Math.hypot(contour[0]!.x - contour.at(-1)!.x, contour[0]!.y - contour.at(-1)!.y) < .5) contour.pop();
  if (selfIntersects(contour)) throw new Error('圈选轮廓发生交叉，请沿目标外围重新画一圈。');
  const box = boundsOf(contour);
  if (contour.length < 3 || box.width < 5 || box.height < 5 || area(contour) < 25) throw new Error('圈出的范围太小，请围着目标重新画一圈。');
  return { box, points: contour };
}
export function contains(points: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!, b = points[i]!;
    if (distance(p, a, b) < .01) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Sutherland–Hodgman clips the contour itself, never substitutes its rectangle. */
export function clip(points: readonly Point[], box: Box): Point[] {
  let output = [...points];
  for (const [axis, edge, sign] of [['x', box.x, 1], ['x', box.x + box.width, -1], ['y', box.y, 1], ['y', box.y + box.height, -1]] as const) {
    const input = output; output = [];
    if (!input.length) break;
    let a = input.at(-1)!;
    for (const b of input) {
      const aIn = (a[axis] - edge) * sign >= 0, bIn = (b[axis] - edge) * sign >= 0;
      if (aIn !== bIn) { const t = (edge - a[axis]) / (b[axis] - a[axis]); output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
      if (bIn) output.push(b);
      a = b;
    }
  }
  return output;
}
export function intersects(points: readonly Point[], box: Box): boolean { return area(clip(points, box)) > .01; }
export function validPoints(value: unknown): value is Point[] {
  return Array.isArray(value) && value.length >= 3 && value.length <= MAX_POINTS && value.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 1e7);
}

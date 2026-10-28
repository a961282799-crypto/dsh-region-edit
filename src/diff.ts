/** Line diff for the history text view: Myers' O(ND) algorithm with a bounded edit distance. */
export type DiffKind = 'same' | 'add' | 'del';
export interface DiffLine { kind: DiffKind; text: string; oldNo?: number; newNo?: number }
export interface LineDiff {
  /** False when the change is too large to diff within budget; callers show the plain texts instead. */
  complete: boolean;
  lines: DiffLine[]; added: number; removed: number;
  /** Line terminators or a byte-order mark changed; such changes are invisible in a line view. */
  eol?: { before: string; after: string }; bom?: { before: boolean; after: boolean };
}
export const DIFF_LIMITS = { lines: 200000, edits: 2000 } as const;

function eolOf(text: string): string {
  const crlf = text.match(/\r\n/g)?.length ?? 0, lf = (text.match(/\n/g)?.length ?? 0) - crlf, cr = (text.match(/\r(?!\n)/g)?.length ?? 0);
  const kinds = [crlf && 'CRLF', lf && 'LF', cr && 'CR'].filter(Boolean);
  return kinds.length ? kinds.join('+') : '无换行';
}
export function splitLines(text: string): string[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  return body === '' ? [] : body.split(/\r\n|\n|\r/);
}

/** Edit script between two sequences of interned line ids, or undefined when more than maxEdits are needed. */
function myers(a: Int32Array, b: Int32Array, maxEdits: number): DiffKind[] | undefined {
  const n = a.length, m = b.length, max = Math.min(maxEdits, n + m), offset = max + 1;
  const v = new Int32Array(2 * max + 3); const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { trace.push(v.slice(offset - d, offset + d + 1)); return backtrack(trace, n, m); }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return undefined;
}
function backtrack(trace: Int32Array[], n: number, m: number): DiffKind[] {
  const script: DiffKind[] = []; let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1]!, at = (k: number) => previous[k + d - 1]!, k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { script.push('same'); x--; y--; }
    if (down) { script.push('add'); y--; } else { script.push('del'); x--; }
  }
  while (x > 0 && y > 0) { script.push('same'); x--; y--; }
  return script.reverse();
}

export function diffLines(before = '', after = '', limits: { lines: number; edits: number } = DIFF_LIMITS): LineDiff {
  const old = splitLines(before), next = splitLines(after);
  const eol = eolOf(before) !== eolOf(after) && before && after ? { before: eolOf(before), after: eolOf(after) } : undefined;
  const bomBefore = before.startsWith('﻿'), bomAfter = after.startsWith('﻿');
  const notes = { ...(eol ? { eol } : {}), ...(bomBefore !== bomAfter && before && after ? { bom: { before: bomBefore, after: bomAfter } } : {}) };
  if (old.length + next.length > limits.lines) return { complete: false, lines: [], added: 0, removed: 0, ...notes };
  // Trim the shared head and tail; the edit search then only covers the changed middle.
  let head = 0; while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0; while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const ids = new Map<string, number>(), intern = (lines: string[]) => Int32Array.from(lines, line => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id); } return id; });
  const script = myers(intern(old.slice(head, old.length - tail)), intern(next.slice(head, next.length - tail)), limits.edits);
  if (!script) return { complete: false, lines: [], added: 0, removed: 0, ...notes };
  const lines: DiffLine[] = []; let o = 0, nw = 0, added = 0, removed = 0;
  const same = () => { lines.push({ kind: 'same', text: old[o]!, oldNo: o + 1, newNo: nw + 1 }); o++; nw++; };
  for (let i = 0; i < head; i++) same();
  for (const kind of script) {
    if (kind === 'same') same();
    else if (kind === 'del') { lines.push({ kind, text: old[o]!, oldNo: o + 1 }); o++; removed++; }
    else { lines.push({ kind, text: next[nw]!, newNo: nw + 1 }); nw++; added++; }
  }
  for (let i = 0; i < tail; i++) same();
  return { complete: true, lines, added, removed, ...notes };
}

export type DiffBlock = { kind: 'lines'; lines: DiffLine[] } | { kind: 'gap'; lines: DiffLine[] };
/** Changed lines with `context` unchanged lines around them; longer unchanged runs become collapsible gaps. */
export function diffBlocks(lines: readonly DiffLine[], context = 3): DiffBlock[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, i) => { if (line.kind !== 'same') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1; });
  const blocks: DiffBlock[] = [];
  for (let i = 0; i < lines.length;) {
    const kept = keep[i] === 1; let j = i; while (j < lines.length && (keep[j] === 1) === kept) j++;
    // A gap of one or two lines is cheaper to show than to collapse.
    const kind = kept || j - i <= 2 ? 'lines' : 'gap', slice = lines.slice(i, j), last = blocks.at(-1);
    if (kind === 'lines' && last?.kind === 'lines') last.lines.push(...slice); else blocks.push({ kind, lines: slice });
    i = j;
  }
  return blocks;
}

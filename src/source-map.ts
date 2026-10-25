import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

export interface SourceLocation { line: number; column: number; snippet: string }
export type SourceIndex = Record<string, SourceLocation>;
export const SOURCE_ATTRIBUTE = 'data-region-source';

/** Locations belong to the original file, before resource rewriting or browser tree repair. */
export function annotateHtml(source: string): { html: string; sources: SourceIndex } {
  if (new TextEncoder().encode(source).byteLength > 1024 * 1024) return { html: source, sources: {} };
  const doc = parse(source, { sourceCodeLocationInfo: true });
  const sources: SourceIndex = {};
  const pending: DefaultTreeAdapterMap['node'][] = [doc];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if ('childNodes' in node) for (const child of node.childNodes) pending.push(child);
    if (!('tagName' in node)) continue;
    node.attrs = node.attrs.filter(a => a.name !== SOURCE_ATTRIBUTE);
    const location = node.sourceCodeLocation?.startTag;
    if (!location || count >= 12000 || /^(?:script|style|template|noscript)$/.test(node.tagName)) continue;
    const key = `s${++count}`;
    node.attrs.push({ name: SOURCE_ATTRIBUTE, value: key });
    // The opening tag gives editable classes/attributes without copying an entire subtree.
    sources[key] = { line: location.startLine, column: location.startCol,
      snippet: /^(?:input|textarea|select)$/.test(node.tagName) ? '' : source.slice(location.startOffset, location.endOffset).slice(0, 700) };
  }
  return { html: serialize(doc), sources };
}

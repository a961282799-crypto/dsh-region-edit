/** Pure selector text helpers for matching nested and scoped rules; no DOM access. */
/** Split a selector list at top-level commas, ignoring commas inside parentheses, brackets and strings. */
export function selectorList(selector: string): string[] {
  const parts: string[] = []; let depth = 0, quote = '', start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}
/**
 * A nested selector as an absolute one (CSS Nesting): `&` stands for the parent, and a selector without `&` is a
 * descendant of it. Inside @scope, `:scope` stands for the scope root too.
 */
export function resolveSelector(selector: string, parent: string, scope = false): string {
  return selectorList(selector).map(part => {
    if (!part.includes('&') && !(scope && part.includes(':scope'))) return `:is(${parent}) ${part}`;
    const resolved = part.replaceAll('&', `:is(${parent})`);
    return scope ? resolved.replaceAll(':scope', `:is(${parent})`) : resolved;
  }).join(', ');
}

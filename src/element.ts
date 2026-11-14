import { collectRegion, elementSnapshot, selectorOf } from './selection.ts';
import type { Region, SelectedElement } from './selection.ts';
import { resolveSelector } from './css-selector.ts';

export const STYLE_KEYS = ['display', 'position', 'box-sizing', 'width', 'height', 'max-width', 'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border', 'border-radius',
  'gap', 'flex-direction', 'align-items', 'justify-content', 'grid-template-columns'] as const;
/** `condition`: the @container, @scope or @layer the rule sits in, or the interaction state it needs; reported, not evaluated. */
export interface StyleRule { selector: string; declarations: string; file?: string; condition?: string }
export interface ElementContext {
  classes: string; inlineStyle: string; styles: Record<string, string>; variables: Record<string, string>; rules: StyleRule[];
  parent?: { tag: string; selector: string; classes: string; styles: Record<string, string> };
}
const sourceKeys = new WeakMap<Element, string>();

/** Bind only unique initial markers, then remove them so later clones cannot inherit a location. */
export function rememberSources(doc: Document): void {
  const seen = new Map<string, Element[]>();
  for (const node of doc.querySelectorAll('[data-region-source]')) {
    const key = node.getAttribute('data-region-source')!;
    const nodes = seen.get(key) ?? []; nodes.push(node); seen.set(key, nodes);
    node.removeAttribute('data-region-source');
  }
  for (const [key, nodes] of seen) if (nodes.length === 1) sourceKeys.set(nodes[0]!, key);
}
function compact(value: string, limit = 300): string {
  return value.replace(/url\([\s\S]*?\)/gi, 'url([resource])').slice(0, limit);
}
function stylesOf(node: Element): Record<string, string> {
  const style = node.ownerDocument.defaultView!.getComputedStyle(node);
  return Object.fromEntries(STYLE_KEYS.map(key => [key, compact(style.getPropertyValue(key))]));
}
const RULE_RESULTS = 8, RULE_SCAN = 20000;
const INTERACTION = /:(?:hover|active|focus-visible|focus-within|focus)(?![\w-])/g;
/** Cheap pre-check before Element.matches: only false positives are allowed, never a missed rule. */
function candidateTest(node: Element): (selector: string) => boolean {
  const tokens = [node.localName, ...(node.id ? [`#${CSS.escape(node.id)}`] : []), ...[...node.classList].map(name => `.${CSS.escape(name)}`)].map(t => t.toLowerCase());
  return selector => { const text = selector.toLowerCase(); return /[*[:]/.test(text) || tokens.some(token => text.includes(token)); };
}
interface RuleContext {
  file?: string;
  /** Absolute selector of the enclosing style rule or scope start, and how the source writes the chain. */
  parent?: string; written?: string; scope?: boolean;
  /** A prelude-less @scope: rules apply inside this element. */
  root?: Element;
  conditions: string[];
}
/**
 * The last matching rules in cascade order. Sheets and rules are walked from the end, so author styles loaded
 * after a large framework (Bootstrap, Tailwind) are reached first, and the walk stops after 8 matches. Nested rules
 * come after their parent's own declarations, so they are visited first.
 */
function rulesOf(node: Element): StyleRule[] {
  const found: StyleRule[] = [];
  const view = node.ownerDocument.defaultView!, candidate = candidateTest(node);
  let visited = 0;
  const done = () => found.length >= RULE_RESULTS || visited > RULE_SCAN;
  const record = (selector: string, written: string, declarations: string, at: RuleContext) => {
    if (!declarations.trim() || !candidate(selector) || at.root && !at.root.contains(node)) return;
    // Whether the pointer happens to rest on the element must not decide what is reported: interaction states
    // count as possible, and the rule says which state it needs.
    const states = [...new Set(selector.match(INTERACTION) ?? [])];
    const conditions = states.length ? [...at.conditions, `交互状态 ${states.join(' ')}`] : at.conditions;
    try {
      if (node.matches(states.length ? selector.replace(INTERACTION, ':where(*)') : selector)) found.push({ selector: written.slice(0, 300), declarations: compact(declarations, 700),
        ...(at.file ? { file: at.file } : {}), ...(conditions.length ? { condition: conditions.join(' ').slice(0, 300) } : {}) });
    } catch { /* Unsupported selectors are not evidence of a match. */ }
  };
  const walk = (rules: CSSRuleList, at: RuleContext) => {
    for (let index = rules.length - 1; index >= 0 && !done(); index--) {
      const rule = rules[index]!, kind = rule.constructor.name; visited++;
      if (rule instanceof view.CSSStyleRule) {
        const written = at.written ? `${at.written} { ${rule.selectorText} }` : rule.selectorText;
        const absolute = at.parent ? resolveSelector(rule.selectorText, at.parent, at.scope) : at.root && rule.selectorText.includes(':scope') ? '' : rule.selectorText;
        if (!absolute) continue;
        if (rule.cssRules?.length) walk(rule.cssRules, { ...at, parent: absolute, written, scope: false });
        if (!done()) record(absolute, written, rule.style.cssText, at);
      } else if (kind === 'CSSNestedDeclarations' && at.parent) {
        // Declarations written after nested rules belong to the enclosing selector.
        record(at.parent, at.written ?? at.parent, (rule as CSSRule & { style: CSSStyleDeclaration }).style.cssText, at);
      } else if (rule instanceof view.CSSMediaRule) {
        if (view.matchMedia(rule.conditionText).matches) walk(rule.cssRules, at);
      } else if (rule instanceof view.CSSSupportsRule) {
        if (view.CSS.supports(rule.conditionText)) walk(rule.cssRules, at);
      } else if (rule instanceof view.CSSImportRule) {
        // Imported data URLs do not preserve a trustworthy source filename.
        if (rule.styleSheet && (!rule.media.mediaText || view.matchMedia(rule.media.mediaText).matches)) {
          try { walk(rule.styleSheet.cssRules, { conditions: at.conditions }); } catch { /* Unreadable sheet. */ }
        }
      } else if (kind === 'CSSContainerRule') {
        // Whether a container query holds depends on an ancestor's size; it is reported, not decided here.
        walk((rule as CSSGroupingRule).cssRules, { ...at, conditions: [...at.conditions, `@container ${(rule as CSSConditionRule).conditionText}`] });
      } else if (kind === 'CSSLayerBlockRule') {
        const name = (rule as CSSRule & { name: string }).name;
        walk((rule as CSSGroupingRule).cssRules, { ...at, conditions: [...at.conditions, name ? `@layer ${name}` : '@layer'] });
      } else if (kind === 'CSSScopeRule') {
        const scope = rule as CSSGroupingRule & { start: string | null; end: string | null };
        const condition = `@scope${scope.start ? ` (${scope.start})` : ''}${scope.end ? ` to (${scope.end})` : ''}`;
        const owner = rule.parentStyleSheet?.ownerNode;
        const inner: RuleContext = { ...at, conditions: [...at.conditions, condition] };
        if (scope.start) walk(scope.cssRules, { ...inner, parent: at.parent ? resolveSelector(scope.start, at.parent) : scope.start, written: condition, scope: true });
        else if (owner instanceof view.Element && owner.parentElement) walk(scope.cssRules, { ...inner, root: owner.parentElement, written: condition });
      }
    }
  };
  const sheets = [...node.ownerDocument.styleSheets];
  for (let index = sheets.length - 1; index >= 0 && !done(); index--) {
    const sheet = sheets[index]!;
    if (sheet.disabled || sheet.media.mediaText && !view.matchMedia(sheet.media.mediaText).matches) continue;
    const owner = sheet.ownerNode;
    const file = owner instanceof view.Element ? owner.getAttribute('data-region-stylesheet') ?? undefined : undefined;
    try { walk(sheet.cssRules, { ...(file ? { file } : {}), conditions: [] }); } catch { /* CSSOM access is optional. */ }
  }
  return found.reverse();
}
export function contextOf(node: Element): ElementContext {
  const classes = node.getAttribute('class')?.slice(0, 1000) ?? '';
  const inlineStyle = compact(node.getAttribute('style') ?? '', 700), rules = rulesOf(node);
  const referenced = [inlineStyle, ...rules.map(r => r.declarations)].join('\n');
  const computed = node.ownerDocument.defaultView!.getComputedStyle(node);
  const names = [...new Set([...referenced.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]!))].slice(0, 12);
  const parent = node.parentElement;
  return { classes, inlineStyle, styles: stylesOf(node), rules,
    variables: Object.fromEntries(names.map(key => [key, compact(computed.getPropertyValue(key), 160)])),
    ...(parent && parent !== node.ownerDocument.documentElement ? { parent: { tag: parent.localName,
      selector: selectorOf(parent, node.ownerDocument.documentElement), classes: parent.getAttribute('class')?.slice(0, 1000) ?? '', styles: stylesOf(parent) } } : {}) };
}
function enrich(element: SelectedElement, node: Element): SelectedElement {
  const sourceKey = sourceKeys.get(node);
  return { ...element, context: contextOf(node), ...(sourceKey ? { sourceKey } : {}) };
}
export function enrichRegion(region: Region, root: Element): Region {
  return { ...region, elements: region.elements.map((element, index) => {
    if (index >= 3) return element;
    try {
      const matches = root.ownerDocument.querySelectorAll(element.selector);
      return matches.length === 1 && root.contains(matches[0]!) ? enrich(element, matches[0]!) : element;
    } catch { return element; }
  }) };
}

/** Opaque handles retain identity across reflow; a replacement node never inherits the handle. */
export class ElementReader {
  private ids = new WeakMap<Element, string>();
  private nodes = new Map<string, WeakRef<Element>>();
  /** The node actually under the pointer at the last click; inner levels lead back toward it. */
  private deepest: WeakRef<Element> | undefined;
  constructor(private doc: Document) {}
  private id(node: Element): string {
    let id = this.ids.get(node);
    if (!id) {
      if (this.nodes.size >= 12000) throw new Error('已选择过多元素，请刷新预览。');
      id = `e${this.nodes.size + 1}`; this.ids.set(node, id); this.nodes.set(id, new WeakRef(node));
    }
    return id;
  }
  at(x: number, y: number, hover = false): Region {
    const hit = this.doc.elementFromPoint(x, y);
    if (!hit || hit === this.doc.documentElement) throw new Error('这里没有可选择的页面元素。');
    // Start at the control a click usually means; the parts inside stay reachable as inner levels.
    const node = hit.closest('button,a,[role="button"],label,svg') ?? hit;
    if (!hover) this.deepest = new WeakRef(hit);
    return this.readNode(node, hover);
  }
  /** The next visible element inside `node` on the path to the clicked node, if the click was inside it. */
  private inner(node: Element): Element | undefined {
    const deepest = this.deepest?.deref();
    if (!deepest?.isConnected || deepest === node || !node.contains(deepest)) return;
    const path: Element[] = [];
    for (let current: Element | null = deepest; current && current !== node; current = current.parentElement) path.unshift(current);
    return path.find(child => { const rect = child.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
  }
  read(id: string): Region {
    const node = this.nodes.get(id)?.deref();
    if (!node?.isConnected || node.ownerDocument !== this.doc) throw new Error('目标元素已被替换，请重新点选。');
    return this.readNode(node);
  }
  private readNode(node: Element, hover = false): Region {
    const rect = node.getBoundingClientRect(), view = this.doc.defaultView!;
    if (!rect.width || !rect.height || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) throw new Error('目标已隐藏，请重新点选。');
    const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const collected = hover ? undefined : collectRegion(node, box);
    const text = collected?.text || node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') || node.localName;
    const element = hover ? { tag: node.localName, selector: selectorOf(node, this.doc.documentElement), text: text.slice(0, 600), html: '' }
      : elementSnapshot(node, this.doc.documentElement, text);
    const parent = node.parentElement;
    // Hover only draws a box; handles are issued on click so browsing a large page cannot exhaust them.
    return { box, viewport: { width: view.innerWidth, height: view.innerHeight, scrollX: view.scrollX, scrollY: view.scrollY },
      text: text.slice(0, 6000), elements: [hover ? element : enrich(element, node)], truncated: !!collected?.truncated || text.length > 6000,
      ...(hover ? {} : { element: this.handles(node, parent) }) };
  }
  private handles(node: Element, parent: Element | null): NonNullable<Region['element']> {
    const child = this.inner(node);
    return { id: this.id(node), ...(parent && parent !== this.doc.documentElement ? { parentId: this.id(parent) } : {}), ...(child ? { childId: this.id(child) } : {}) };
  }
}

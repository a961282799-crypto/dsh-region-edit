import { collectRegion, elementSnapshot, selectorOf } from './selection.ts';
import type { Region, SelectedElement } from './selection.ts';

export const STYLE_KEYS = ['display', 'position', 'box-sizing', 'width', 'height', 'max-width', 'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border', 'border-radius',
  'gap', 'flex-direction', 'align-items', 'justify-content', 'grid-template-columns'] as const;
export interface StyleRule { selector: string; declarations: string; file?: string }
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
function rulesOf(node: Element): StyleRule[] {
  const result: StyleRule[] = [];
  const view = node.ownerDocument.defaultView!;
  let visited = 0;
  const walk = (rules: CSSRuleList, file?: string) => {
    for (const rule of rules) {
      if (++visited > 1000) return;
      if (rule instanceof view.CSSStyleRule) {
        try {
          if (node.matches(rule.selectorText)) {
            result.push({ selector: rule.selectorText.slice(0, 300), declarations: compact(rule.style.cssText, 700), ...(file ? { file } : {}) });
            if (result.length > 8) result.shift();
          }
        } catch { /* Unsupported selectors are not evidence of a match. */ }
      } else if (rule instanceof view.CSSMediaRule) {
        if (view.matchMedia(rule.conditionText).matches) walk(rule.cssRules, file);
      } else if (rule instanceof view.CSSSupportsRule) {
        if (view.CSS.supports(rule.conditionText)) walk(rule.cssRules, file);
      } else if (rule instanceof view.CSSImportRule) {
        // Imported data URLs do not preserve a trustworthy source filename.
        if (rule.styleSheet && (!rule.media.mediaText || view.matchMedia(rule.media.mediaText).matches)) {
          try { walk(rule.styleSheet.cssRules); } catch { /* Unreadable sheet. */ }
        }
      } else if (rule.constructor.name === 'CSSLayerBlockRule' && 'cssRules' in rule) {
        walk((rule as CSSGroupingRule).cssRules, file);
      }
    }
  };
  for (const sheet of node.ownerDocument.styleSheets) {
    if (visited > 1000) break;
    if (sheet.disabled || sheet.media.mediaText && !view.matchMedia(sheet.media.mediaText).matches) continue;
    const owner = sheet.ownerNode;
    const file = owner instanceof view.Element ? owner.getAttribute('data-region-stylesheet') ?? undefined : undefined;
    try { walk(sheet.cssRules, file); } catch { /* CSSOM access is optional. */ }
  }
  return result;
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
    let node = this.doc.elementFromPoint(x, y);
    if (!node || node === this.doc.documentElement) throw new Error('这里没有可选择的页面元素。');
    node = node.closest('button,a,[role="button"],label,svg') ?? node;
    return this.readNode(node, hover);
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
    return { box, viewport: { width: view.innerWidth, height: view.innerHeight, scrollX: view.scrollX, scrollY: view.scrollY },
      text: text.slice(0, 6000), elements: [hover ? element : enrich(element, node)], truncated: !!collected?.truncated || text.length > 6000,
      element: { id: this.id(node), ...(parent && parent !== this.doc.documentElement ? { parentId: this.id(parent) } : {}) } };
  }
}

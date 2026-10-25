import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { lasso, simplify } from './lasso.ts';
import type { Point } from './lasso.ts';
import type { Box, Region } from './selection.ts';
import type { Recognition } from './recognition.ts';
import { elementBox, pickElement, readRegion } from './bridge.ts';
import type { Selection } from './bridge.ts';
interface Picked { selection: Selection; region: Region; box: Box }
export interface PickProps {
  root: HTMLElement; path: string; signal: AbortSignal;
  instruction: string; hint: string;
  onInstructionChange(value: string): void;
  manualTarget: string | undefined;
  onManualTargetChange(value: string | undefined): void;
  onReselect(reason?: string): void;
  onClose(): void;
  onRecognize(region: Region, signal: AbortSignal): Promise<Recognition>;
  onSubmit(instruction: string, region: Region, draft: boolean, selection: Selection, target?: Recognition): Promise<void>;
}
export function RegionPicker({ root, path, signal, instruction, hint, onInstructionChange, manualTarget, onManualTargetChange, onReselect, onClose, onRecognize, onSubmit }: PickProps) {
  const layer = useRef<HTMLDivElement>(null), outline = useRef<SVGPathElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const targetInput = useRef<HTMLInputElement>(null), recognitionController = useRef<AbortController | undefined>(undefined), submitting = useRef(false);
  const drawing = useRef<Point[] | undefined>(undefined), recognize = useRef(onRecognize); recognize.current = onRecognize;
  const [picked, setPicked] = useState<Picked>();
  const html = /\.html?$/i.test(path);
  const [mode, setMode] = useState<'element' | 'lasso'>(html ? 'element' : 'lasso');
  const [hovered, setHovered] = useState<Picked>(), [parents, setParents] = useState<Picked[]>([]);
  const hovering = useRef(false), hoverVersion = useRef(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [target, setTarget] = useState<Recognition | undefined>(() => manualTarget === undefined ? undefined : userTarget(manualTarget));
  const [recognizing, setRecognizing] = useState(false), [recognitionError, setRecognitionError] = useState(''), [attempt, setAttempt] = useState(0);
  const [needsConfirmation, setNeedsConfirmation] = useState(!!manualTarget?.trim());
  const manual = useRef(manualTarget); manual.current = manualTarget;
  function userTarget(label: string): Recognition { return { label, kind: '', text: '', confidence: 1, ambiguous: false, source: 'user' }; }
  const bounds = root.getBoundingClientRect();
  useEffect(() => {
    const reset = () => { if (!submitting.current) onReselect('预览位置已变化，请重新圈选；已填写的修改要求会保留。'); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    const prevent = (event: WheelEvent) => { if (!(event.target instanceof Element && event.target.closest('.re-panel'))) event.preventDefault(); };
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', reset); root.addEventListener('scroll', reset, true);
    root.addEventListener('load', reset, true);
    const initial = root.getBoundingClientRect();
    const observer = new ResizeObserver(() => { const rect = root.getBoundingClientRect(); if (rect.width !== initial.width || rect.height !== initial.height) reset(); });
    observer.observe(root);
    layer.current?.addEventListener('wheel', prevent, { passive: false });
    const overlay = layer.current;
    return () => { document.removeEventListener('keydown', key, true); window.removeEventListener('resize', reset); observer.disconnect();
      root.removeEventListener('scroll', reset, true); root.removeEventListener('load', reset, true);
      overlay?.removeEventListener('wheel', prevent); };
  }, [root, onReselect, onClose]);
  useEffect(() => {
    if (!picked) return;
    input.current?.focus();
    if (manual.current !== undefined) { setTarget(userTarget(manual.current)); setRecognizing(false); setRecognitionError(''); return; }
    const controller = new AbortController(), requestSignal = AbortSignal.any([signal, controller.signal]);
    recognitionController.current = controller;
    setRecognizing(true); setRecognitionError(''); setTarget(undefined);
    void recognize.current(picked.region, requestSignal).then(result => { if (!requestSignal.aborted) setTarget(result); })
      .catch(error => { if (!requestSignal.aborted) setRecognitionError((error as Error).message); })
      .finally(() => { if (!requestSignal.aborted) setRecognizing(false); });
    return () => { controller.abort(); if (recognitionController.current === controller) recognitionController.current = undefined; };
  }, [picked, attempt, signal]);
  function stopRecognition() {
    recognitionController.current?.abort(); setRecognizing(false); setRecognitionError('');
    onManualTargetChange(target?.label ?? ''); setNeedsConfirmation(false);
    requestAnimationFrame(() => targetInput.current?.focus());
  }
  function point(event: { clientX: number; clientY: number }): Point {
    return { x: Math.max(bounds.left, Math.min(bounds.right, event.clientX)), y: Math.max(bounds.top, Math.min(bounds.bottom, event.clientY)) };
  }
  function draw(points: readonly Point[], close = false) {
    outline.current?.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${p.x - bounds.left},${p.y - bounds.top}`).join(' ') + (close ? ' Z' : ''));
  }
  function drawBox(box: Box) {
    draw([{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }], true);
  }
  async function hoverAt(x: number, y: number) {
    if (hovering.current || picked || busy) return;
    hovering.current = true; const version = ++hoverVersion.current;
    try {
      const value = await pickElement(root, x, y, signal, true);
      if (!signal.aborted && version === hoverVersion.current) { setHovered(value); drawBox(value.box); }
    } catch { if (!signal.aborted && version === hoverVersion.current) { setHovered(undefined); draw([]); } }
    finally { hovering.current = false; }
  }
  async function chooseAt(x: number, y: number) {
    hoverVersion.current++; setHovered(undefined); setBusy(true); setError('');
    try {
      const value = await pickElement(root, x, y, signal); signal.throwIfAborted();
      drawBox(value.box); setPicked(value);
    } catch (error) { if (!signal.aborted) setError((error as Error).message); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function changeLevel(back: boolean) {
    if (!picked || !('kind' in picked.selection)) return;
    const previous = back ? parents.at(-1) : undefined;
    const elementId = previous && 'kind' in previous.selection ? previous.selection.elementId : picked.region.element?.parentId;
    if (!elementId) return;
    setBusy(true); setError('');
    try {
      const selection = { ...picked.selection, elementId };
      const region = await readRegion(root, selection, signal); signal.throwIfAborted();
      const box = elementBox(selection, region);
      onManualTargetChange(undefined); setNeedsConfirmation(false);
      setParents(stack => back ? stack.slice(0, -1) : [...stack, picked]);
      setPicked({ selection, region, box }); drawBox(box);
    } catch (error) { if (!signal.aborted) setError((error as Error).message); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  function move(event: React.PointerEvent) {
    if (mode === 'element') { if (event.target === event.currentTarget) void hoverAt(event.clientX, event.clientY); return; }
    if (!drawing.current) return;
    const samples = event.nativeEvent.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [event]) {
      const p = point(sample), last = drawing.current.at(-1)!;
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.2) drawing.current.push(p);
    }
    if (drawing.current.length > 4096) drawing.current = simplify(drawing.current, 1.2);
    draw(drawing.current);
  }
  async function finish(event: React.PointerEvent<HTMLDivElement>) {
    if (mode === 'element') return;
    if (!drawing.current || picked) return;
    const points = [...drawing.current, point(event)]; drawing.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setBusy(true); setError('');
    try {
      const selection = lasso(points); draw(selection.points, true);
      const region = await readRegion(root, selection, signal); signal.throwIfAborted();
      if (!region.image && !region.text.trim() && !region.elements.length) throw new Error('这块区域没有可读取的文字或元素，请重新圈选。');
      setPicked({ selection, region, box: selection.box });
    } catch (error) { if (!signal.aborted) setError((error as Error).message); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function submit(draft: boolean) {
    if (!picked || !instruction.trim() || busy || recognizing || needsConfirmation) return;
    setBusy(true); setError(''); submitting.current = true;
    try { await onSubmit(instruction, picked.region, draft, picked.selection, target); if (!signal.aborted) onClose(); }
    catch (error) { if (!signal.aborted) { setError((error as Error).message); setBusy(false); } }
    finally { submitting.current = false; }
  }
  const width = Math.min(380, innerWidth - 24), box = picked?.box;
  const left = Math.max(12, Math.min(innerWidth - width - 12, box?.x ?? bounds.left));
  const top = box ? Math.max(12, Math.min(innerHeight - 430, box.y + box.height + 12)) : 0;
  return createPortal(<div ref={layer} className={`re-layer${picked ? ' re-picked' : ''}`} data-region-ui="" style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
    onPointerDown={event => { if (picked || busy || event.button !== 0 || event.target !== event.currentTarget) return;
      if (mode === 'element') { event.preventDefault(); void chooseAt(event.clientX, event.clientY); return; }
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drawing.current = [point(event)]; setError(''); draw(drawing.current); }}
    onPointerMove={move} onPointerUp={event => { void finish(event); }}
    onPointerLeave={() => { if (mode === 'element' && !picked) { hoverVersion.current++; setHovered(undefined); draw([]); } }}
    onPointerCancel={() => { hoverVersion.current++; drawing.current = undefined; draw([]); }}>
    <svg className="re-lasso" aria-label="自由圈选轮廓"><path ref={outline} fillRule="evenodd" /></svg>
    {!picked && <div className="re-instruction"><div role="status">{busy ? '正在读取选区…' : error || hint || (mode === 'element' ? hovered ? `点击选择 ${hovered.region.elements[0]?.tag ?? '元素'}` : '移到目标上查看边框，点击选择' : '按住鼠标画一圈，松开后自动闭合')}
      {html && <div className="re-modes" role="group" aria-label="选择方式">{(['element', 'lasso'] as const).map(value => <button key={value} type="button" disabled={busy} aria-pressed={mode === value}
        onClick={() => { hoverVersion.current++; drawing.current = undefined; setMode(value); setHovered(undefined); setError(''); draw([]); }}>{value === 'element' ? '点选元素' : '自由圈选'}</button>)}</div>}
      </div><button type="button" onClick={onClose}>取消</button></div>}
    {picked && <form className="re-panel" role="dialog" aria-label="修改选中区域" style={{ left, top, width, maxHeight: Math.max(100, innerHeight - top - 12) }} onSubmit={event => { event.preventDefault(); void submit(false); }}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(false); }
        if (event.key === 'Tab') {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),summary')].filter(n => n.getClientRects().length);
          const index = items.indexOf(document.activeElement as HTMLElement);
          if (event.shiftKey && index === 0) { event.preventDefault(); items.at(-1)?.focus(); }
          else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
        }
      }}>
      <div className="re-panel-heading"><strong>修改选中区域</strong><button type="button" className="re-close" aria-label="取消圈选" onClick={onClose}>×</button></div>
      <div className="re-file" title={path}>{path.split(/[\\/]/).pop()}</div>
      <blockquote className="re-quote">{picked.region.image
        ? '已自由圈选图片区域'
        : picked.region.text.slice(0, 120) || picked.region.elements[0]?.text}</blockquote>
      {picked.region.element && <div className="re-levels" role="group" aria-label="调整选择范围">
        <button type="button" disabled={busy || !picked.region.element.parentId} onClick={() => { void changeLevel(false); }}>选择外层</button>
        <button type="button" disabled={busy || !parents.length} onClick={() => { void changeLevel(true); }}>返回内层</button>
      </div>}
      <div className="re-recognition" aria-busy={recognizing}>
        <div className="re-recognition-status" role="status">{recognizing ? picked.region.element ? '正在读取页面元素…' : '正在用当前模型识别圈中对象…' : needsConfirmation ? '已保留原目标，请确认新选区' : target?.source === 'user' && target.label.trim() ? '已采用你指定的目标' : target?.source === 'document' ? picked.region.element ? '已定位页面元素' : '已定位圈内文字与元素' : target?.source === 'vision' ? '视觉识别完成' : '可自行填写圈中目标'}
          {recognizing ? <button type="button" disabled={busy} onClick={stopRecognition}>停止识别，手动指定</button>
            : !picked.region.element && <button type="button" disabled={busy} onClick={() => { onManualTargetChange(undefined); setNeedsConfirmation(false); setAttempt(n => n + 1); }}>重新识别</button>}</div>
        <label className="re-label" htmlFor="re-target">{picked.region.element ? '选中的目标' : '圈中的目标'}</label>
        <input ref={targetInput} id="re-target" maxLength={120} value={target?.label ?? ''} disabled={busy || recognizing} placeholder={picked.region.element ? '例如：开始使用按钮' : '例如：海报上方的标题'} onChange={event => { setTarget(userTarget(event.target.value)); onManualTargetChange(event.target.value); setNeedsConfirmation(false); }} />
        {needsConfirmation && <p className="re-hint">名称来自上次圈选，也可以直接修改。 <button type="button" disabled={busy} onClick={() => setNeedsConfirmation(false)}>确认沿用此目标</button></p>}
        {target?.source === 'vision' && (target.ambiguous || target.confidence < .7) && <p className="re-hint">识别存在歧义，请确认或修改目标名称。</p>}
        {recognitionError && <p className="re-error" role="alert">{recognitionError}</p>}
      </div>
      <label className="re-label" htmlFor="re-instruction">想把这里改成什么样？</label>
      <textarea ref={input} id="re-instruction" value={instruction} disabled={busy} maxLength={4000} placeholder="例如：缩小标题，改成深灰色，增加下方留白。" onChange={event => onInstructionChange(event.target.value)} />
      {html && <LocationDetails region={picked.region} path={path} />}
      {error && <p className="re-error" role="alert">{error}</p>}
      <div className="re-actions"><button type="button" disabled={busy} onClick={() => onReselect()}>重选</button>
        <span /><button type="button" disabled={busy || recognizing || needsConfirmation || !instruction.trim()} onClick={() => { void submit(true); }}>放入输入框</button>
        <button className="re-primary" type="submit" disabled={busy || recognizing || needsConfirmation || !instruction.trim()}>{busy ? '正在发送…' : '发送修改'}</button></div>
    </form>}
  </div>, document.body);
}

function LocationDetails({ region, path }: { region: Region; path: string }) {
  const element = region.elements[0];
  if (!element) return null;
  const context = element.context;
  return <details className="re-location" data-region-location=""><summary>定位信息{element.source ? ` · 第 ${element.source.line} 行` : ''}</summary>
    {element.source ? <><p>{path.split(/[\\/]/).pop()} · 第 {element.source.line} 行，第 {element.source.column} 列</p><pre>{element.source.snippet}</pre></>
      : <p>未确认源码位置；将提供元素结构和样式供定位。运行脚本的页面暂不提供精确行号。</p>}
    <p><strong>元素</strong> <code>{element.selector}</code></p>
    {context && <>
      <p><strong>class</strong> <code>{context.classes || '无'}</code></p>
      <dl>{Object.entries(context.styles).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      {!!Object.keys(context.variables).length && <><p>沿用的样式变量</p><pre>{Object.entries(context.variables).map(([key, value]) => `${key}: ${value}`).join('\n')}</pre></>}
      {context.parent && <p><strong>外层布局</strong> <code>{context.parent.selector}</code> · {context.parent.styles.display}</p>}
      {context.rules.map((rule, index) => <div key={index}><p>{rule.file || '内嵌或导入样式（未映射文件）'}</p><pre>{rule.selector}{' {\n'}{rule.declarations}{'\n}'}</pre></div>)}
      <p>样式为当前视口的计算结果；匹配规则用于辅助定位，不代表唯一生效来源。</p>
    </>}
  </details>;
}

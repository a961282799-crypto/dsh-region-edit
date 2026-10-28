import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { htmlDocument } from './html-document.ts';
import { diffBlocks, diffLines } from './diff.ts';
import type { DiffLine } from './diff.ts';
import type { ChangeApi, ChangeDetail, ChangeSummary, ChangeText, PreviewSnapshot } from './changes.ts';

/** Frozen contents never change once present, so each record side crosses the RPC channel once per panel. */
export class ContentCache {
  private entries = new Map<string, Promise<unknown>>();
  get<T>(id: string, part: string, load: () => Promise<T>): Promise<T> {
    const key = `${id}\n${part}`; let entry = this.entries.get(key) as Promise<T> | undefined;
    if (!entry) { entry = load(); this.entries.set(key, entry); entry.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); }); }
    return entry;
  }
  /** Drop contents of records the server no longer lists. */
  retain(ids: readonly string[]) { for (const key of this.entries.keys()) if (!ids.includes(key.slice(0, key.indexOf('\n')))) this.entries.delete(key); }
}
/** Encoded preview pages per frozen snapshot object; rebuilt only for a snapshot not seen before. */
const pages = new WeakMap<PreviewSnapshot, Promise<string>>();
function frozenPage(snapshot: PreviewSnapshot): Promise<string> {
  let page = pages.get(snapshot);
  if (!page) {
    page = htmlDocument(snapshot.source, '', false, async reference => {
      const asset = snapshot.assets.find(a => a.reference === reference);
      if (!asset) throw new Error(`记录中没有关联文件：${reference}`);
      return { data: new Uint8Array(asset.data) };
    }, new AbortController().signal).then(result => result.html);
    pages.set(snapshot, page); page.catch(() => pages.delete(snapshot));
  }
  return page;
}
/** Resolve a cached request for the current key; stale answers after a key change are ignored. */
function useContent<T>(key: string | undefined, load: (() => Promise<T>) | undefined): { value?: T; error: string } {
  const [state, setState] = useState<{ key?: string; value?: T; error: string }>({ error: '' });
  useEffect(() => {
    if (!key || !load) return;
    let live = true;
    load().then(value => { if (live) setState({ key, value, error: '' }); }, (error: Error) => { if (live) setState({ key, error: String(error?.message ?? error) }); });
    return () => { live = false; };
    // The loader is keyed: a new closure with the same key reads the same cached content.
  }, [key]);
  return state.key === key && key ? state : { error: '' };
}

const SIGN = { same: ' ', add: '+', del: '-' } as const, SPOKEN = { same: '', add: '新增：', del: '删除：' } as const;
function DiffRow({ line }: { line: DiffLine }) {
  return <div className={`re-diff-line re-diff-${line.kind}`}><span className="re-diff-no">{line.oldNo ?? ''}</span><span className="re-diff-no">{line.newNo ?? ''}</span>
    <span className="re-diff-sign" aria-hidden="true">{SIGN[line.kind]}</span><code><span className="re-sr">{SPOKEN[line.kind]}</span>{line.text}</code></div>;
}
/** Unified line diff; unchanged runs collapse to an expandable gap. Very large rewrites fall back to the two full texts. */
function TextDiff({ text }: { text: ChangeText }) {
  const diff = useMemo(() => diffLines(text.before, text.after), [text]);
  const blocks = useMemo(() => diffBlocks(diff.lines), [diff]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setOpen(new Set()), [text]);
  const notes = [text.before === undefined && '新建的文件', text.after === undefined && '文件已删除',
    diff.eol && `换行符：${diff.eol.before} → ${diff.eol.after}`, diff.bom && `BOM：${diff.bom.before ? '有' : '无'} → ${diff.bom.after ? '有' : '无'}`].filter(Boolean).join(' · ');
  if (!diff.complete) return <>
    <p className="re-diff-note re-diff-wide">改动范围过大，未逐行比较，下面显示完整的前后内容。{notes && ` ${notes}`}</p>
    <section className="re-compare-side"><h3>修改前</h3><pre>{text.before ?? '文件不存在'}</pre></section>
    <section className="re-compare-side"><h3>修改后</h3><pre>{text.after ?? '文件不存在'}</pre></section>
  </>;
  return <section className="re-compare-side re-diff-wide" aria-label="逐行改动">
    <h3><span className="re-diff-count re-diff-add">+{diff.added}</span> <span className="re-diff-count re-diff-del">−{diff.removed}</span>{notes && <span className="re-diff-meta"> · {notes}</span>}</h3>
    <div className="re-diff">{!diff.added && !diff.removed ? <p className="re-diff-note">文字内容相同{notes ? '，仅上述格式不同。' : '。'}</p>
      : blocks.map((block, index) => block.kind === 'lines' || open.has(index)
        ? block.lines.map(line => <DiffRow key={`${line.oldNo ?? ''}:${line.newNo ?? ''}:${line.kind}`} line={line} />)
        : <button key={`gap-${index}`} type="button" className="re-diff-gap" onClick={() => setOpen(previous => new Set(previous).add(index))}>
          展开未改动的 {block.lines.length} 行（第 {block.lines[0]!.oldNo}–{block.lines.at(-1)!.oldNo} 行）</button>)}</div>
  </section>;
}

/** Time alone for today's records; older ones also show the date. */
function when(time: number) {
  const date = new Date(time), today = new Date();
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString() : date.toLocaleString();
}
const labels: Record<ChangeSummary['state'], string> = { prepared: '等待开始', running: '正在修改', finishing: '正在保存对比', ready: '修改已结束', restored: '已回滚', failed: '记录未完成' };
function FrozenPreview({ snapshot, loadError, placeholder, title }: { snapshot?: PreviewSnapshot; loadError: string; placeholder: string; title: string }) {
  const [page, setPage] = useState<{ snapshot?: PreviewSnapshot; html?: string; error?: string }>({});
  useEffect(() => {
    if (!snapshot || snapshot.error) return;
    let live = true;
    frozenPage(snapshot).then(html => { if (live) setPage({ snapshot, html }); }, (error: Error) => { if (live) setPage({ snapshot, error: String(error?.message ?? error) }); });
    return () => { live = false; };
  }, [snapshot]);
  const current = page.snapshot === snapshot ? page : {};
  const error = loadError || snapshot?.error || current.error;
  return <section className="re-compare-side"><h3>{title}</h3>
    {error ? <p role="alert">{error}</p> : current.html
      ? <iframe title={title} sandbox="" srcDoc={current.html} /> : <p>{snapshot ? '正在载入…' : placeholder}</p>}
  </section>;
}
function HistoryDialog({ api, cache, records, loadError, refresh, onClose }: { api: ChangeApi; cache: ContentCache; records: ChangeSummary[]; loadError: string; refresh(): void; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null), controller = useRef(new AbortController());
  const [id, setId] = useState(records[0]?.id ?? ''), [detail, setDetail] = useState<ChangeDetail>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const [view, setView] = useState<'preview' | 'text'>('preview'), [textIndex, setTextIndex] = useState(0);
  const record = records.find(r => r.id === id), revision = JSON.stringify(record);
  useEffect(() => { if (!records.some(r => r.id === id)) setId(records[0]?.id ?? ''); }, [records, id]);
  useEffect(() => {
    const abort = new AbortController(); setConfirmRemove(false); setError('');
    if (!id) { setDetail(undefined); return; }
    void api.detail(id, abort.signal).then(value => { if (!abort.signal.aborted) setDetail(value); })
      .catch(e => { if (!abort.signal.aborted) setError(String(e.message ?? e)); });
    return () => abort.abort();
  }, [api, id, revision]);
  useEffect(() => {
    controller.current = new AbortController();
    const previous = document.activeElement; panel.current?.focus();
    return () => { controller.current.abort(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  async function act(remove: boolean) {
    setBusy(true); setError('');
    try {
      if (remove) { await api.remove(id, controller.current.signal); setDetail(undefined); panel.current?.focus(); }
      else { const result = await api.restore(id, controller.current.signal); setDetail(await api.detail(id, controller.current.signal)); if (result.error) setError(result.error); }
      refresh();
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); setConfirmRemove(false); }
  }
  const selected = detail?.id === id ? detail : undefined;
  const hasAfter = !!selected?.snapshots.after, waiting = !!selected && ['prepared', 'running', 'finishing'].includes(selected.state);
  const before = useContent<PreviewSnapshot>(selected ? `${id}:before` : undefined, () => cache.get(id, 'before', () => api.snapshot(id, 'before', controller.current.signal)));
  const after = useContent<PreviewSnapshot>(hasAfter ? `${id}:after` : undefined, () => cache.get(id, 'after', () => api.snapshot(id, 'after', controller.current.signal)));
  const textContent = useContent<ChangeText[]>(hasAfter && view === 'text' ? `${id}:texts` : undefined, () => cache.get(id, 'texts', () => api.texts(id, controller.current.signal)));
  const texts = textContent.value ?? [];
  const blocked = !selected || selected.state !== 'ready' || !selected.files.length || !!selected.problems.length || selected.files.some(f => f.problem);
  const text = texts[textIndex] ?? texts[0];
  return createPortal(<div className="re-history-backdrop" data-region-edit=""><div className="re-history-dialog" role="dialog" aria-modal="true" aria-labelledby="re-history-title" tabIndex={-1} ref={panel}
    onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,[tabindex="0"]') ?? [])];
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header><div><h2 id="re-history-title">修改记录</h2><p>保存在本机，重启后仍可查看和回滚 · 静态预览保留当时的样式和图片</p></div><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
    {loadError && <p role="alert" className="re-inline-error">{loadError}</p>}
    {records.length === 0 ? <p className="re-history-empty">还没有修改记录。从本地 HTML 预览发起修改后，会自动保存前后对比。</p> : <>
      <div className="re-history-tools"><label>选择记录 <select value={id} disabled={busy} onChange={event => { setDetail(undefined); setId(event.target.value); setTextIndex(0); }}>
        {records.map(r => <option key={r.id} value={r.id}>{when(r.created)} · {labels[r.state]} · {r.instruction.slice(0, 32)}</option>)}
      </select></label><span role="status">{record && labels[record.state]}</span></div>
      {selected && <>
        <p className="re-history-request">{selected.instruction}</p>
        <p className="re-history-path">{selected.path}</p>
        {selected.state === 'prepared' && <p>要求还未进入模型执行阶段。若先放入输入框，请发送后等待；不再修改时可移除这条记录；在这个会话发起新的修改也会自动替换它。</p>}
        {selected.state === 'ready' && !selected.files.length && !selected.problems.length && <p>这轮没有检测到文件内容变化。</p>}
        <div className="re-history-tools"><div className="re-modes"><button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>前后预览</button><button type="button" aria-pressed={view === 'text'} onClick={() => setView('text')}>文件内容</button></div>
          {view === 'text' && !!texts.length && <select aria-label="对比文件" value={textIndex} onChange={event => setTextIndex(Number(event.target.value))}>{texts.map((t, i) => <option key={t.path} value={i}>{t.path}</option>)}</select>}
        </div>
        <div className="re-comparison">
          {view === 'preview' ? <><FrozenPreview title="修改前" placeholder="正在载入…" loadError={before.error} {...(before.value ? { snapshot: before.value } : {})} />
            <FrozenPreview title={selected.state === 'restored' ? '本轮修改后（已回滚）' : '修改后'} placeholder={hasAfter ? '正在载入…' : waiting ? '本轮结束后显示修改结果。' : '这条记录没有保存修改结果。'} loadError={after.error} {...(after.value ? { snapshot: after.value } : {})} /></>
            : textContent.error ? <p role="alert">{textContent.error}</p>
            : !hasAfter ? <p className="re-diff-note re-diff-wide">{waiting ? '本轮结束后显示文件内容。' : '这条记录没有保存修改结果。'}</p>
            : !textContent.value ? <p className="re-diff-note re-diff-wide">正在载入…</p>
            : text ? <TextDiff key={text.path} text={text} /> : <p className="re-diff-note re-diff-wide">没有可逐行对比的文字文件；二进制文件请查看前后预览。</p>}
        </div>
        <details className="re-history-files" open={!!selected.problems.length || selected.files.some(f => f.problem)}><summary>受影响文件（{selected.files.length}）</summary>
          <ul>{selected.files.map(f => <li key={f.path}>{f.path} {f.restored ? '· 已恢复' : f.problem ? `· ${f.problem}` : '· 可恢复'}</li>)}</ul>
          {selected.problems.map(p => <p key={p}>{p}</p>)}
        </details>
        {selected.error && !error && <p className="re-inline-error" role="alert">{selected.error}</p>}
        {selected.notice && <p className="re-history-notice" role="status">{selected.notice}</p>}
        <footer><p>回滚前核对全部文件。文件有后续修改时会停止；多文件写入若中断，会标出已恢复的文件。</p><div>
          <button type="button" disabled={busy || ['running', 'finishing'].includes(selected.state)} onClick={() => confirmRemove ? void act(true) : setConfirmRemove(true)}>{confirmRemove ? '确认移除记录（不改文件）' : '移除记录'}</button>
          <button className="re-primary" type="button" disabled={busy || blocked} onClick={() => void act(false)}>{busy ? '处理中…' : selected.state === 'restored' ? '已回滚' : `回滚本次修改${selected.files.length ? `（${selected.files.length} 个文件）` : ''}`}</button>
        </div></footer>
      </>}
    </>}
    {error && <p className="re-inline-error" role="alert">{error}</p>}
  </div></div>, document.body);
}
export function HistoryAction({ api, revision }: { api: ChangeApi; revision: number }) {
  const [records, setRecords] = useState<ChangeSummary[]>([]), [open, setOpen] = useState(false), [tick, setTick] = useState(0), [error, setError] = useState('');
  const cache = useRef(new ContentCache()).current;
  useEffect(() => cache.retain(records.map(r => r.id)), [cache, records]);
  const active = records.some(r => ['prepared', 'running', 'finishing'].includes(r.state));
  useEffect(() => {
    const abort = new AbortController();
    void api.list(abort.signal).then(value => { if (!abort.signal.aborted) { setRecords(value); setError(''); } }).catch(e => { if (!abort.signal.aborted) setError(String(e.message ?? e)); });
    return () => abort.abort();
  }, [api, revision, tick, open]);
  useEffect(() => { if (!active && !open) return; const timer = window.setInterval(() => setTick(n => n + 1), 2000); return () => clearInterval(timer); }, [active, open]);
  return <><button type="button" className="re-tool" onClick={() => setOpen(true)} title={error || '查看修改前后效果并安全回滚'}>修改记录{records.length ? ` · ${records.length}` : ''}</button>
    {open && <HistoryDialog api={api} cache={cache} records={records} loadError={error} refresh={() => setTick(n => n + 1)} onClose={() => setOpen(false)} />}</>;
}

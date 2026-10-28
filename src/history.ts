import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { rewriteCssAssets } from './css-assets.ts';
import { PREVIEW_LIMITS, cssResource, imageSourceMime, isStylesheetLink, resolveReference } from './resources.ts';
import { changeMarker } from './changes.ts';
import type { ChangeSummary, ChangeDetail, ChangeText, ChangePart, PreviewSnapshot } from './changes.ts';
import type { HistoryStore } from './history-store.ts';

export interface FsTarget { targetKey: string; displayPath: string }
export interface FsInfo { type: string; version: string; size: number }
export interface HistoryFs {
  resolve(path: string, options: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  contains(root: FsTarget, target: FsTarget): boolean;
  processPath(target: FsTarget): string;
  stat(target: FsTarget, signal: AbortSignal): Promise<FsInfo | undefined>;
  readBytes(target: FsTarget, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>;
  writeText(target: FsTarget, text: string, expected: { kind: 'replaceIfVersion'; version: string } | { kind: 'createIfAbsent' }, signal: AbortSignal, policy: unknown): Promise<unknown>;
}
export interface HistorySession { id: string; header: { cwd?: string } }
export interface HistoryHost {
  fs: HistoryFs;
  sandboxPolicy: { resolve(input: { session: HistorySession }): unknown };
  sessionProjections: { stateOf(session: HistorySession, key: string): unknown };
  workspaceChanges: { summary(sessionId: string, seq: number): { files: { path: string; oldPath?: string }[]; total: number } | undefined };
}
interface FileCopy { target: FsTarget; path: string; data?: Uint8Array; version?: string }
/** `changed` is settled once in finish(): list polling must not byte-compare every file on each request. */
interface Pair { before: FileCopy; after?: FileCopy; changed: boolean; restored: boolean; problem?: string }
interface RecordEntry {
  summary: ChangeSummary; session: HistorySession; root: FsTarget; pairs: Map<string, Pair>;
  before: PreviewSnapshot; after?: PreviewSnapshot; turn?: number; seq?: number;
  checked: boolean; busy: boolean; bytes: number; chain: Promise<void>;
  /** Loaded from local storage after a restart; version tokens from the previous run are not comparable. */
  reloaded?: boolean; saving?: Promise<void>;
}
const MAX_FILE = 4 * 1024 * 1024, MAX_BYTES = 16 * 1024 * 1024, MAX_FILES = 33;
const MAX_RECORDS = 8, BUDGET = 64 * 1024 * 1024, KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const FINISHED: readonly ChangeSummary['state'][] = ['ready', 'restored', 'failed'];
const decode = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
const same = (a?: Uint8Array, b?: Uint8Array) => a === b || !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);
const textOf = (file: FileCopy) => { if (!file.data || file.data.includes(0)) throw new Error('不是可恢复的 UTF-8 文本'); return decode(file.data); };
const directory = (path: string) => path.replaceAll('\\', '/').replace(/\/[^/]*$/, '/');
const messageText = (data: unknown): string => {
  const message = data as { content?: { type?: string; text?: string }[] };
  return Array.isArray(message?.content) ? message.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
};

/** Serializable form of a finished record; Uint8Array leaves are file contents (the store keeps them as blobs). */
function storedRecord(r: RecordEntry) {
  const file = (f: FileCopy) => ({ targetKey: f.target.targetKey, displayPath: f.target.displayPath, path: f.path, data: f.data, version: f.version });
  const { files: _files, notice: _notice, ...summary } = r.summary;
  return { format: 1, summary, session: { id: r.session.id, cwd: r.session.header.cwd }, root: r.root,
    pairs: [...r.pairs.values()].map(p => ({ before: file(p.before), after: p.after && file(p.after), changed: p.changed, restored: p.restored, problem: p.problem })),
    before: r.before, after: r.after };
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const optional = <T>(value: unknown, test: (value: unknown) => value is T): value is T | undefined => value === undefined || test(value);
function reviveFile(value: unknown): FileCopy | undefined {
  if (!isObject(value) || !isText(value.targetKey) || !isText(value.displayPath) || !isText(value.path)
    || !optional(value.data, (v): v is Uint8Array => v instanceof Uint8Array) || !optional(value.version, (v): v is string => isText(v, 1000))) return;
  return { target: { targetKey: value.targetKey, displayPath: value.displayPath }, path: value.path,
    ...(value.data ? { data: value.data as Uint8Array } : {}), ...(value.version !== undefined ? { version: value.version as string } : {}) };
}
function reviveSnapshot(value: unknown): PreviewSnapshot | undefined {
  if (!isObject(value) || !isText(value.source, 2 * 1024 * 1024) || !Array.isArray(value.assets) || value.assets.length > PREVIEW_LIMITS.files
    || !value.assets.every(a => isObject(a) && isText(a.reference) && a.data instanceof Uint8Array) || !optional(value.error, (v): v is string => isText(v))) return;
  return { source: value.source, assets: (value.assets as { reference: string; data: Uint8Array }[]).map(a => ({ reference: a.reference, data: a.data })), ...(value.error ? { error: value.error as string } : {}) };
}
/** Data read from disk is untrusted: every field is checked, and anything unexpected drops the whole record. */
function reviveRecord(id: string, value: unknown): RecordEntry | undefined {
  if (!isObject(value) || value.format !== 1 || !isObject(value.summary) || !isObject(value.session) || !isObject(value.root) || !Array.isArray(value.pairs)) return;
  const s = value.summary, session = value.session, root = value.root;
  if (s.id !== id || !isText(s.path) || !isText(s.instruction, 6000) || typeof s.created !== 'number' || !FINISHED.includes(s.state as ChangeSummary['state'])
    || !Array.isArray(s.problems) || s.problems.length > 100 || !s.problems.every(p => isText(p)) || !optional(s.error, (v): v is string => isText(v))
    || !optional(s.finished, (v): v is number => typeof v === 'number') || !isText(session.id, 200) || !isText(session.cwd) || !isText(root.targetKey) || !isText(root.displayPath)
    || value.pairs.length > MAX_FILES * 2) return;
  const before = reviveSnapshot(value.before), after = value.after === undefined ? undefined : reviveSnapshot(value.after);
  if (!before || (value.after !== undefined && !after)) return;
  const pairs = new Map<string, Pair>(); let bytes = 0;
  for (const raw of value.pairs) {
    if (!isObject(raw) || typeof raw.changed !== 'boolean' || typeof raw.restored !== 'boolean' || !optional(raw.problem, (v): v is string => isText(v))) return;
    const first = reviveFile(raw.before), last = raw.after === undefined ? undefined : reviveFile(raw.after);
    if (!first || (raw.after !== undefined && !last)) return;
    bytes += (first.data?.byteLength ?? 0) + (last?.data?.byteLength ?? 0);
    pairs.set(first.target.targetKey, { before: first, ...(last ? { after: last } : {}), changed: raw.changed, restored: raw.restored, ...(raw.problem ? { problem: raw.problem as string } : {}) });
  }
  const summary: ChangeSummary = { id, path: s.path, instruction: s.instruction, created: s.created, state: s.state as ChangeSummary['state'], files: [],
    problems: [...s.problems as string[]], ...(s.error ? { error: s.error as string } : {}), ...(s.finished !== undefined ? { finished: s.finished as number } : {}) };
  return { summary, session: { id: session.id, header: { cwd: session.cwd } }, root: { targetKey: root.targetKey, displayPath: root.displayPath }, pairs,
    before, ...(after ? { after } : {}), checked: true, busy: false, bytes, chain: Promise.resolve(), reloaded: true };
}

/**
 * Records live in memory during a run; finished ones are also kept in the optional local store and reloaded on start.
 * Mutations always use the host's guarded filesystem.
 */
export class EditHistory {
  private records = new Map<string, RecordEntry>();
  private turns = new Map<string, number>();
  private running = new Map<string, HistorySession>();
  private messages = new Map<string, number>();
  private lifetime = new AbortController();
  private preparing = new Set<string>();
  private host: HistoryHost; private store: HistoryStore | undefined; private now: () => number;
  /** Resolves once stored records are in memory; remote calls wait for it so a restart never shows an empty list. */
  readonly loaded: Promise<void>;
  constructor(host: HistoryHost, store?: HistoryStore, now: () => number = Date.now) {
    this.host = host; this.store = store; this.now = now; this.loaded = store ? this.load(store) : Promise.resolve();
  }
  private async load(store: HistoryStore) {
    let stored: { id: string; value: unknown }[] = [];
    try { stored = await store.load(); } catch { return; }
    const revived: RecordEntry[] = [];
    for (const { id, value } of stored) {
      const record = reviveRecord(id, value);
      if (record) revived.push(record); else void store.remove(id).catch(() => undefined);
    }
    for (const record of revived.sort((a, b) => a.summary.created - b.summary.created)) if (!this.records.has(record.summary.id)) this.records.set(record.summary.id, record);
  }
  /** Save a finished record. Failure keeps it for this run and says that it will not survive a restart. */
  private persist(r: RecordEntry) {
    const store = this.store;
    if (!store || !FINISHED.includes(r.summary.state)) return;
    const value = storedRecord(r);
    r.saving = (r.saving ?? Promise.resolve()).then(() => store.save(r.summary.id, value))
      .then(() => { delete r.summary.notice; }, () => { r.summary.notice = '未能保存到本机，重启后这条记录会丢失。'; });
  }
  private discard(r: RecordEntry) { this.records.delete(r.summary.id); void this.store?.remove(r.summary.id).catch(() => undefined); }
  dispose() { this.lifetime.abort(); this.records.clear(); this.turns.clear(); this.running.clear(); this.messages.clear(); }
  /** A released session keeps its finished records (they are stored and its id is resumed later); unfinished ones cannot complete. */
  forget(session: HistorySession) {
    for (const [id, record] of this.records) if (record.session.id === session.id && !FINISHED.includes(record.summary.state)) this.records.delete(id);
    this.turns.delete(session.id); this.running.delete(session.id); this.messages.delete(session.id);
  }
  private signal(signal: AbortSignal) { return AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(20000)]); }
  private get(session: HistorySession, id: string) {
    const record = this.records.get(id);
    if (!record || record.session.id !== session.id || record.session.header.cwd !== session.header.cwd) throw new Error('这条修改记录已失效，请重新发起修改。');
    return record;
  }
  private problem(record: RecordEntry, text: string) { if (!record.summary.problems.includes(text)) record.summary.problems.push(text); }
  /** Queue record work. The chain never rejects: host tool hooks await it and must not inherit plugin failures. */
  private enqueue(record: RecordEntry, work: () => Promise<void>) {
    record.chain = record.chain.then(work).catch(error => this.problem(record, `记录过程出错，不能安全回滚：${String((error as Error)?.message ?? error)}`));
    return record.chain;
  }
  /** Called by host hooks when this plugin failed; the user's tool call still proceeds. */
  fault(session: HistorySession, error: unknown) {
    const record = this.active(session);
    if (record) this.problem(record, `记录过程出错，不能安全回滚：${String((error as Error)?.message ?? error)}`);
  }
  private async copy(record: RecordEntry, path: string, signal: AbortSignal): Promise<FileCopy> {
    signal.throwIfAborted();
    const target = await this.host.fs.resolve(path, { cwd: record.session.header.cwd!, signal });
    if (!this.host.fs.contains(record.root, target)) throw new Error('文件超出当前会话工作区');
    const absolute = this.host.fs.processPath(target), info = await this.host.fs.stat(target, signal);
    if (!info) return { target, path: absolute };
    if (info.type !== 'file' || info.size > MAX_FILE) throw new Error('不是普通文件或超过 4 MiB');
    const data = new Uint8Array(await this.host.fs.readBytes(target, signal, MAX_FILE));
    if ((await this.host.fs.stat(target, signal))?.version !== info.version) throw new Error('读取时文件发生变化');
    return { target, path: absolute, data, version: info.version };
  }
  private retain(record: RecordEntry, copy: FileCopy) {
    if (record.pairs.size >= MAX_FILES || record.bytes + (copy.data?.byteLength ?? 0) > MAX_BYTES) throw new Error('记录超过 33 个文件或 16 MiB');
    record.bytes += copy.data?.byteLength ?? 0;
    record.pairs.set(copy.target.targetKey, { before: copy, changed: false, restored: false });
  }
  /** Discover the same local styles, imports, fonts and images that the static preview renders (rules in resources.ts). */
  private async snapshot(record: RecordEntry, rootFile: FileCopy, read: (path: string) => Promise<FileCopy>): Promise<PreviewSnapshot> {
    if (!rootFile.data) throw new Error('HTML 文件已删除');
    if (rootFile.data.length > 1024 * 1024) throw new Error('HTML 超过 1 MiB');
    const source = decode(rootFile.data), assets: PreviewSnapshot['assets'] = [], visited = new Set<string>();
    const load = async (raw: string, base: string, stylesheet: boolean): Promise<void> => {
      const reference = resolveReference(raw, base);
      if (visited.has(reference)) return;
      visited.add(reference); if (visited.size > PREVIEW_LIMITS.files) throw new Error(`关联文件超过 ${PREVIEW_LIMITS.files} 个`);
      let filePath = reference; try { filePath = decodeURIComponent(filePath); } catch { /* Literal percent. */ }
      const file = await read(directory(rootFile.path) + filePath);
      if (!file.data) throw new Error(`关联文件不存在：${reference}`);
      assets.push({ reference, data: file.data });
      // An @import target is a stylesheet whatever its extension, exactly as the preview treats it.
      if (stylesheet) await css(decode(file.data), reference);
    };
    const css = async (value: string, base = '') => { await rewriteCssAssets(value, async (url, imported) => {
      const resource = cssResource(url, imported);
      if (resource) await load(url, base, resource.kind === 'stylesheet');
      return undefined;
    }); };
    // DOMParser documents have scripting disabled, so the preview treats <noscript> content as markup.
    const queue: DefaultTreeAdapterMap['node'][] = [parse(source, { scriptingEnabled: false })]; let nodes = 0;
    while (queue.length) {
      const node = queue.pop()!; if (++nodes > 12000) throw new Error('HTML 节点过多');
      if ('childNodes' in node) queue.push(...node.childNodes);
      if (!('tagName' in node)) continue;
      const attr = (name: string) => node.attrs.find(a => a.name === name)?.value ?? '';
      if (node.tagName === 'link' && isStylesheetLink(attr('rel'), attr('href'))) await load(attr('href'), '', true);
      if (node.tagName === 'img' && imageSourceMime(attr('src'))) await load(attr('src'), '', false);
      if (attr('style')) await css(attr('style'));
      if (node.tagName === 'style') await css(node.childNodes.filter(n => 'value' in n).map(n => (n as { value: string }).value).join(''));
    }
    return { source, assets };
  }
  async prepare(session: HistorySession, request: { path: string; version: string; instruction: string }, signal: AbortSignal) {
    if (!session.header.cwd || !request || typeof request.path !== 'string' || request.path.length > 4096 || !/\.html?$/i.test(request.path)
      || typeof request.version !== 'string' || typeof request.instruction !== 'string' || request.instruction.length > 6000) throw new Error('修改记录参数无效。');
    const boundary = this.host.sessionProjections.stateOf(session, 'turnBoundary') as { openTurnStartSeq?: number | null } | undefined;
    if (this.turns.has(session.id) || boundary?.openTurnStartSeq != null) throw new Error('请等当前会话这一轮结束，再发起带回滚记录的修改。');
    if (this.preparing.has(session.id) || [...this.records.values()].some(r => r.session.id === session.id && ['running', 'finishing'].includes(r.summary.state))) throw new Error('当前会话已有正在进行的修改，请等本轮结束后再发起。');
    // An unsent request has changed nothing, so a new request replaces it once the new baseline exists.
    const unsent = [...this.records.values()].filter(r => r.session.id === session.id && r.summary.state === 'prepared');
    const evicted = this.evictions(unsent);
    this.preparing.add(session.id);
    try {
    signal = this.signal(signal);
    const root = await this.host.fs.resolve(session.header.cwd, { signal });
    const record: RecordEntry = { summary: { id: crypto.randomUUID(), path: request.path, instruction: request.instruction, created: Date.now(), state: 'prepared', files: [], problems: [] },
      session, root, pairs: new Map(), before: { source: '', assets: [] }, checked: false, busy: false, bytes: 0, chain: Promise.resolve() };
    const read = async (path: string) => { const file = await this.copy(record, path, signal); if (!record.pairs.has(file.target.targetKey)) this.retain(record, file); return file; };
    const file = await read(request.path);
    if (JSON.stringify(file.version) !== request.version) throw new Error('原文件已更新，请重新选择。');
    record.before = await this.snapshot(record, file, read);
    for (const pair of record.pairs.values()) if ((await this.copy(record, pair.before.path, signal)).version !== pair.before.version) throw new Error('关联文件已更新，请重新选择。');
    signal.throwIfAborted();
    for (const old of unsent) if (old.summary.state === 'prepared') this.records.delete(old.summary.id);
    for (const old of evicted) if (this.records.get(old.summary.id) === old && !old.busy) this.discard(old);
    this.records.set(record.summary.id, record);
    return this.summary(record);
    } finally { this.preparing.delete(session.id); }
  }
  /**
   * Records to drop so a new one fits within 8 records and 64 MiB: rolled-back records, then records finished more than
   * 7 days ago, oldest first. Anything newer or unfinished stays; if that is not enough the user removes records by hand.
   */
  private evictions(excluded: RecordEntry[]): RecordEntry[] {
    const kept = [...this.records.values()].filter(r => !excluded.includes(r)), cutoff = this.now() - KEEP_MS;
    const full = () => kept.length + this.preparing.size >= MAX_RECORDS
      || kept.reduce((n, r) => n + r.bytes + (r.after ? 0 : MAX_BYTES), (1 + this.preparing.size) * 2 * MAX_BYTES) > BUDGET;
    const candidates = kept.filter(r => !r.busy && (r.summary.state === 'restored' || (FINISHED.includes(r.summary.state) && (r.summary.finished ?? r.summary.created) < cutoff)))
      .sort((a, b) => a.summary.created - b.summary.created);
    const evicted: RecordEntry[] = [];
    while (full() && candidates.length) { const victim = candidates.shift()!; kept.splice(kept.indexOf(victim), 1); evicted.push(victim); }
    if (full()) throw new Error('修改记录已满。已回滚或结束超过 7 天的记录会自动清理；其余记录请在“修改记录”中移除不再需要的。');
    return evicted;
  }
  list(session: HistorySession): ChangeSummary[] { return [...this.records.values()].filter(r => r.session.id === session.id).reverse().map(r => this.summary(r)); }
  /** Status only. File contents travel separately through content(), once per record and side. */
  detail(session: HistorySession, id: string): ChangeDetail {
    const r = this.get(session, id);
    return { ...this.summary(r), snapshots: { before: true, after: !!r.after } };
  }
  /** Immutable once available: the before side at prepare, the after side and texts when the turn is saved. */
  content(session: HistorySession, id: string, part: ChangePart): PreviewSnapshot | ChangeText[] {
    const r = this.get(session, id);
    if (part === 'before') return r.before;
    if (part === 'after') { if (!r.after) throw new Error('本轮结束后才会保存修改结果。'); return r.after; }
    if (part !== 'texts') throw new Error('修改记录参数无效。');
    if (!r.after) throw new Error('本轮结束后才会保存修改结果。');
    const texts: ChangeText[] = [];
    for (const p of r.pairs.values()) if (p.changed && p.after) try {
      texts.push({ path: p.before.path, ...(p.before.data ? { before: textOf(p.before) } : {}), ...(p.after.data ? { after: textOf(p.after) } : {}) });
    } catch { /* Binary previews stay image assets, never lossy text. */ }
    return texts;
  }
  remove(session: HistorySession, id: string) { const r = this.get(session, id); if (r.busy || ['running', 'finishing'].includes(r.summary.state)) throw new Error('修改正在进行，暂时不能移除。'); this.discard(r); }
  private summary(record: RecordEntry): ChangeSummary {
    const files = [...record.pairs.values()].filter(p => p.changed).map(p => ({ path: p.before.path, restored: p.restored, ...(p.problem ? { problem: p.problem } : {}) }));
    return { ...record.summary, files, problems: [...record.summary.problems] };
  }
  event(session: HistorySession, event: { type: string; seq: number; data: unknown }) {
    const data = event.data as { turn?: number; source?: { kind?: string } };
    if (event.type === 'turn/start' && typeof data.turn === 'number') { this.turns.set(session.id, data.turn); this.running.set(session.id, session); this.messages.set(session.id, 0); }
    const own = [...this.records.values()].filter(r => r.session.id === session.id);
    if (event.type === 'user/message' && data.source?.kind !== 'runtime-context') {
      const text = messageText(data), matched = own.filter(r => r.summary.state === 'prepared' && text.includes(changeMarker(r.summary.id)));
      for (const r of matched) {
        const boundary = this.host.sessionProjections.stateOf(session, 'turnBoundary') as { lastTurn?: number } | undefined;
        const turn = this.turns.get(session.id) ?? boundary?.lastTurn;
        if (turn === undefined) { r.summary.state = 'failed'; r.summary.error = '无法关联本次会话轮次'; r.summary.finished = this.now(); this.persist(r); continue; }
        r.turn = turn; r.summary.state = 'running';
        if ((this.messages.get(session.id) ?? 0) > 0) this.problem(r, '同一轮包含其他要求，不能单独回滚这次修改。');
      }
      for (const r of own) if (r.summary.state === 'running' && !matched.includes(r)) this.problem(r, '同一轮收到其他要求，不能单独回滚这次修改。');
      // A replaced, still-staged request in the same message is another instruction sharing this baseline.
      const markers = new Set(text.match(/\[dsh-region-edit:[^\]\s]{1,64}\]/g) ?? []).size;
      if (markers > matched.length) for (const r of matched) this.problem(r, '同一轮包含其他要求，不能单独回滚这次修改。');
      this.messages.set(session.id, (this.messages.get(session.id) ?? 0) + 1);
    }
    if (event.type === 'workspace/changes') for (const r of own) if (r.turn === data.turn) {
      r.seq = event.seq;
      // The native service installs its summary immediately after emitting this event.
      // A late summary can add problems to a finished record; save them too.
      void this.enqueue(r, async () => { await this.checkCoverage(r); this.persist(r); });
    }
    if (event.type === 'turn/end') {
      this.turns.delete(session.id);
      this.running.delete(session.id);
      this.messages.delete(session.id);
      for (const r of own) if (r.turn === data.turn && r.summary.state === 'running') {
        r.summary.state = 'finishing';
        r.chain = r.chain.then(() => this.finish(r)).catch(error => { r.summary.state = 'failed'; r.summary.error = String(error.message ?? error); })
          .then(() => { r.summary.finished = this.now(); this.persist(r); });
      }
    }
  }
  private active(session: HistorySession) { return [...this.records.values()].find(r => r.session.id === session.id && r.summary.state === 'running'); }
  async beforeTool(session: HistorySession, signal: AbortSignal) {
    await Promise.all([...this.records.values()].filter(r => r.summary.state === 'finishing').map(r => r.chain));
    const r = this.active(session); if (!r) return;
    await this.enqueue(r, async () => {
    if (r.checked) return; r.checked = true;
    for (const p of r.pairs.values()) try {
      const now = await this.copy(r, p.before.path, this.signal(signal));
      if (now.version !== p.before.version || !same(now.data, p.before.data)) this.problem(r, `发送前文件已变化，不能安全回滚：${p.before.path}`);
    } catch { this.problem(r, `无法核对发送前的文件：${p.before.path}`); }
    });
  }
  async beforeMutation(session: HistorySession, target: FsTarget, signal: AbortSignal) {
    const r = this.active(session); if (!r || r.pairs.has(target.targetKey)) return;
    await this.enqueue(r, async () => {
    if (r.pairs.has(target.targetKey)) return;
    try { this.retain(r, await this.copy(r, this.host.fs.processPath(target), this.signal(signal))); }
    catch { this.problem(r, `未保存原内容：${target.displayPath}`); }
    });
  }
  private async checkCoverage(r: RecordEntry) {
    if (r.seq === undefined) return;
    let summary: ReturnType<HistoryHost['workspaceChanges']['summary']>;
    try { summary = this.host.workspaceChanges.summary(r.session.id, r.seq); }
    catch { this.problem(r, '无法读取宿主的变更列表，不能完整回滚。'); return; }
    if (!summary) return;
    if (summary.total > summary.files.length) this.problem(r, '宿主的变更列表被截断，不能完整回滚。');
    // Resolve canonical identities, never trust a path string from an event as a write target.
    for (const file of summary.files) try {
      const target = await this.host.fs.resolve(file.path, { cwd: r.session.header.cwd!, signal: this.lifetime.signal });
      if (!r.pairs.has(target.targetKey) || file.oldPath) this.problem(r, `另有未备份或重命名的文件：${file.path}`);
    } catch { this.problem(r, `无法核对变更文件：${file.path}`); }
  }
  private async finish(r: RecordEntry) {
    const signal = this.signal(this.lifetime.signal); let bytes = 0;
    const after = new Map<string, FileCopy>();
    const read = async (path: string) => {
      const file = await this.copy(r, path, signal), cached = after.get(file.target.targetKey); if (cached) return cached;
      bytes += file.data?.length ?? 0; if (bytes > MAX_BYTES || after.size >= MAX_FILES) throw new Error('修改后的文件超过记录上限');
      after.set(file.target.targetKey, file); return file;
    };
    for (const pair of r.pairs.values()) {
      try { pair.after = await read(pair.before.path); if (pair.after.target.targetKey !== pair.before.target.targetKey) throw new Error('文件路径指向已改变'); }
      catch (error) { pair.problem = String((error as Error).message); this.problem(r, `无法保存修改结果：${pair.before.path}`); }
      pair.changed = !!pair.after && !same(pair.before.data, pair.after.data);
      if (pair.changed) try {
        if (!r.checked) this.problem(r, '本轮未执行工具，检测到的文件变化不能归属于这次要求。');
        textOf(pair.before);
      } catch { pair.problem = pair.before.data ? '二进制文件仅支持查看，不能一键恢复' : '新增文件不自动删除'; }
    }
    try { r.after = await this.snapshot(r, await read(r.summary.path), read); }
    catch (error) { r.after = { source: '', assets: [], error: String((error as Error).message) }; }
    for (const [key, file] of after) {
      if (!r.pairs.has(key)) this.problem(r, `修改后新增关联文件，未保存原内容：${file.path}`);
      if ((await this.copy(r, file.path, signal)).version !== file.version) this.problem(r, `保存对比时文件再次变化：${file.path}`);
    }
    r.bytes += bytes; await this.checkCoverage(r); r.summary.state = 'ready';
  }
  /**
   * A running turn blocks rollback when it belongs to this record's session or its workspace overlaps this one
   * (same folder, or either containing the other). Sessions in unrelated folders cannot touch these files.
   */
  private overlapping(r: RecordEntry, signal: AbortSignal) {
    const roots = new Map<string, Promise<FsTarget>>();
    return async () => {
      for (const [id, other] of this.running) {
        if (id === r.session.id || !other.header.cwd) return true;
        let root = roots.get(id);
        if (!root) { root = this.host.fs.resolve(other.header.cwd, { signal }); roots.set(id, root); }
        try { const target = await root; if (this.host.fs.contains(r.root, target) || this.host.fs.contains(target, r.root)) return true; }
        catch { return true; }
      }
      return false;
    };
  }
  async restore(session: HistorySession, id: string, signal: AbortSignal): Promise<ChangeSummary> {
    const r = this.get(session, id);
    if (r.busy || r.summary.state !== 'ready') throw new Error('这条修改记录当前不能回滚。');
    r.busy = true;
    try {
      // After a restart the workspace is resolved again from the live session that owns this record.
      if (r.reloaded) r.root = await this.host.fs.resolve(session.header.cwd!, { signal: this.signal(signal) });
      const boundary = this.host.sessionProjections.stateOf(session, 'turnBoundary') as { openTurnStartSeq?: number | null } | undefined;
      const busy = this.overlapping(r, this.signal(signal));
      if (boundary?.openTurnStartSeq != null || await busy()) throw new Error('同一工作区有会话正在运行，请等本轮结束后回滚。');
      await r.chain; await this.checkCoverage(r);
      if (r.summary.problems.length) throw new Error(r.summary.problems[0]);
      const changed = [...r.pairs.values()].filter(p => p.changed && p.after && !p.restored);
      if (!changed.length) throw new Error('没有需要回滚的文件。');
      if (changed.some(p => p.problem)) throw new Error(changed.find(p => p.problem)!.problem);
      signal = this.signal(signal);
      // Within a run the version token must match too; after a restart tokens are not comparable, so the exact bytes decide.
      const unchanged = (p: Pair, current: FileCopy) => current.target.targetKey === p.before.target.targetKey && same(current.data, p.after!.data)
        && (r.reloaded || current.version === p.after!.version);
      // Check the entire batch before the first write. Each write checks the file again and is conditional on the version just read.
      for (const p of changed) {
        if (await busy()) throw new Error('同一工作区有会话开始运行，已停止回滚。');
        if (!unchanged(p, await this.copy(r, p.before.path, signal))) throw new Error(`文件后来又被修改，已停止回滚：${p.before.path}`);
      }
      const policy = this.host.sandboxPolicy.resolve({ session });
      for (const p of changed) {
        if (await busy()) throw new Error('同一工作区有会话开始运行，已停止回滚。');
        const current = await this.copy(r, p.before.path, signal);
        if (!unchanged(p, current)) throw new Error(`文件后来又被修改，已停止回滚：${p.before.path}`);
        await this.host.fs.writeText(current.target, textOf(p.before), current.version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current.version }, signal, policy);
        p.restored = true;
      }
      r.summary.state = 'restored'; delete r.summary.error;
    } catch (error) { r.summary.error = String((error as Error).message); }
    finally { r.busy = false; this.persist(r); }
    return this.summary(r);
  }
  async settled(session: HistorySession) {
    const own = [...this.records.values()].filter(r => r.session.id === session.id);
    await Promise.all(own.map(r => r.chain)); await Promise.all(own.map(r => r.saving));
  }
}

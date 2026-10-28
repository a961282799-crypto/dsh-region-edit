import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { rewriteCssAssets } from './css-assets.ts';
import { changeMarker } from './changes.ts';
import type { ChangeSummary, ChangeDetail, PreviewSnapshot } from './changes.ts';

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
interface Pair { before: FileCopy; after?: FileCopy; restored: boolean; problem?: string }
interface RecordEntry {
  summary: ChangeSummary; session: HistorySession; root: FsTarget; pairs: Map<string, Pair>;
  before: PreviewSnapshot; after?: PreviewSnapshot; turn?: number; seq?: number;
  checked: boolean; busy: boolean; bytes: number; chain: Promise<void>;
}
const MAX_FILE = 4 * 1024 * 1024, MAX_BYTES = 16 * 1024 * 1024, MAX_FILES = 33;
const decode = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
const same = (a?: Uint8Array, b?: Uint8Array) => a === b || !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);
const textOf = (file: FileCopy) => { if (!file.data || file.data.includes(0)) throw new Error('不是可恢复的 UTF-8 文本'); return decode(file.data); };
const directory = (path: string) => path.replaceAll('\\', '/').replace(/\/[^/]*$/, '/');
const local = (value: string) => !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(value);
const messageText = (data: unknown): string => {
  const message = data as { content?: { type?: string; text?: string }[] };
  return Array.isArray(message?.content) ? message.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
};

/** Snapshots live only for this plugin lifetime. Mutations always use the host's guarded filesystem. */
export class EditHistory {
  private records = new Map<string, RecordEntry>();
  private turns = new Map<string, number>();
  private messages = new Map<string, number>();
  private lifetime = new AbortController();
  private preparing = new Set<string>();
  private host: HistoryHost;
  constructor(host: HistoryHost) { this.host = host; }
  dispose() { this.lifetime.abort(); this.records.clear(); this.turns.clear(); this.messages.clear(); }
  forget(session: HistorySession) { for (const [id, record] of this.records) if (record.session.id === session.id) this.records.delete(id); this.turns.delete(session.id); this.messages.delete(session.id); }
  private signal(signal: AbortSignal) { return AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(20000)]); }
  private get(session: HistorySession, id: string) {
    const record = this.records.get(id);
    if (!record || record.session.id !== session.id || record.session.header.cwd !== session.header.cwd) throw new Error('这条修改记录已失效，请重新发起修改。');
    return record;
  }
  private problem(record: RecordEntry, text: string) { if (!record.summary.problems.includes(text)) record.summary.problems.push(text); }
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
    record.pairs.set(copy.target.targetKey, { before: copy, restored: false });
  }
  /** Discover the same local styles, imports, fonts and images that the static preview renders. */
  private async snapshot(record: RecordEntry, rootFile: FileCopy, read: (path: string) => Promise<FileCopy>): Promise<PreviewSnapshot> {
    if (!rootFile.data) throw new Error('HTML 文件已删除');
    if (rootFile.data.length > 1024 * 1024) throw new Error('HTML 超过 1 MiB');
    const source = decode(rootFile.data), assets: PreviewSnapshot['assets'] = [], visited = new Set<string>();
    const load = async (raw: string, base = ''): Promise<FileCopy | undefined> => {
      if (!local(raw)) return;
      const parts: string[] = [];
      for (const part of (base.slice(0, base.lastIndexOf('/') + 1) + raw.split(/[?#]/)[0]!).split('/')) {
        if (!part || part === '.') continue;
        if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop(); else parts.push(part);
      }
      const reference = parts.join('/');
      if (visited.has(reference)) return;
      visited.add(reference); if (visited.size > 32) throw new Error('关联文件超过 32 个');
      let filePath = reference; try { filePath = decodeURIComponent(filePath); } catch { /* Literal percent. */ }
      const file = await read(directory(rootFile.path) + filePath);
      if (!file.data) throw new Error(`关联文件不存在：${reference}`);
      assets.push({ reference, data: file.data });
      if (/\.css$/i.test(filePath)) await css(decode(file.data), reference);
      return file;
    };
    const css = async (value: string, base = '') => { await rewriteCssAssets(value, async (url, stylesheet) => {
      if (stylesheet || /\.(?:css|png|jpe?g|gif|webp|svg|avif|woff2?|ttf|otf)(?:[?#]|$)/i.test(url)) await load(url, base);
      return undefined;
    }); };
    const queue: DefaultTreeAdapterMap['node'][] = [parse(source)]; let nodes = 0;
    while (queue.length) {
      const node = queue.pop()!; if (++nodes > 12000) throw new Error('HTML 节点过多');
      if ('childNodes' in node) queue.push(...node.childNodes);
      if (!('tagName' in node)) continue;
      const attr = (name: string) => node.attrs.find(a => a.name === name)?.value ?? '';
      if (node.tagName === 'link' && attr('rel').split(/\s+/).includes('stylesheet') && /\.css(?:[?#]|$)/i.test(attr('href'))) await load(attr('href'));
      if (node.tagName === 'img' && /\.(?:png|jpe?g|gif|webp|svg|avif)(?:[?#]|$)/i.test(attr('src'))) await load(attr('src'));
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
    if (this.preparing.has(session.id) || [...this.records.values()].some(r => r.session.id === session.id && ['prepared', 'running', 'finishing'].includes(r.summary.state))) throw new Error('当前会话已有待完成的修改。请在“修改记录”中查看，或移除尚未发送的记录。');
    // Never evict a record silently: recovery history stays until the user removes it.
    if (this.records.size + this.preparing.size >= 8 || [...this.records.values()].reduce((n, r) => n + r.bytes + (r.after ? 0 : MAX_BYTES), (1 + this.preparing.size) * 2 * MAX_BYTES) > 64 * 1024 * 1024) throw new Error('修改记录已满，请先移除不再需要的记录。');
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
    signal.throwIfAborted(); this.records.set(record.summary.id, record);
    return this.summary(record);
    } finally { this.preparing.delete(session.id); }
  }
  list(session: HistorySession): ChangeSummary[] { return [...this.records.values()].filter(r => r.session.id === session.id).reverse().map(r => this.summary(r)); }
  detail(session: HistorySession, id: string): ChangeDetail {
    const r = this.get(session, id), texts: ChangeDetail['texts'] = [];
    for (const p of r.pairs.values()) if (p.after && !same(p.before.data, p.after.data)) try {
      texts.push({ path: p.before.path, ...(p.before.data ? { before: textOf(p.before) } : {}), ...(p.after.data ? { after: textOf(p.after) } : {}) });
    } catch { /* Binary previews stay image assets, never lossy text. */ }
    return { ...this.summary(r), before: r.before, ...(r.after ? { after: r.after } : {}), texts };
  }
  remove(session: HistorySession, id: string) { const r = this.get(session, id); if (r.busy || ['running', 'finishing'].includes(r.summary.state)) throw new Error('修改正在进行，暂时不能移除。'); this.records.delete(id); }
  private summary(record: RecordEntry): ChangeSummary {
    const files = [...record.pairs.values()].filter(p => p.after && !same(p.before.data, p.after.data)).map(p => ({ path: p.before.path, restored: p.restored, ...(p.problem ? { problem: p.problem } : {}) }));
    return { ...record.summary, files, problems: [...record.summary.problems] };
  }
  event(session: HistorySession, event: { type: string; seq: number; data: unknown }) {
    const data = event.data as { turn?: number; source?: { kind?: string } };
    if (event.type === 'turn/start' && typeof data.turn === 'number') { this.turns.set(session.id, data.turn); this.messages.set(session.id, 0); }
    const own = [...this.records.values()].filter(r => r.session.id === session.id);
    if (event.type === 'user/message' && data.source?.kind !== 'runtime-context') {
      const text = messageText(data), matched = own.filter(r => r.summary.state === 'prepared' && text.includes(changeMarker(r.summary.id)));
      for (const r of matched) {
        const boundary = this.host.sessionProjections.stateOf(session, 'turnBoundary') as { lastTurn?: number } | undefined;
        const turn = this.turns.get(session.id) ?? boundary?.lastTurn;
        if (turn === undefined) { r.summary.state = 'failed'; r.summary.error = '无法关联本次会话轮次'; continue; }
        r.turn = turn; r.summary.state = 'running';
        if ((this.messages.get(session.id) ?? 0) > 0) this.problem(r, '同一轮包含其他要求，不能单独回滚这次修改。');
      }
      for (const r of own) if (r.summary.state === 'running' && !matched.includes(r)) this.problem(r, '同一轮收到其他要求，不能单独回滚这次修改。');
      this.messages.set(session.id, (this.messages.get(session.id) ?? 0) + 1);
    }
    if (event.type === 'workspace/changes') for (const r of own) if (r.turn === data.turn) {
      r.seq = event.seq;
      // The native service installs its summary immediately after emitting this event.
      r.chain = r.chain.then(() => this.checkCoverage(r));
    }
    if (event.type === 'turn/end') {
      this.turns.delete(session.id);
      this.messages.delete(session.id);
      for (const r of own) if (r.turn === data.turn && r.summary.state === 'running') {
        r.summary.state = 'finishing';
        r.chain = r.chain.then(() => this.finish(r)).catch(error => { r.summary.state = 'failed'; r.summary.error = String(error.message ?? error); });
      }
    }
  }
  private active(session: HistorySession) { return [...this.records.values()].find(r => r.session.id === session.id && r.summary.state === 'running'); }
  async beforeTool(session: HistorySession, signal: AbortSignal) {
    await Promise.all([...this.records.values()].filter(r => r.summary.state === 'finishing').map(r => r.chain));
    const r = this.active(session); if (!r) return;
    r.chain = r.chain.then(async () => {
    if (r.checked) return; r.checked = true;
    for (const p of r.pairs.values()) try {
      const now = await this.copy(r, p.before.path, this.signal(signal));
      if (now.version !== p.before.version || !same(now.data, p.before.data)) this.problem(r, `发送前文件已变化，不能安全回滚：${p.before.path}`);
    } catch { this.problem(r, `无法核对发送前的文件：${p.before.path}`); }
    });
    await r.chain;
  }
  async beforeMutation(session: HistorySession, target: FsTarget, signal: AbortSignal) {
    const r = this.active(session); if (!r || r.pairs.has(target.targetKey)) return;
    r.chain = r.chain.then(async () => {
    if (r.pairs.has(target.targetKey)) return;
    try { this.retain(r, await this.copy(r, this.host.fs.processPath(target), this.signal(signal))); }
    catch { this.problem(r, `未保存原内容：${target.displayPath}`); }
    });
    await r.chain;
  }
  private async checkCoverage(r: RecordEntry) {
    if (r.seq === undefined) return;
    const summary = this.host.workspaceChanges.summary(r.session.id, r.seq); if (!summary) return;
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
      if (pair.after && !same(pair.before.data, pair.after.data)) try {
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
  async restore(session: HistorySession, id: string, signal: AbortSignal): Promise<ChangeSummary> {
    const r = this.get(session, id);
    if (r.busy || r.summary.state !== 'ready') throw new Error('这条修改记录当前不能回滚。');
    r.busy = true;
    try {
      const boundary = this.host.sessionProjections.stateOf(session, 'turnBoundary') as { openTurnStartSeq?: number | null } | undefined;
      if (this.turns.size || boundary?.openTurnStartSeq != null) throw new Error('有会话正在运行，请等本轮结束后回滚。');
      await r.chain; await this.checkCoverage(r);
      if (r.summary.problems.length) throw new Error(r.summary.problems[0]);
      const changed = [...r.pairs.values()].filter(p => p.after && !p.restored && !same(p.before.data, p.after.data));
      if (!changed.length) throw new Error('没有需要回滚的文件。');
      if (changed.some(p => p.problem)) throw new Error(changed.find(p => p.problem)!.problem);
      signal = this.signal(signal);
      // Check the entire batch before the first write. Each write checks the exact version again.
      for (const p of changed) {
        if (this.turns.size) throw new Error('有会话开始运行，已停止回滚。');
        const current = await this.copy(r, p.before.path, signal);
        if (current.target.targetKey !== p.before.target.targetKey || current.version !== p.after!.version || !same(current.data, p.after!.data)) throw new Error(`文件后来又被修改，已停止回滚：${p.before.path}`);
      }
      const policy = this.host.sandboxPolicy.resolve({ session });
      for (const p of changed) {
        if (this.turns.size) throw new Error('有会话开始运行，已停止回滚。');
        const current = await this.copy(r, p.before.path, signal);
        if (current.target.targetKey !== p.before.target.targetKey || current.version !== p.after!.version || !same(current.data, p.after!.data)) throw new Error(`文件后来又被修改，已停止回滚：${p.before.path}`);
        await this.host.fs.writeText(current.target, textOf(p.before), p.after!.version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: p.after!.version }, signal, policy);
        p.restored = true;
      }
      r.summary.state = 'restored'; delete r.summary.error;
    } catch (error) { r.summary.error = String((error as Error).message); }
    finally { r.busy = false; }
    return this.summary(r);
  }
  async settled(session: HistorySession) { await Promise.all([...this.records.values()].filter(r => r.session.id === session.id).map(r => r.chain)); }
}

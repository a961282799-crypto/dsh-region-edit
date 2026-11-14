import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posix } from 'node:path';
import { EditHistory, RECORD_LIMITS } from '../src/history.ts';
import { changeMarker } from '../src/changes.ts';
import type { HistoryHost, FsTarget } from '../src/history.ts';
import type { ChangeText, PreviewSnapshot } from '../src/changes.ts';
import { FileHistoryStore } from '../src/history-store.ts';
import type { HistoryStore } from '../src/history-store.ts';
import { mkdtemp, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(options: { store?: HistoryStore; now?: () => number } = {}) {
  const session = { id: 'one', header: { cwd: '/work' } }, files = new Map<string, { data: Uint8Array; version: string }>();
  let version = 0, seq = 0, turn = 0, open: number | null = null, failPath = '';
  const put = (path: string, data: string | Uint8Array) => files.set(path, { data: typeof data === 'string' ? new TextEncoder().encode(data) : data, version: String(++version) });
  const html = '\ufeff<!doctype html>\r\n<link rel="stylesheet" href="main.css"><button>保留内容</button>\r\n';
  put('/work/index.html', html); put('/work/main.css', 'button{padding:12px;background:var(--brand)}');
  const writes: string[] = [], summaries = new Map<number, { files: { path: string; oldPath?: string }[]; total: number }>();
  const host: HistoryHost = {
    fs: {
      async resolve(path, opts) { const absolute = posix.resolve(opts.cwd ?? '/work', path); return { targetKey: absolute, displayPath: absolute }; },
      contains(root, target) { return target.targetKey === root.targetKey || target.targetKey.startsWith(root.targetKey.replace(/\/$/, '') + '/'); },
      processPath: target => target.targetKey,
      async stat(target) { const f = files.get(target.targetKey); return f ? { type: 'file', size: f.data.length, version: f.version } : undefined; },
      async readBytes(target, signal, maxBytes) { signal.throwIfAborted(); const file = files.get(target.targetKey)!; if (file.data.length > maxBytes) throw new Error('large'); return file.data; },
      async writeText(target, text, expected, signal, policy) {
        signal.throwIfAborted(); assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: '/work' });
        if (target.targetKey === failPath) throw new Error('模拟写入失败');
        const f = files.get(target.targetKey);
        if (expected.kind === 'createIfAbsent' ? !!f : f?.version !== expected.version) throw new Error('FS_STALE_VERSION');
        writes.push(target.targetKey); put(target.targetKey, text);
      }
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) },
    sessionProjections: { stateOf: () => ({ lastTurn: turn, openTurnStartSeq: open }) },
    workspaceChanges: { summary: (_session, seq) => summaries.get(seq) }
  };
  let history = new EditHistory(host, options.store, options.now); const signal = new AbortController().signal;
  const prepareRaw = (target = session) => history.prepare(target, { path: '/work/index.html', version: JSON.stringify(files.get('/work/index.html')!.version), instruction: '增大按钮' }, signal);
  // Most tests need a record; a skipped one surfaces as an error carrying its reason.
  const prepare = async (target = session) => { const result = await prepareRaw(target); if ('skipped' in result) throw new Error(result.skipped); return result.change; };
  const event = (type: string, data: unknown) => { const number = ++seq; history.event(session, { type, data, seq: number }); return number; };
  async function start(id: string, extra = '') { open = ++turn; event('turn/start', { turn }); event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: changeMarker(id) + extra }] }); await history.beforeTool(session, signal); }
  async function end(paths?: string[]) {
    if (paths) { summaries.set(seq + 1, { files: paths.map(path => ({ path })), total: paths.length }); event('workspace/changes', { turn }); }
    open = null; event('turn/end', { turn }); await history.settled(session);
  }
  // reload() simulates a restart: a new history over the same files, reading the given store.
  const reload = async (store: HistoryStore) => { history.dispose(); history = new EditHistory(host, store, options.now); await history.loaded; return history; };
  return { get history() { return history; }, reload, session, signal, prepare, prepareRaw, start, end, event, put, files, writes, html, host, fail: (path: string) => { failPath = path; } };
}

test('frozen HTML and linked CSS survive later edits; guarded rollback preserves exact BOM and CRLF', async () => {
  const f = fixture(), record = await f.prepare(); await f.start(record.id);
  f.put('/work/index.html', f.html.replace('保留内容', '新内容')); f.put('/work/main.css', 'button{padding:24px}'); await f.end(['index.html', 'main.css']);
  const detail = f.history.detail(f.session, record.id);
  const before = f.history.content(f.session, record.id, 'before') as PreviewSnapshot, after = f.history.content(f.session, record.id, 'after') as PreviewSnapshot;
  assert.equal(detail.state, 'ready'); assert.equal(detail.files.length, 2); assert.equal(before.source, f.html);
  assert.match(new TextDecoder().decode(before.assets[0]!.data), /padding:12px/);
  assert.match(new TextDecoder().decode(after.assets[0]!.data), /padding:24px/);
  const result = await f.history.restore(f.session, record.id, f.signal);
  assert.equal(result.state, 'restored'); assert.equal(f.writes.length, 2);
  assert.deepEqual(f.files.get('/work/index.html')!.data, new TextEncoder().encode(f.html));
  assert.match((f.history.content(f.session, record.id, 'after') as PreviewSnapshot).source, /新内容/);
});
test('one later edit blocks the whole batch before any file is written', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id);
  f.put('/work/index.html', 'changed'); f.put('/work/main.css', 'button{padding:24px}'); await f.end();
  f.put('/work/main.css', 'human edit'); const result = await f.history.restore(f.session, r.id, f.signal);
  assert.match(result.error!, /后来又被修改/); assert.deepEqual(f.writes, []);
});
test('partial write failure reports restored files and can resume safely', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id);
  f.put('/work/index.html', f.html.replace('保留内容', '新内容')); f.put('/work/main.css', 'changed'); await f.end();
  f.fail('/work/main.css'); const first = await f.history.restore(f.session, r.id, f.signal);
  assert.equal(first.state, 'ready'); assert.equal(first.files.filter(p => p.restored).length, 1); assert.match(first.error!, /写入失败/);
  f.fail(''); assert.equal((await f.history.restore(f.session, r.id, f.signal)).state, 'restored'); assert.equal(f.writes.length, 2);
});
test('draft edited before delivery cannot revert intervening human changes', async () => {
  const f = fixture(), r = await f.prepare(); f.put('/work/main.css', 'human before send'); await f.start(r.id); f.put('/work/main.css', 'model after'); await f.end();
  assert.match((await f.history.restore(f.session, r.id, f.signal)).error!, /发送前文件已变化/); assert.equal(f.writes.length, 0);
});
test('native file-tool mutations capture other text files before the first write', async () => {
  const f = fixture(); f.put('/work/other.css', 'original'); const r = await f.prepare(); await f.start(r.id);
  const target: FsTarget = { targetKey: '/work/other.css', displayPath: '/work/other.css' };
  await Promise.all([f.history.beforeMutation(f.session, target, f.signal), f.history.beforeMutation(f.session, target, f.signal)]);
  f.put('/work/other.css', 'changed'); await f.end(['other.css']);
  assert.equal((await f.history.restore(f.session, r.id, f.signal)).state, 'restored'); assert.equal(new TextDecoder().decode(f.files.get('/work/other.css')!.data), 'original');
});
test('unbacked native summary files block full rollback, including late summaries', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id); f.put('/work/index.html', 'changed'); await f.end(['index.html', 'shell-only.txt']);
  assert.match((await f.history.restore(f.session, r.id, f.signal)).error!, /未备份/); assert.equal(f.writes.length, 0);
});
test('other session and unrecognized markers cannot access or claim a record', async () => {
  const f = fixture(), r = await f.prepare();
  assert.throws(() => f.history.detail({ id: 'other', header: { cwd: '/work' } }, r.id), /失效/);
  f.event('turn/start', { turn: 1 }); f.event('user/message', { content: [{ type: 'text', text: '[dsh-region-edit:unowned]' }] });
  assert.equal(f.history.list(f.session)[0]!.state, 'prepared'); f.history.remove(f.session, r.id);
  assert.equal(f.history.list(f.session).length, 0);
});
test('workspace escape in an asset is never read; the request goes out without a record', async () => {
  const f = fixture(); f.put('/work/index.html', '<link rel="stylesheet" href="../private.css">'); f.put('/private.css', 'private');
  assert.deepEqual(await f.prepareRaw(), { skipped: '文件超出当前会话工作区。' }); assert.equal(f.history.list(f.session).length, 0);
});
test('a stale selection rejects, while record limits and a running turn only skip the record', async () => {
  const f = fixture();
  await assert.rejects(f.history.prepare(f.session, { path: '/work/index.html', version: '"stale"', instruction: 'x' }, f.signal), /原文件已更新/);
  f.put('/work/index.html', 'x'.repeat(1024 * 1024 + 1));
  assert.deepEqual(await f.prepareRaw(), { skipped: 'HTML 超过 1 MiB。' });
  f.put('/work/index.html', f.html); f.event('turn/start', { turn: 1 });
  assert.deepEqual(await f.prepareRaw(), { skipped: '当前会话正在运行。' });
  assert.equal(f.history.list(f.session).length, 0);
});
test('changed binary assets remain frozen but prevent a misleading partial rollback', async () => {
  const f = fixture(); f.put('/work/index.html', '<img src="image.png">'); f.put('/work/image.png', new Uint8Array([0, 1, 2]));
  const r = await f.prepare(); await f.start(r.id); f.put('/work/image.png', new Uint8Array([0, 3, 4])); await f.end();
  assert.match((await f.history.restore(f.session, r.id, f.signal)).error!, /二进制/); assert.equal(f.writes.length, 0);
});
test('new files are not deleted and deleted original text can be recreated only when absent', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id); f.files.delete('/work/main.css'); await f.end();
  assert.equal((await f.history.restore(f.session, r.id, f.signal)).state, 'restored'); assert.ok(f.files.has('/work/main.css'));
  const r2 = await f.prepare(); await f.start(r2.id);
  await f.history.beforeMutation(f.session, { targetKey: '/work/new.css', displayPath: '/work/new.css' }, f.signal); f.put('/work/new.css', 'new'); await f.end();
  assert.match((await f.history.restore(f.session, r2.id, f.signal)).error!, /新增文件/); assert.ok(f.files.has('/work/new.css'));
});
test('parallel prepare calls cannot establish overlapping recovery baselines', async () => {
  const f = fixture(); const results = await Promise.allSettled([f.prepare(), f.prepare()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.history.list(f.session).length, 1);
});
test('another user instruction in the same turn blocks isolated rollback', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id);
  f.event('user/message', { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] });
  assert.deepEqual(f.history.list(f.session)[0]!.problems, []);
  f.event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'also modify something' }] });
  f.put('/work/index.html', 'changed'); await f.end(); assert.match((await f.history.restore(f.session, r.id, f.signal)).error!, /其他要求/);
});
test('a cancelled prepare retains no unusable record', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(() => f.history.prepare(f.session, { path: '/work/index.html', version: '"1"', instruction: 'change' }, abort.signal));
  assert.deepEqual(f.history.list(f.session), []); f.history.dispose();
});
test('a new request replaces an unsent record, but never a running one', async () => {
  const f = fixture(), first = await f.prepare(), second = await f.prepare();
  assert.deepEqual(f.history.list(f.session).map(r => r.id), [second.id]);
  await f.start(second.id); assert.deepEqual(await f.prepareRaw(), { skipped: '当前会话正在运行。' });
  f.put('/work/index.html', 'changed'); await f.end();
  assert.equal(f.history.list(f.session).length, 1); assert.notEqual(first.id, second.id);
});
test('a replaced request sent together with the new one blocks isolated rollback', async () => {
  const f = fixture(), first = await f.prepare(), second = await f.prepare();
  await f.start(second.id, ` ${changeMarker(second.id)} ${changeMarker(first.id)}`); f.put('/work/index.html', 'changed'); await f.end();
  assert.match((await f.history.restore(f.session, second.id, f.signal)).error!, /其他要求/); assert.equal(f.writes.length, 0);
});
test('host change-list failures are recorded and never reject the tool hooks', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id);
  f.host.workspaceChanges.summary = () => { throw new Error('session disposed'); };
  f.event('workspace/changes', { turn: 1 });
  await f.history.beforeTool(f.session, f.signal);
  await f.history.beforeMutation(f.session, { targetKey: '/work/other.css', displayPath: '/work/other.css' }, f.signal);
  f.put('/work/index.html', 'changed'); await f.end();
  const result = await f.history.restore(f.session, r.id, f.signal);
  assert.match(result.error!, /变更列表/); assert.equal(f.writes.length, 0);
  f.history.fault(f.session, new Error('unused'));
});
test('detail carries status only; contents come from content() and stay immutable', async () => {
  const f = fixture(), r = await f.prepare();
  const pending = f.history.detail(f.session, r.id);
  assert.deepEqual(pending.snapshots, { before: true, after: false }); assert.equal('before' in pending, false); assert.equal('texts' in pending, false);
  assert.throws(() => f.history.content(f.session, r.id, 'after'), /本轮结束后/); assert.throws(() => f.history.content(f.session, r.id, 'texts'), /本轮结束后/);
  assert.throws(() => f.history.content(f.session, r.id, 'other' as 'after'), /参数无效/);
  const before = f.history.content(f.session, r.id, 'before');
  await f.start(r.id); f.put('/work/main.css', 'button{padding:30px}'); await f.end();
  assert.equal(f.history.content(f.session, r.id, 'before'), before); assert.equal(f.history.detail(f.session, r.id).snapshots.after, true);
  const texts = f.history.content(f.session, r.id, 'texts') as ChangeText[];
  assert.deepEqual(texts.map(t => t.path), ['/work/main.css']); assert.equal(texts[0]!.after, 'button{padding:30px}');
  assert.throws(() => f.history.content({ id: 'other', header: { cwd: '/work' } }, r.id, 'before'), /失效/);
});
test('frozen snapshots embed what the preview embeds: extensionless imports, noscript content, any rel case', async () => {
  const f = fixture();
  f.put('/work/index.html', '<!doctype html><link rel="StyleSheet" href="main.css"><noscript><img src="img/fallback.png"></noscript><p>内容</p>'
    + '<picture><source srcset="img/unused.png"><img srcset="img/hi.png 2x, img/lo.png 1x"></picture>');
  f.put('/work/img/lo.png', new Uint8Array([5]));
  f.put('/work/main.css', '@import url(theme); button{padding:12px}'); f.put('/work/theme', 'body{background:url(img/bg.png)}');
  f.put('/work/img/bg.png', new Uint8Array([1, 2, 3])); f.put('/work/img/fallback.png', new Uint8Array([4]));
  const r = await f.prepare(), before = f.history.content(f.session, r.id, 'before') as PreviewSnapshot;
  assert.deepEqual(before.assets.map(a => a.reference).sort(), ['img/bg.png', 'img/fallback.png', 'img/lo.png', 'main.css', 'theme']);
});
test('only a running session in an overlapping workspace blocks rollback', async () => {
  const prepareChanged = async () => { const f = fixture(), r = await f.prepare(); await f.start(r.id); f.put('/work/main.css', 'changed'); await f.end(); return { f, r }; };
  const runIn = (f: ReturnType<typeof fixture>, id: string, cwd: string) => f.history.event({ id, header: { cwd } }, { type: 'turn/start', seq: 900, data: { turn: 1 } });
  for (const cwd of ['/work', '/work/packages/ui', '/']) {
    const { f, r } = await prepareChanged(); runIn(f, 'other', cwd);
    assert.match((await f.history.restore(f.session, r.id, f.signal)).error!, /同一工作区/); assert.equal(f.writes.length, 0);
    f.history.event({ id: 'other', header: { cwd } }, { type: 'turn/end', seq: 901, data: { turn: 1 } });
    assert.equal((await f.history.restore(f.session, r.id, f.signal)).state, 'restored');
  }
  const { f, r } = await prepareChanged(); runIn(f, 'elsewhere', '/projects/another');
  assert.equal((await f.history.restore(f.session, r.id, f.signal)).state, 'restored');
});

test('tools wait only for records still saving in an overlapping workspace', async () => {
  const f = fixture(), r = await f.prepare(); await f.start(r.id); f.put('/work/main.css', 'changed');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const read = f.host.fs.readBytes; f.host.fs.readBytes = async (...args) => { await gate; return read(...args); };
  f.event('turn/end', { turn: 1 });
  assert.equal(f.history.list(f.session)[0]!.state, 'finishing');
  const order: string[] = [];
  const elsewhere = f.history.beforeTool({ id: 'x', header: { cwd: '/elsewhere' } }, f.signal).then(() => order.push('elsewhere'));
  const nested = f.history.beforeTool({ id: 'y', header: { cwd: '/work/sub' } }, f.signal).then(() => order.push('nested'));
  await elsewhere; await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(order, ['elsewhere']);
  release(); await nested; f.host.fs.readBytes = read; assert.deepEqual(order, ['elsewhere', 'nested']);
  await f.history.settled(f.session); assert.equal(f.history.list(f.session)[0]!.state, 'ready');
});
const temporaryStore = async () => { const dir = await mkdtemp(join(tmpdir(), 'region-history-')); return { dir, store: () => new FileHistoryStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) }; };
test('finished records survive a restart, and rollback then checks exact bytes instead of old version tokens', async () => {
  const t = await temporaryStore();
  try {
    const f = fixture({ store: t.store() }), r = await f.prepare(); await f.start(r.id);
    f.put('/work/main.css', 'button{padding:30px}'); await f.end(); await f.history.settled(f.session);
    const before = f.history.content(f.session, r.id, 'before') as PreviewSnapshot;
    const reloaded = await f.reload(t.store());
    assert.deepEqual(reloaded.list(f.session).map(x => [x.id, x.state, x.files.length]), [[r.id, 'ready', 1]]);
    assert.equal((reloaded.content(f.session, r.id, 'before') as PreviewSnapshot).source, before.source);
    assert.equal((reloaded.content(f.session, r.id, 'texts') as ChangeText[])[0]!.after, 'button{padding:30px}');
    // Same bytes under a new version token, as after a restart: allowed.
    const css = f.files.get('/work/main.css')!; f.files.set('/work/main.css', { data: css.data, version: 'after-restart' });
    assert.equal((await reloaded.restore(f.session, r.id, f.signal)).state, 'restored');
    assert.equal(new TextDecoder().decode(f.files.get('/work/main.css')!.data), 'button{padding:12px;background:var(--brand)}');
    await reloaded.settled(f.session);
    assert.equal((await f.reload(t.store())).list(f.session)[0]!.state, 'restored');
  } finally { await t.cleanup(); }
});
test('a live record still requires the same version token, and a reloaded one refuses changed bytes', async () => {
  const t = await temporaryStore();
  try {
    const f = fixture({ store: t.store() }), r = await f.prepare(); await f.start(r.id); f.put('/work/main.css', 'changed'); await f.end();
    const css = f.files.get('/work/main.css')!; f.files.set('/work/main.css', { data: css.data, version: 'other-token' });
    assert.match((await f.history.restore(f.session, r.id, f.signal)).error!, /后来又被修改/);
    await f.history.settled(f.session); const reloaded = await f.reload(t.store());
    f.put('/work/main.css', 'human edit after restart');
    assert.match((await reloaded.restore(f.session, r.id, f.signal)).error!, /后来又被修改/); assert.equal(f.writes.length, 0);
    await reloaded.settled(f.session);
  } finally { await t.cleanup(); }
});
test('unfinished records are not stored, released sessions keep finished ones, and damaged files are dropped', async () => {
  const t = await temporaryStore();
  try {
    const f = fixture({ store: t.store() }), done = await f.prepare(); await f.start(done.id); f.put('/work/main.css', 'x'); await f.end();
    const pending = await f.prepare();
    f.history.forget(f.session); assert.deepEqual(f.history.list(f.session).map(x => x.id), [done.id]);
    await f.history.settled(f.session);
    await mkdir(join(t.dir, 'records'), { recursive: true });
    await writeFile(join(t.dir, 'records', '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ format: 2 }));
    await writeFile(join(t.dir, 'records', '11111111-1111-4111-8111-111111111111.json'), '{broken');
    const reloaded = await f.reload(t.store());
    assert.deepEqual(reloaded.list(f.session).map(x => x.id), [done.id]); assert.notEqual(pending.id, done.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!(await readdir(join(t.dir, 'records'))).includes('00000000-0000-4000-8000-000000000000.json'));
    assert.deepEqual(reloaded.list({ id: 'other', header: { cwd: '/work' } }), []);
  } finally { await t.cleanup(); }
});
test('a full session drops its rolled-back, then failed, then oldest finished records, never another session\'s', async () => {
  let clock = 1_000_000_000_000;
  const f = fixture({ now: () => clock }), ids: string[] = [], other = { id: 'two', header: { cwd: '/work' } };
  const cycle = async (content: string) => { const r = await f.prepare(); await f.start(r.id); f.put('/work/main.css', content); await f.end(); clock += 1000; return r.id; };
  f.history.event(other, { type: 'turn/end', seq: 0, data: { turn: 0 } });
  const foreign = (await f.prepare(other)).id;
  for (let i = 0; i < RECORD_LIMITS.session; i++) ids.push(await cycle(`v${i}`));
  const newest = ids.at(-1)!;
  assert.equal((await f.history.restore(f.session, newest, f.signal)).state, 'restored');
  // Full: the rolled-back record goes first even though it is the newest.
  const a = await cycle('a');
  assert.deepEqual(f.history.list(f.session).map(x => x.id), [a, ...ids.slice(0, -1).reverse()]);
  // Then the oldest finished one.
  const b = await cycle('b');
  assert.deepEqual(f.history.list(f.session).map(x => x.id), [b, a, ...ids.slice(1, -1).reverse()]);
  assert.deepEqual(f.history.list(other).map(x => x.id), [foreign]);
});
test('a full history that cannot drop anything skips the record instead of blocking the request', async () => {
  const f = fixture(), sessions = Array.from({ length: RECORD_LIMITS.total }, (_, i) => ({ id: `s${i}`, header: { cwd: '/work' } }));
  for (const s of sessions) await f.prepare(s); // Unsent records are never dropped for another session.
  assert.deepEqual(await f.prepareRaw(), { skipped: '修改记录已满，且没有可以自动清理的已结束记录。' });
});
test('the file store shares identical contents between records and deletes them with the last reference', async () => {
  const t = await temporaryStore();
  try {
    const shared = new Uint8Array([1, 2, 3]), a = '22222222-2222-4222-8222-222222222222', b = '33333333-3333-4333-8333-333333333333';
    const store = t.store();
    await store.save(a, { x: shared, y: [shared, new Uint8Array([9])] }); await store.save(b, { z: new Uint8Array([1, 2, 3]) });
    assert.equal((await readdir(join(t.dir, 'blobs'))).length, 2);
    const loaded = await t.store().load(); assert.deepEqual([...(loaded.find(e => e.id === a)!.value as { y: Uint8Array[] }).y[1]!], [9]);
    await store.remove(a); assert.equal((await readdir(join(t.dir, 'blobs'))).length, 1);
    await store.remove(b); assert.deepEqual(await readdir(join(t.dir, 'blobs')), []);
    assert.ok((await readdir(join(t.dir, 'records'))).every(name => !name.endsWith('.tmp')));
    await assert.rejects(store.save('../escape', {}), /invalid/);
  } finally { await t.cleanup(); }
});
test('loading cleans up damaged records, settled temporary files and unreferenced blobs, but keeps recent ones', async () => {
  const t = await temporaryStore();
  try {
    const keep = '44444444-4444-4444-8444-444444444444', lost = '55555555-5555-4555-8555-555555555555';
    const store = t.store(); await store.save(keep, { x: new Uint8Array([1]) }); await store.save(lost, { x: new Uint8Array([2]), y: new Uint8Array([3]) });
    const blobs = join(t.dir, 'blobs'), records = join(t.dir, 'records');
    const hashOf = async (id: string) => (JSON.parse(await (await import('node:fs/promises')).readFile(join(records, `${id}.json`), 'utf8')) as { x: { $blob: string } }).x.$blob;
    await rm(join(blobs, await hashOf(lost)));            // A blob it needs is gone: the record is damaged.
    await writeFile(join(records, '66666666-6666-4666-8666-666666666666.json'), '{broken');
    const orphan = 'f'.repeat(64), fresh = 'e'.repeat(64);
    for (const [dir, name] of [[blobs, orphan], [blobs, fresh], [blobs, 'x.tmp'], [records, 'y.json.tmp'], [blobs, 'notes.txt']] as const) await writeFile(join(dir, name), 'z');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const dir of [blobs, records]) for (const name of await readdir(dir)) if (name !== fresh) await utimes(join(dir, name), old, old);
    const loaded = await t.store().load();
    assert.deepEqual(loaded.map(e => e.id), [keep]);
    assert.deepEqual((await readdir(records)).sort(), [`${keep}.json`]);
    // The kept record's blob, a blob too new to judge, and a file the store did not create remain.
    assert.deepEqual((await readdir(blobs)).sort(), [await hashOf(keep), fresh, 'notes.txt'].sort());
  } finally { await t.cleanup(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posix } from 'node:path';
import { EditHistory } from '../src/history.ts';
import { changeMarker } from '../src/changes.ts';
import type { HistoryHost, FsTarget } from '../src/history.ts';
import type { ChangeText, PreviewSnapshot } from '../src/changes.ts';
import { FileHistoryStore } from '../src/history-store.ts';
import type { HistoryStore } from '../src/history-store.ts';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
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
  const prepare = () => history.prepare(session, { path: '/work/index.html', version: JSON.stringify(files.get('/work/index.html')!.version), instruction: '增大按钮' }, signal);
  const event = (type: string, data: unknown) => { const number = ++seq; history.event(session, { type, data, seq: number }); return number; };
  async function start(id: string, extra = '') { open = ++turn; event('turn/start', { turn }); event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: changeMarker(id) + extra }] }); await history.beforeTool(session, signal); }
  async function end(paths?: string[]) {
    if (paths) { summaries.set(seq + 1, { files: paths.map(path => ({ path })), total: paths.length }); event('workspace/changes', { turn }); }
    open = null; event('turn/end', { turn }); await history.settled(session);
  }
  // reload() simulates a restart: a new history over the same files, reading the given store.
  const reload = async (store: HistoryStore) => { history.dispose(); history = new EditHistory(host, store, options.now); await history.loaded; return history; };
  return { get history() { return history; }, reload, session, signal, prepare, start, end, event, put, files, writes, html, host, fail: (path: string) => { failPath = path; } };
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
test('workspace escape in an asset is rejected before preparing a request', async () => {
  const f = fixture(); f.put('/work/index.html', '<link rel="stylesheet" href="../private.css">'); f.put('/private.css', 'private');
  await assert.rejects(f.prepare, /超出/); assert.equal(f.history.list(f.session).length, 0);
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
  await f.start(second.id); await assert.rejects(f.prepare, /这一轮结束|正在进行/);
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
  f.put('/work/index.html', '<!doctype html><link rel="StyleSheet" href="main.css"><noscript><img src="img/fallback.png"></noscript><p>内容</p>');
  f.put('/work/main.css', '@import url(theme); button{padding:12px}'); f.put('/work/theme', 'body{background:url(img/bg.png)}');
  f.put('/work/img/bg.png', new Uint8Array([1, 2, 3])); f.put('/work/img/fallback.png', new Uint8Array([4]));
  const r = await f.prepare(), before = f.history.content(f.session, r.id, 'before') as PreviewSnapshot;
  assert.deepEqual(before.assets.map(a => a.reference).sort(), ['img/bg.png', 'img/fallback.png', 'main.css', 'theme']);
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
test('a full history drops rolled-back records, then records older than 7 days, oldest first', async () => {
  const day = 24 * 60 * 60 * 1000; let clock = 1_000_000_000_000;
  const f = fixture({ now: () => clock }), ids: string[] = [];
  const cycle = async (content: string) => { const r = await f.prepare(); await f.start(r.id); f.put('/work/main.css', content); await f.end(); clock += 1000; return r.id; };
  for (let i = 0; i < 8; i++) ids.push(await cycle(`v${i}`));
  await assert.rejects(f.prepare, /已满/);
  assert.equal((await f.history.restore(f.session, ids[7]!, f.signal)).state, 'restored');
  const replacement = await cycle('v8');
  assert.deepEqual(f.history.list(f.session).map(x => x.id), [replacement, ...ids.slice(0, 7).reverse()]);
  clock += 8 * day;
  const next = await f.prepare();
  assert.deepEqual(f.history.list(f.session).map(x => x.id), [next.id, replacement, ...ids.slice(1, 7).reverse()]);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posix } from 'node:path';
import { EditHistory } from '../src/history.ts';
import { changeMarker } from '../src/changes.ts';
import type { HistoryHost, FsTarget } from '../src/history.ts';

function fixture() {
  const session = { id: 'one', header: { cwd: '/work' } }, files = new Map<string, { data: Uint8Array; version: string }>();
  let version = 0, seq = 0, turn = 0, open: number | null = null, failPath = '';
  const put = (path: string, data: string | Uint8Array) => files.set(path, { data: typeof data === 'string' ? new TextEncoder().encode(data) : data, version: String(++version) });
  const html = '\ufeff<!doctype html>\r\n<link rel="stylesheet" href="main.css"><button>保留内容</button>\r\n';
  put('/work/index.html', html); put('/work/main.css', 'button{padding:12px;background:var(--brand)}');
  const writes: string[] = [], summaries = new Map<number, { files: { path: string; oldPath?: string }[]; total: number }>();
  const host: HistoryHost = {
    fs: {
      async resolve(path, opts) { const absolute = posix.resolve(opts.cwd ?? '/work', path); return { targetKey: absolute, displayPath: absolute }; },
      contains(root, target) { return target.targetKey === root.targetKey || target.targetKey.startsWith(root.targetKey + '/'); },
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
  const history = new EditHistory(host), signal = new AbortController().signal;
  const prepare = () => history.prepare(session, { path: '/work/index.html', version: JSON.stringify(files.get('/work/index.html')!.version), instruction: '增大按钮' }, signal);
  const event = (type: string, data: unknown) => { const number = ++seq; history.event(session, { type, data, seq: number }); return number; };
  async function start(id: string) { open = ++turn; event('turn/start', { turn }); event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: changeMarker(id) }] }); await history.beforeTool(session, signal); }
  async function end(paths?: string[]) {
    if (paths) { summaries.set(seq + 1, { files: paths.map(path => ({ path })), total: paths.length }); event('workspace/changes', { turn }); }
    open = null; event('turn/end', { turn }); await history.settled(session);
  }
  return { history, session, signal, prepare, start, end, event, put, files, writes, html, host, fail: (path: string) => { failPath = path; } };
}

test('frozen HTML and linked CSS survive later edits; guarded rollback preserves exact BOM and CRLF', async () => {
  const f = fixture(), record = await f.prepare(); await f.start(record.id);
  f.put('/work/index.html', f.html.replace('保留内容', '新内容')); f.put('/work/main.css', 'button{padding:24px}'); await f.end(['index.html', 'main.css']);
  const detail = f.history.detail(f.session, record.id);
  assert.equal(detail.state, 'ready'); assert.equal(detail.files.length, 2); assert.equal(detail.before.source, f.html);
  assert.match(new TextDecoder().decode(detail.before.assets[0]!.data), /padding:12px/);
  assert.match(new TextDecoder().decode(detail.after!.assets[0]!.data), /padding:24px/);
  const result = await f.history.restore(f.session, record.id, f.signal);
  assert.equal(result.state, 'restored'); assert.equal(f.writes.length, 2);
  assert.deepEqual(f.files.get('/work/index.html')!.data, new TextEncoder().encode(f.html));
  assert.match(f.history.detail(f.session, record.id).after!.source, /新内容/);
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

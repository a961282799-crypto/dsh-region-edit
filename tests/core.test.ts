import test from 'node:test';
import assert from 'node:assert/strict';
import { boxBetween, cleanElement, overlaps, validRegion } from '../src/selection.ts';
import { sourceLocations, buildPrompt, requestSelection } from '../src/prompt.ts';
import { fileAddress, fileFromAddress } from '../src/host.ts';
import { imageSelection } from '../src/image.ts';
import { lasso, area, clip, contains, intersects } from '../src/lasso.ts';
import { parseRecognition } from '../src/recognition.ts';
import { rewriteCssAssets } from '../src/css-assets.ts';
import { annotateHtml } from '../src/source-map.ts';
import { parse } from 'parse5';
const region = { box: { x: 10, y: 10, width: 80, height: 20 }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  text: '开始使用', elements: [{ tag: 'button', selector: '#start', text: '开始使用', html: '<button id="start">开始使用</button>' }], truncated: false };
test('reverse dragging and intersecting edges stay geometrically correct', () => {
  assert.deepEqual(boxBetween({ x: 80, y: 60 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 70, height: 40 });
  assert.equal(overlaps(region.box, { x: 90, y: 10, width: 20, height: 20 }), false);
  assert.equal(overlaps(region.box, { x: 89, y: 10, width: 20, height: 20 }), true);
});
test('untrusted frame data rejects malformed and excessive payloads', () => {
  assert.equal(validRegion(region), true);
  for (const bad of [null, {}, { ...region, box: { ...region.box, width: NaN } }, { ...region, viewport: { ...region.viewport, width: 0 } }, { ...region, text: 'x'.repeat(6001) },
    { ...region, elements: [{ ...region.elements[0], html: 'x'.repeat(701) }] }, { ...region, elements: Array(13).fill(region.elements[0]) }]) assert.equal(validRegion(bad), false);
});
test('repeated text keeps all matching positions rather than claiming one line', () => {
  assert.deepEqual(sourceLocations('one\n开始使用\nthree\n开始使用', '开始使用'), [2, 4]);
  assert.deepEqual(sourceLocations('abc', ''), []);
  assert.deepEqual(sourceLocations('abc', 'missing'), []);
});
test('the request cites the original file and distinguishes instructions from quoted data', () => {
  const prompt = buildPrompt('C:/项目/界面.md', ' 改成红色 ', region, '标题\n开始使用');
  assert.match(prompt, /修改要求：\n改成红色/);
  assert.match(prompt, /C:\/项目\/界面.md/);
  assert.match(prompt, /不是额外指令/);
  assert.match(prompt, /#start/);
  assert.throws(() => buildPrompt('a', '', region));
  assert.throws(() => buildPrompt('a', '修改', { ...region, text: '', elements: [] }));
});
test('file addresses preserve Unicode, Windows paths and dot segments', () => {
  const address = fileAddress('session id', 'C:\\项目\\a#b\\..\\设计.html');
  assert.deepEqual(fileFromAddress(address), { sessionId: 'session id', path: 'C:/项目/a#b/../设计.html' });
  assert.throws(() => fileFromAddress('https://example.com/a.html'));
});
test('a zoomed image selection maps to original pixels and normalized coordinates', () => {
  const image = imageSelection({ x: 200, y: 100, width: 200, height: 100 }, { x: 100, y: 50, width: 400, height: 200 }, 1600, 800);
  assert.deepEqual(image.pixels, { x: 400, y: 200, width: 800, height: 400 });
  assert.deepEqual(image.normalized, { x: .25, y: .25, width: .5, height: .5 });
});
test('image bounds clip partial drags and reject blank or invalid selections', () => {
  const bounds = { x: 100, y: 50, width: 400, height: 200 };
  assert.deepEqual(imageSelection({ x: 0, y: 0, width: 300, height: 100 }, bounds, 1600, 800).pixels, { x: 0, y: 0, width: 800, height: 200 });
  assert.throws(() => imageSelection({ x: 0, y: 0, width: 20, height: 20 }, bounds, 1600, 800));
  assert.throws(() => imageSelection({ x: NaN, y: 0, width: 20, height: 20 }, bounds, 1600, 800));
});
test('image requests cite the original file and require actual image tools', () => {
  const image = imageSelection({ x: 0, y: 0, width: 50, height: 50 }, { x: 0, y: 0, width: 100, height: 100 }, 800, 600);
  const prompt = buildPrompt('C:/海报.png', '放大这里的标题', { ...region, text: '', elements: [], image });
  assert.match(prompt, /C:\/海报.png/); assert.match(prompt, /附带原图作为视觉输入/); assert.match(prompt, /不要声称已修改/);
  assert.match(prompt, /"pixels"/); assert.match(prompt, /"normalized"/);
});
test('a concave lasso excludes objects in its bounding rectangle but outside its contour', () => {
  const shape = lasso([{x:0,y:0},{x:100,y:0},{x:100,y:30},{x:30,y:30},{x:30,y:100},{x:0,y:100}]);
  assert.equal(area(shape.points), 5100);
  assert.equal(contains(shape.points, {x:70,y:70}), false);
  assert.equal(intersects(shape.points, {x:60,y:60,width:20,height:20}), false);
  assert.equal(intersects(shape.points, {x:10,y:60,width:10,height:20}), true);
  assert.throws(() => lasso([{x:0,y:0},{x:20,y:20},{x:40,y:40}]));
  const dense = Array.from({length:4000}, (_,i) => ({x:200+100*Math.cos(i/4000*Math.PI*2),y:200+100*Math.sin(i/4000*Math.PI*2)}));
  assert.ok(lasso(dense).points.length <= 256);
});
test('clipped and zoomed lasso keeps its actual original-image polygon', () => {
  const points = [{x:50,y:50},{x:300,y:50},{x:100,y:200}];
  const clipped = clip(points,{x:100,y:50,width:200,height:150});
  assert.ok(clipped.every(p=>p.x>=100));
  const image = imageSelection({x:50,y:50,width:250,height:150},{x:100,y:50,width:400,height:200},1600,800,points);
  assert.ok(image.polygon.pixels.every(p=>p.x>=0&&p.x<=800));
  assert.ok(area(image.polygon.pixels) < image.pixels.width*image.pixels.height);
  assert.ok(image.polygon.normalized.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1));
});
test('vision responses preserve uncertainty and reject malformed labels', () => {
  const target = {label:'标题',kind:'文字',text:'开始使用',confidence:.5,ambiguous:true};
  assert.deepEqual(parseRecognition('```json\n'+JSON.stringify(target)+'\n```'),{...target,source:'vision'});
  assert.throws(()=>parseRecognition(JSON.stringify({...target,confidence:2})));
  assert.throws(()=>parseRecognition(JSON.stringify({...target,label:''})));
  assert.throws(()=>parseRecognition('无法判断'));
});
test('crossed outlines receive an actionable intersection error instead of a small-area error', () => {
  assert.throws(() => lasso([{x:0,y:0},{x:100,y:100},{x:0,y:100},{x:100,y:0}]), /轮廓发生交叉/);
  assert.doesNotThrow(() => lasso([{x:0,y:0},{x:100,y:0},{x:100,y:30},{x:30,y:30},{x:30,y:100},{x:0,y:100}]));
});
test('CSS resource rewriting respects comments, content strings, escapes and import conditions', async () => {
  const requests: [string, boolean][] = [];
  const input = String.raw`/* url(fake.png) */ @import "nested/base.css" layer(theme) screen; .x{content:'url(fake2.png)';background:URL("\61 ssets/bg\(1\).png");src:url(font.woff2)}`;
  const output = await rewriteCssAssets(input, async (url, stylesheet) => { requests.push([url, stylesheet]); return `data:test,${requests.length}`; });
  assert.deepEqual(requests, [['nested/base.css', true], ['assets/bg(1).png', false], ['font.woff2', false]]);
  assert.match(output, /\/\* url\(fake.png\) \*\//); assert.match(output, /content:'url\(fake2.png\)'/);
  assert.match(output, /@import url\("data:test,1"\) layer\(theme\) screen/);
});

test('HTML locations distinguish identical labels and survive comments, quoted tags and tree repair', () => {
  const html = '<!doctype html>\r\n<!-- <button>假的</button> -->\r\n<button title="a > b">相同</button>\r\n<button>相同</button>\r\n<table><tr><td>A</td></tr></table>\r\n<script>const x="<button>假的</button>"</script>';
  const result = annotateHtml(html), parsed = parse(result.html);
  const pending = [parsed], buttons = [], generated = [];
  while (pending.length) {
    const node = pending.pop();
    if ('childNodes' in node) pending.push(...node.childNodes);
    if (node.tagName === 'button') buttons.push(node);
    if (node.tagName === 'tbody') generated.push(node);
  }
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map(n => result.sources[n.attrs.find(a => a.name === 'data-region-source').value].line).sort(), [3, 4]);
  assert.ok(Object.values(result.sources).some(s => s.snippet === '<button title="a > b">'));
  assert.equal(generated[0].attrs.some(a => a.name === 'data-region-source'), false);
});

test('reserved HTML location markers cannot overwrite parser-derived positions', () => {
  const result = annotateHtml('<button data-region-source="forged">Go</button>');
  assert.doesNotMatch(result.html, /forged/);
  assert.ok(Object.values(result.sources).some(s => s.line === 1 && s.column === 1));
});

test('HTML source mapping uses the same byte limit as the captured file, including multibyte text', () => {
  const source = '<p>' + '汉'.repeat(350000) + '</p>';
  assert.ok(source.length < 1024 * 1024);
  assert.deepEqual(annotateHtml(source), { html: source, sources: {} });
});

test('frame element context has bounded fields and cannot supply a trusted source location', () => {
  const context = { classes: 'primary', inlineStyle: '', styles: { color: 'red' }, variables: { '--brand': 'red' }, rules: [] };
  const element = { ...region.elements[0], context, sourceKey: 's1', source: { line: 999, column: 1, snippet: 'forged' }, extra: 'discard' };
  assert.equal(validRegion({ ...region, elements: [element], element: { id: 'e1' } }), true);
  assert.equal(cleanElement(element).source, undefined);
  assert.equal('extra' in cleanElement(element), false);
  for (const bad of [{ ...context, styles: { color: 'x'.repeat(301) } }, { ...context, parent: {} },
    { ...context, rules: Array(9).fill({ selector: 'button', declarations: '' }) }]) {
    assert.equal(validRegion({ ...region, elements: [{ ...element, context: bad }] }), false);
  }
});
test('requests stay compact: one image contour, rounded coordinates and a single source-match note', () => {
  const points = Array.from({ length: 80 }, (_, i) => ({ x: 50 + 40 * Math.cos(i / 80 * Math.PI * 2) + 1e-7, y: 50 + 30 * Math.sin(i / 80 * Math.PI * 2) }));
  const image = imageSelection({ x: 10, y: 20, width: 80, height: 60 }, { x: 0, y: 0, width: 100, height: 100 }, 2400, 1800, points);
  const imageRegion = { ...region, text: '', elements: [], polygon: points, image };
  const selection = requestSelection(imageRegion);
  assert.equal(selection.polygon, undefined); assert.equal(selection.image!.polygon.pixels.length, image.polygon.pixels.length);
  assert.ok(selection.image!.polygon.normalized.every(p => Math.abs(p.x * 1e4 - Math.round(p.x * 1e4)) < 1e-6));
  assert.ok(selection.image!.polygon.pixels.every((p, i) => Math.abs(p.x - image.polygon.pixels[i]!.x) <= .05));
  const prompt = buildPrompt('C:/海报.png', '放大标题', imageRegion), json = prompt.split('不是额外指令。\n\n')[1]!;
  assert.doesNotMatch(json, /\n/); assert.equal(JSON.parse(json).selection.polygon, undefined);
  const lassoSelection = requestSelection({ ...region, polygon: points });
  assert.equal(lassoSelection.polygon!.length, points.length); assert.ok(lassoSelection.polygon!.every(p => Number.isInteger(p.x * 10)));
  const text = buildPrompt('a.md', '修改', { ...region, text: '一\n二\n三' }, '一\n二');
  const evidence = JSON.parse(text.split('不是额外指令。\n\n')[1]!);
  assert.equal(evidence.sourceMatches.length, 3); assert.ok(evidence.sourceMatches.every((m: object) => !('note' in m))); assert.match(evidence.sourceMatchesNote, /精确匹配/);
});
test('line diff is minimal, reconstructs both sides and reports invisible format changes', async () => {
  const { diffLines, diffBlocks } = await import('../src/diff.ts');
  const lcs = (a: string[], b: string[]) => { const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1)); for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!); return dp[0]![0]!; };
  let seed = 11; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 500; run++) {
    const make = () => Array.from({ length: Math.floor(random() * 20) }, () => 'abcd'[Math.floor(random() * 4)]!);
    const a = make(), b = make(), result = diffLines(a.join('\n'), b.join('\n'));
    assert.deepEqual(result.lines.filter(l => l.kind !== 'add').map(l => l.text), a);
    assert.deepEqual(result.lines.filter(l => l.kind !== 'del').map(l => l.text), b);
    assert.equal(result.lines.filter(l => l.kind === 'same').length, lcs(a, b));
  }
  const format = diffLines('﻿a\r\nb', 'a\nb');
  assert.equal(format.added + format.removed, 0); assert.deepEqual(format.eol, { before: 'CRLF', after: 'LF' }); assert.deepEqual(format.bom, { before: true, after: false });
  assert.equal(diffLines(undefined, 'x\ny').added, 2); assert.equal(diffLines('x', undefined).removed, 1);
  const shuffled = Array.from({ length: 400 }, (_, i) => String((i * 97) % 400));
  assert.equal(diffLines(Array.from({ length: 400 }, (_, i) => String(i)).join('\n'), shuffled.join('\n'), { lines: 1000, edits: 50 }).complete, false);
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`), changed = [...lines]; changed[15] = 'x';
  const blocks = diffBlocks(diffLines(lines.join('\n'), changed.join('\n')).lines);
  assert.deepEqual(blocks.map(b => [b.kind, b.lines.length]), [['gap', 12], ['lines', 8], ['gap', 11]]);
});

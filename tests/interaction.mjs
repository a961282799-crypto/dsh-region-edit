import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireTool } from '../scripts/toolchain.mjs';
const { chromium } = requireTool('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, deviceScaleFactor: 1.25 });
page.setDefaultTimeout(5000);
const failures = [], passed = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const react = await readFile(resolve(dirname(requireTool.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = await readFile(resolve(dirname(requireTool.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const plugin = await readFile('dist/client.js', 'utf8');
const source = `<!doctype html><html><head><style>body{font:16px system-ui;padding:32px;margin:0}button{font:inherit;padding:12px 22px;background:#202a35;color:white;border:0;border-radius:7px}h2{margin:0 0 24px}p{margin:20px 0}</style></head><body><h2>我的工具</h2><p id="chosen">这里是需要修改的说明文字。</p><button id="start">开始使用</button><p id="other">不要修改这一段文字。</p><script>window.exampleRan=true</script></body></html>`;
async function fixture(mode = 'text', desktop = true, previewSource = source, assets = {}) {
  errors.length = 0;
  await page.goto('about:blank');
  await page.setContent('<!doctype html><style>body{margin:0;background:#f7f8fa;font:14px system-ui}.app{display:flex;height:850px}.chat{width:460px;padding:30px;background:white}.preview{margin:36px 20px 36px 0;width:680px;height:760px;border:1px solid #ddd;background:white;display:flex;flex-direction:column}header{padding:10px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between}.body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}.text{padding:32px;font-size:16px}.text p{margin:24px 0}.text h2{margin-top:0}</style><div id="app"></div>');
  await page.addScriptTag({ content: react }); await page.addScriptTag({ content: reactDom });
  await page.evaluate(desktop => {
    window.dshDesktop = desktop ? { protocolVersion: 1 } : undefined;
    window.__ModuleLoader__ = { load({ factory }) { window.plugin = factory(name => {
      if (name === 'react') return window.React;
      if (name === 'react-dom') return window.ReactDOM;
      if (name === 'react/jsx-runtime') return { Fragment: window.React.Fragment,
        jsx: (type, props, key) => window.React.createElement(type, { ...props, key }),
        jsxs: (type, props, key) => window.React.createElement(type, { ...props, key }) };
      throw new Error('Unexpected runtime dependency: ' + name);
    }); } };
  }, desktop);
  await page.addScriptTag({ content: plugin });
  await page.evaluate(({ mode, source, assets }) => {
    const records = window.records = { sent: [], notices: [], draft: { text: '原有草稿', references: [{ offset: 0, clipboardText: '原有草稿', source: 'test' }] },
      version: 1, current: true, fail: false, interactive: false, reads: 0, registrations: [], disposers: [], recognitionRequests: [], recognitionFail: false, recognitionDelay: 0, aborted: 0, imageParts: [], attachmentIds: ['existing-image'] };
    const controller = new AbortController();
    const path = mode === 'html' ? 'C:/测试/界面.html' : mode === 'image' ? 'C:/测试/图片.png' : 'C:/测试/说明.md';
    const text = mode === 'html' ? source : '我的工具\n这里是需要修改的说明文字。\n开始使用\n不要修改这一段文字。';
    records.sourceText = text; records.changes = [];
    records.assetReads = []; records.watchedResources = [];
    const files = new Map();
    const input = { get draftSnapshot() { return records.draft; }, setDraft(value) { records.draft = value; }, addAttachments(ids) { records.attachmentIds.push(...ids); return true; }, focus() { records.focused = true; }, notify(level, text) { records.notices.push({ level, text }); } };
    const conversation = { async send(prompt) { if (records.fail) throw new Error('测试：发送失败'); records.sent.push(prompt); }, input: { for: () => input },
      createDrafts(_session, originals) { return originals.map(file => { const id = 'original-'+files.size; files.set(id,file); return {id}; }); }, releaseDraftAttachment(id) { files.delete(id); },
      async sendSession(_session, prompt, ids) { if (records.fail) throw new Error('测试：发送失败'); for(const id of ids) { const file = files.get(id); records.imageParts.push({name:file.name,type:file.type,bytes:[...new Uint8Array(await file.arrayBuffer())]}); } records.sent.push(prompt); return {kind:'success'}; } };
    const host = { effect(fn) { const dispose = fn(); if (dispose) records.disposers.push(dispose); },
      slots: { inject(_name, register) { return register(); }, register(options, Component) { records.registrations.push({ options, Component }); return () => {}; } },
      sidebarRight: { focusedTarget: () => ({ sessionId: 'qa', tabId: 'preview' }), isTargetCurrent: () => records.current },
      remote: { workspaceFiles: { async stat() { return { ok: true, value: { absolutePath: path, version: records.version, bytes: records.sourceText.length * 3 } }; },
        async readBytes(_sessionId,reference,options) { records.reads++;
          if(options?.baseFile){records.assetReads.push(reference);if(!(reference in assets))throw new Error('Missing fixture asset: '+reference);const value=assets[reference];return {ok:true,value:{data:typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value),version:1,absolutePath:'C:/测试/'+reference}};}
          return { ok: true, value: { data: mode==='image'?new Uint8Array([137,80,78,71,13,10,26,10,42]):new TextEncoder().encode(records.sourceText), version: records.version, absolutePath: path } }; } } },
      connection: { rpc: { async call(channel, endpoint, payload, signal) {
        if (endpoint !== 'regionEdit/recognize') {
          if(channel!=='/api'||Object.keys(payload).length!==1||payload.args?.agentId!=='qa') throw new Error('Unexpected history RPC envelope');
          const request=payload.args.request, clone=value=>structuredClone(value);
          if(endpoint==='regionEdit/listChanges') return {ok:true,value:clone(records.changes)};
          if(endpoint==='regionEdit/prepareChange') {
            if(records.historyFail) throw new Error('无法保存修改前的文件');
            const change={id:'change-'+(records.changes.length+1),path,created:Date.now(),instruction:request.instruction,state:'prepared',files:[],problems:[],texts:[],
              before:{source:records.sourceText,assets:Object.entries(assets).map(([reference,data])=>({reference,data:typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data)}))}};
            records.changes.unshift(change); return {ok:true,value:clone(change)};
          }
          const change=records.changes.find(c=>c.id===request.id);if(!change)throw new Error('记录已失效');
          if(endpoint==='regionEdit/changeDetail')return{ok:true,value:clone(change)};
          if(endpoint==='regionEdit/removeChange'){records.changes=records.changes.filter(c=>c!==change);return{ok:true,value:true};}
          if(endpoint==='regionEdit/restoreChange'){
            if(records.restoreConflict)change.error='文件后来又被修改，已停止回滚：main.css';
            else{change.state='restored';change.files.forEach(f=>f.restored=true);delete change.error;}
            return{ok:true,value:clone(change)};
          }
          throw new Error('Unexpected history method');
        }
        if(channel!=='/api'||endpoint!=='regionEdit/recognize'||Object.keys(payload).length!==1||!payload.args||payload.args.agentId!=='qa') throw new Error('Unexpected RPC envelope'); records.recognitionRequests.push(payload.args);
        if(records.recognitionDelay) await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,records.recognitionDelay);signal.addEventListener('abort',()=>{records.aborted++;if(!records.recognitionIgnoresAbort){clearTimeout(timer);reject(new Error('aborted'));}},{once:true});});
        if(records.recognitionFail) return {ok:false,error:{code:'test',message:'测试：视觉识别失败'}};
        return {ok:true,value:records.recognitionValue??{label:'圈内测试标题',kind:'文字',text:'圈选测试原图',confidence:.95,ambiguous:false}};
      } } },
      sessions: { scope: () => ({ get: () => conversation }), binding:()=>({session:{sessionId:'qa'}}) },
      documentPreviews: { register() { return () => {}; } },
      configForms: { developerTools: { enabled: { getSnapshot: () => records.interactive, subscribe: () => () => {} } } } };
    // Cordis requires declaring the root service as well as a nested Remote namespace.
    const guardedHost = new Proxy(host, { get(target, property, receiver) {
      if (typeof property === 'string' && property !== 'effect' && property in target && !window.plugin.inject.includes(property)) {
        throw new Error(`cannot get property "${property}" without inject`);
      }
      return Reflect.get(target, property, receiver);
    } });
    window.plugin.apply(guardedHost);
    const action = records.registrations.find(r => r.options.id === 'dsh-region-edit');
    const html = records.registrations.find(r => r.options.key === 'dsh-region-edit/html');
    const props = action?.options.inject('qa'), htmlProps = html?.options.inject('qa');
    const root = ReactDOM.createRoot(document.querySelector('#app'));
    const tab = { tab: { id: 'preview', contentId: 'dsh-resource://file/session/qa/C:/测试/界面.html', signal: controller.signal, visible: true } };
    const data = new TextEncoder().encode(source);
    const addResource = value => records.watchedResources.push(value), setResources = values => {records.watchedResources=[...values];};
    const imageUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#a3c5e8"/><text x="80" y="100" font-size="36">圈选测试原图</text></svg>');
    window.rerender = () => root.render(React.createElement('div', { className: 'app' },
      React.createElement('aside', { className: 'chat' }, React.createElement('h2', null, 'DeepSeek Harness'), React.createElement('p', null, '桌面插件交互测试'), React.createElement('p', null, '请在右侧预览中圈选要修改的位置。')),
      React.createElement('section', { className: 'preview', 'data-textpreview-url': path },
        React.createElement('header', null, React.createElement('span', null, path.split('/').pop()), action && React.createElement(action.Component, { ...props, absolutePath: path })),
        React.createElement('div', { className: 'body', 'data-textpreview-body': '' },
          mode === 'html' && html ? React.createElement(html.Component, { ...htmlProps, content: { kind: 'bytes', data }, resourceAddress: tab.tab.contentId,
            useTabInfo: () => tab, useInteractivePreview: selector => selector(records.interactive), addResource, setResources })
            : mode === 'image' ? React.createElement('div', { 'data-image-preview': '', style: { padding: 32 } },
              React.createElement('img', { id: 'image', src: imageUrl, alt: '图片预览：测试原图', style: { width: 320, height: 240, display: 'block' } }))
              : React.createElement('div', { className: 'text' }, React.createElement('h2', null, '我的工具'), React.createElement('p', { id: 'chosen' }, '这里是需要修改的说明文字。'), React.createElement('button', { id: 'start' }, '开始使用'), React.createElement('p', { id: 'other' }, '不要修改这一段文字。'))))));
    window.rerender();
  }, { mode, source: previewSource, assets });
  if (desktop) await page.locator('[data-region-edit]').waitFor();
}
async function pick(selector = '#chosen', frame = false, reverse = false) {
  if (frame) await page.locator('[data-region-connected]').waitFor();
  const target = frame ? page.frameLocator('[data-region-frame]').locator(selector) : page.locator(selector);
  if(frame) await target.evaluate(()=>document.readyState==='complete'?undefined:new Promise(resolve=>window.addEventListener('load',resolve,{once:true})));
  const box = await target.boundingBox(); assert.ok(box);
  if(!await page.locator('.re-layer').count()) await page.locator('[data-region-edit]').click(); await page.locator('.re-layer').waitFor();
  if (frame) await page.getByRole('button', { name: '自由圈选', exact: true }).click();
  const points=[{x:box.x-3,y:box.y+4},{x:box.x+6,y:box.y-3},{x:box.x+box.width-6,y:box.y-3},{x:box.x+box.width+3,y:box.y+4},{x:box.x+box.width+3,y:box.y+box.height-4},{x:box.x+box.width-6,y:box.y+box.height+3},{x:box.x+6,y:box.y+box.height+3},{x:box.x-3,y:box.y+box.height-4}];
  await trace(reverse?points.reverse():points);
  await page.locator('.re-panel').waitFor();
}
async function trace(points) {
  // Wait for the new overlay to receive pointer events above an out-of-process iframe.
  const layer=page.locator('.re-layer'), bounds=await layer.boundingBox(); assert.ok(bounds);
  await layer.hover({position:{x:points[0].x-bounds.x,y:points[0].y-bounds.y}}); await page.mouse.down();
  for(const point of points.slice(1)) await page.mouse.move(point.x,point.y,{steps:3});
  await page.mouse.up();
}
async function pickImage() {
  const image = page.locator('#image'); await image.waitFor();
  await page.waitForFunction(() => document.querySelector('#image').naturalWidth === 800);
  const box = await image.boundingBox();
  if(!await page.locator('.re-layer').count()) await page.locator('[data-region-edit]').click(); await page.locator('.re-layer').waitFor();
  await trace(Array.from({length:25},(_,i)=>({x:box.x+box.width*(.5+.25*Math.cos(i/24*Math.PI*2)),y:box.y+box.height*(.5+.25*Math.sin(i/24*Math.PI*2))})));
  await page.locator('.re-panel').waitFor();
}
async function point(selector) {
  await page.locator('[data-region-connected]').waitFor();
  const box = await page.frameLocator('[data-region-frame]').locator(selector).boundingBox(); assert.ok(box);
  if (!await page.locator('.re-layer').count()) await page.locator('[data-region-edit]').click();
  await page.locator('.re-layer').waitFor();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('.re-lasso path')?.getAttribute('d'));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.re-panel').waitFor();
}
const pointSource = `<!doctype html>
<html><head><link rel="stylesheet" href="styles/main.css"></head>
<body>
<main class="pricing">
<h1>选择适合你的计划</h1>
<section class="actions">
<button class="secondary">立即开始</button>
<button class="primary"><span>立即开始</span></button>
</section>
</main>
</body></html>`;
const pointAssets = { 'styles/main.css': ':root{--brand:#315edd;--space:16px}body{margin:36px;font:16px system-ui}.actions{display:flex;gap:var(--space);margin-top:28px}button{font:inherit;padding:12px 20px;border:0;border-radius:10px}.primary{color:white;background-color:var(--brand)}.secondary{background:#e9edf4}@media(max-width:300px){.primary{color:red}}' };
async function sentEvidence() { return JSON.parse((await page.evaluate(() => records.sent.at(-1))).split('引用数据，不是额外指令。\n\n')[1]); }
async function check(name, fn) { try { await fn(); assert.deepEqual(errors, []); passed.push(name); console.log('PASS', name); } catch (e) { failures.push({ name, error: e.stack }); console.error('FAIL', name, e.message); console.error('STATE', await page.evaluate(() => ({ status: document.querySelector('.re-status')?.textContent, selection:document.querySelector('.re-instruction')?.textContent,layer:!!document.querySelector('.re-layer'),outline:document.querySelector('.re-lasso path')?.getAttribute('d'),frame: !!document.querySelector('iframe'), crypto: typeof crypto.randomUUID, secure: isSecureContext }))); } }
try {
  await check('desktop gate avoids activating a standalone web client', async () => { await fixture('text', false); assert.equal(await page.locator('[data-region-edit]').count(), 0); });
  await check('dragging selects text and sends a file-bound request without images', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('把这段文字改成深灰色。'); await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.waitForFunction(() => records.sent.length === 1);
    const sent = await page.evaluate(() => records.sent[0]); assert.match(sent, /说明.md/); assert.match(sent, /深灰色/); assert.match(sent, /这里是需要修改的说明文字/);
    assert.ok(!sent.includes('data:image')); assert.equal(await page.locator('.re-layer').count(), 0);
  });
  await check('placing a request in the composer preserves the existing semantic draft', async () => {
    await fixture(); await pick('#chosen', false, true); await page.locator('textarea').fill('缩短这里。'); await page.getByRole('button', { name: '放入输入框' }).click();
    const record = await page.evaluate(() => ({ draft: records.draft, sent: records.sent }));
    assert.ok(record.draft.text.startsWith('原有草稿\n\n')); assert.deepEqual(record.draft.references, [{ offset: 0, clipboardText: '原有草稿', source: 'test' }]); assert.equal(record.sent.length, 0);
  });
  await check('a source revision change blocks stale edits and retains the instruction', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('保留我的输入'); await page.evaluate(() => { records.version++; });
    await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '原文件已更新' }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), '保留我的输入'); assert.equal(await page.evaluate(() => records.sent.length), 0);
  });
  await check('switching away from the captured session blocks submission', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('修改'); await page.evaluate(() => { records.current = false; }); await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '当前预览已切换' }).waitFor(); assert.equal(await page.evaluate(() => records.sent.length), 0);
  });
  await check('live content changes cannot silently move the selected target', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('修改'); await page.evaluate(() => { document.querySelector('#chosen').textContent = '现在内容变了'; });
    await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '选区内容已变化' }).waitFor();
  });
  await check('failed delivery leaves the input available for retry', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('请保留'); await page.evaluate(() => { records.fail = true; }); await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '发送失败' }).waitFor(); assert.equal(await page.locator('textarea').inputValue(), '请保留');
    await page.evaluate(() => { records.fail = false; }); await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.waitForFunction(() => records.sent.length === 1);
  });
  await check('Escape cancels and removes the selection layer', async () => { await fixture(); await pick(); await page.keyboard.press('Escape'); assert.equal(await page.locator('.re-layer').count(), 0); });
  await check('image previews allow selecting an original-file region without capture', async () => {
    await fixture('image'); assert.equal(await page.locator('[data-region-edit]').isDisabled(), false); await pickImage();
    assert.match(await page.locator('.re-quote').textContent(), /已自由圈选图片区域/);
    await page.locator('textarea').fill('把选中区域改成蓝色'); await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.waitForFunction(() => records.sent.length === 1);
    const prompt = await page.evaluate(() => records.sent[0]), data = JSON.parse(prompt.slice(prompt.indexOf('{\n')));
    assert.equal(data.file, 'C:/测试/图片.png'); assert.equal(data.selection.image.width, 800); assert.equal(data.selection.image.height, 600);
    assert.ok(Math.abs(data.selection.image.pixels.x - 200) <= 3); assert.ok(Math.abs(data.selection.image.pixels.y - 150) <= 3);
    assert.ok(Math.abs(data.selection.image.pixels.width - 400) <= 3); assert.ok(Math.abs(data.selection.image.pixels.height - 300) <= 3);
    assert.ok(!prompt.includes('data:image'));
    const record=await page.evaluate(()=>({images:records.imageParts,requests:records.recognitionRequests}));
    assert.deepEqual(record.images,[{name:'图片.png',type:'image/png',bytes:[137,80,78,71,13,10,26,10,42]}]);
    assert.ok(record.requests[0].request.image.polygon.normalized.length>4);
    assert.equal(data.target.label,'圈内测试标题');
  });
  await check('image region references can be staged while preserving existing drafts', async () => {
    await fixture('image'); await pickImage(); await page.locator('textarea').fill('修改圈内标题'); await page.getByRole('button', { name: '放入输入框' }).click();
    await page.waitForFunction(()=>records.draft.text.includes('"normalized"'));
    const draft = await page.evaluate(() => records.draft); assert.ok(draft.text.startsWith('原有草稿\n\n')); assert.match(draft.text, /图片.png/); assert.match(draft.text, /"normalized"/);
    assert.equal(await page.evaluate(()=>records.attachmentIds.length),2);
  });
  await check('changing image zoom blocks a stale image selection', async () => {
    await fixture('image'); await pickImage(); await page.locator('textarea').fill('修改');
    await page.evaluate(() => { Object.assign(document.querySelector('#image').style, { width: '480px', height: '360px' }); });
    await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '选区内容已变化' }).waitFor();
    assert.equal(await page.evaluate(() => records.sent.length), 0);
  });
  await check('a concave freehand outline excludes text inside the bounding rectangle but outside the lasso', async () => {
    await fixture();
    await page.evaluate(()=>{document.querySelector('[data-textpreview-body]').innerHTML='<div id="lasso-case" style="position:relative;width:600px;height:500px"><span style="position:absolute;left:20px;top:20px">圈内甲</span><span style="position:absolute;left:220px;top:180px">圈外乙</span><span style="position:absolute;left:20px;top:230px">圈内丙</span></div>';});
    const box=await page.locator('#lasso-case').boundingBox();await page.locator('[data-region-edit]').click();await page.locator('.re-layer').waitFor();
    await trace([{x:5,y:5},{x:360,y:5},{x:360,y:70},{x:100,y:70},{x:100,y:330},{x:5,y:330}].map(p=>({x:p.x+box.x,y:p.y+box.y})));
    await page.locator('.re-panel').waitFor();const quote=await page.locator('.re-quote').textContent();
    assert.match(quote,/圈内甲/);assert.match(quote,/圈内丙/);assert.doesNotMatch(quote,/圈外乙/);
    assert.equal(await page.locator('.re-box').count(),0);assert.match(await page.locator('.re-lasso path').getAttribute('d'),/Z$/);
  });
  await check('a corrected target is carried with the original image and actual freehand polygon', async () => {
    await fixture('image');await pickImage();await page.getByLabel('圈中的目标',{exact:true}).fill('我指定的海报主标题');
    await page.locator('textarea').fill('改成蓝色');await page.getByRole('button',{name:'发送修改',exact:true}).click();await page.waitForFunction(()=>records.sent.length===1);
    const prompt=await page.evaluate(()=>records.sent[0]),data=JSON.parse(prompt.slice(prompt.indexOf('{\n')));
    assert.equal(data.target.label,'我指定的海报主标题');assert.equal(data.target.source,'user');assert.equal(data.target.text,'');assert.ok(data.selection.image.polygon.normalized.length>4);
  });
  await check('reselecting cancels recognition and cannot apply its stale response', async () => {
    await fixture('image');await page.evaluate(()=>{records.recognitionDelay=1500;});await pickImage();
    await page.waitForFunction(()=>records.recognitionRequests.length===1);await page.getByRole('button',{name:'重选',exact:true}).click();
    await page.waitForFunction(()=>records.aborted===1);await page.evaluate(()=>{records.recognitionDelay=0;});
    await pickImage();await page.waitForFunction(()=>records.recognitionRequests.length===2);await page.getByLabel('圈中的目标',{exact:true}).fill('新的对象');
    assert.equal(await page.getByLabel('圈中的目标',{exact:true}).inputValue(),'新的对象');
  });
  await check('recognition failure permits a manual target while retaining native image input', async () => {
    await fixture('image');await page.evaluate(()=>{records.recognitionFail=true;});await pickImage();
    await page.getByRole('alert').filter({hasText:'视觉识别失败'}).waitFor();await page.getByLabel('圈中的目标',{exact:true}).fill('圈内标题');
    await page.locator('textarea').fill('加大字号');await page.getByRole('button',{name:'发送修改',exact:true}).click();await page.waitForFunction(()=>records.sent.length===1);
    assert.equal(await page.evaluate(()=>records.imageParts.length),1);
  });
  await check('uncertain recognition is surfaced for correction instead of asserted as certain', async () => {
    await fixture('image');await page.evaluate(()=>{records.recognitionValue={label:'标题或图案',kind:'多个对象',text:'',confidence:.4,ambiguous:true};});await pickImage();
    await page.getByText('识别存在歧义，请确认或修改目标名称。',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('圈中的目标',{exact:true}).inputValue(),'标题或图案');
  });
  await check('isolated preview supports selecting a rendered button without parent access', async () => {
    await fixture('html'); const frame = page.frameLocator('[data-region-frame]'); await frame.locator('#start').waitFor();
    assert.equal(await frame.locator('body').evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
    assert.equal(await frame.locator('body').evaluate(() => window.exampleRan), undefined);
    await pick('#start', true); await page.locator('textarea').fill('按钮换成红色，增加圆角。');
    await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.waitForFunction(() => records.sent.length === 1);
    const prompt = await page.evaluate(() => records.sent[0]); assert.match(prompt, /#start/); assert.match(prompt, /界面.html/); assert.match(prompt, /红色/);
  });
  await check('the host code-tool switch controls original preview scripts', async () => {
    await fixture('html'); await page.frameLocator('[data-region-frame]').locator('#start').waitFor();
    await page.evaluate(() => { records.interactive = true; rerender(); });
    await page.waitForFunction(() => document.querySelector('[data-region-frame]')?.getAttribute('srcdoc')?.includes('exampleRan=true'));
    await page.frameLocator('[data-region-frame]').locator('body').evaluate(() => window.exampleRan).then(value => assert.equal(value, true));
  });
  await check('the packaged code has no screen-capture or recording dependency', async () => {
    assert.doesNotMatch(plugin, /capturePage|getDisplayMedia|desktopCapturer|toDataURL|html2canvas|dom-to-image/);
    const pkg = JSON.parse(await readFile('package.json', 'utf8')); assert.equal(pkg.dependencies, undefined);
  });
  await check('window resizing invalidates the selection but preserves the written instruction', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('请保留这段已经写好的要求');
    try {
      await page.setViewportSize({width:1200,height:820});
      await page.locator('.re-instruction').waitFor(); assert.equal(await page.locator('.re-panel').count(),0);
      await pick(); assert.equal(await page.locator('textarea').inputValue(),'请保留这段已经写好的要求');
      await page.getByRole('button',{name:'发送修改',exact:true}).click();
      await page.waitForFunction(()=>records.sent.length===1);
    } finally { await page.setViewportSize({width:1200,height:850}); }
  });
  await check('sidebar resizing preserves input and cancels pending image recognition', async () => {
    await fixture('image'); await page.evaluate(()=>{records.recognitionDelay=30000;}); await pickImage();
    await page.locator('textarea').fill('调整这里');
    await page.evaluate(()=>{document.querySelector('.preview').style.width='500px';});
    await page.locator('.re-instruction').waitFor(); await page.waitForFunction(()=>records.aborted===1);
    await page.evaluate(()=>{records.recognitionDelay=0;}); await pickImage();
    assert.equal(await page.locator('textarea').inputValue(),'调整这里');
  });
  await check('reselecting refreshes the file version and source line matches', async () => {
    await fixture(); await pick(); await page.locator('textarea').fill('保留要求并读取新文件');
    await page.evaluate(()=>{records.version++;records.sourceText='新增前言\n'+records.sourceText;});
    await page.getByRole('button',{name:'发送修改',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'原文件已更新'}).waitFor();
    await page.getByRole('button',{name:'重选',exact:true}).click(); await page.locator('.re-instruction').waitFor(); await pick();
    assert.equal(await page.locator('textarea').inputValue(),'保留要求并读取新文件');
    await page.getByRole('button',{name:'发送修改',exact:true}).click(); await page.waitForFunction(()=>records.sent.length===1);
    const prompt=await page.evaluate(()=>records.sent[0]), data=JSON.parse(prompt.slice(prompt.indexOf('{\n')));
    assert.deepEqual(data.sourceMatches[0].lines,[3]);
  });
  await check('isolated HTML selects decorative SVG, images and blank backgrounds without hidden targets', async () => {
    await fixture('html',true,`<!doctype html><html><body style="margin:24px">
      <div style="position:relative"><svg id="icon" aria-hidden="true" width="90" height="90"><circle cx="45" cy="45" r="40" fill="blue"/></svg>
      <svg id="hidden-icon" style="position:absolute;left:0;top:0;opacity:0" width="90" height="90"><circle cx="45" cy="45" r="40"/></svg></div>
      <img id="graphic" width="90" height="90" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='90'%3E%3Crect width='90' height='90' fill='blue'/%3E%3C/svg%3E">
      <div id="background" style="width:90px;height:90px;background:#acc"></div></body></html>`);
    for (const [selector,label] of [['#icon','SVG 图标'],['#graphic','图片'],['#background','背景区域']]) {
      await pick(selector,true); assert.equal(await page.getByLabel('圈中的目标',{exact:true}).inputValue(),label);
      await page.locator('textarea').fill('改成蓝色'); await page.getByRole('button',{name:'发送修改',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.re-layer'));
      const prompt=await page.evaluate(()=>records.sent.at(-1)), data=JSON.parse(prompt.slice(prompt.indexOf('{\n')));
      assert.equal(data.selection.elements[0].selector,selector);
      assert.ok(data.selection.elements.every(e=>e.selector!=='#hidden-icon'));
    }
    assert.equal(await page.evaluate(()=>records.sent.length),3);
  });
  await check('manual mode aborts slow recognition and sends the chosen target with the original image', async () => {
    await fixture('image'); await page.evaluate(()=>{records.recognitionDelay=30000;}); await pickImage();
    await page.locator('textarea').fill('把标题改蓝');
    await page.getByRole('button',{name:'停止识别，手动指定',exact:true}).click();
    await page.waitForFunction(()=>records.aborted===1); await page.getByLabel('圈中的目标',{exact:true}).fill('海报主标题');
    assert.equal(await page.getByRole('button',{name:'放入输入框',exact:true}).isDisabled(),false);
    await page.getByRole('button',{name:'发送修改',exact:true}).click(); await page.waitForFunction(()=>records.sent.length===1);
    const prompt=await page.evaluate(()=>records.sent[0]),data=JSON.parse(prompt.slice(prompt.indexOf('{\n')));
    assert.equal(data.target.label,'海报主标题'); assert.equal(data.target.source,'user'); assert.equal(data.target.text,'');
    assert.equal(await page.evaluate(()=>records.imageParts.length),1);
  });
  await check('a late recognition response cannot overwrite a manually entered target', async () => {
    await fixture('image'); await page.evaluate(()=>{records.recognitionDelay=600;records.recognitionIgnoresAbort=true;}); await pickImage();
    await page.getByRole('button',{name:'停止识别，手动指定',exact:true}).click();
    await page.getByLabel('圈中的目标',{exact:true}).fill('手动指定的对象'); await page.waitForTimeout(750);
    assert.equal(await page.getByLabel('圈中的目标',{exact:true}).inputValue(),'手动指定的对象');
    await page.locator('textarea').fill('修改这里'); await page.getByRole('button',{name:'放入输入框',exact:true}).click();
    assert.match(await page.evaluate(()=>records.draft.text),/手动指定的对象/);
  });
  await check('the overflowing panel scrolls with the wheel in a small window', async () => {
    try {
      await page.setViewportSize({width:1200,height:360}); await fixture(); await pick();
      const dimensions=await page.locator('.re-panel').evaluate(el=>{el.scrollTop=0;return {height:el.clientHeight,total:el.scrollHeight};});
      assert.ok(dimensions.total>dimensions.height);
      const box=await page.locator('.re-panel').boundingBox(); await page.mouse.move(box.x+box.width/2,box.y+50); await page.mouse.wheel(0,500);
      await page.waitForFunction(()=>document.querySelector('.re-panel')?.scrollTop>0);
      assert.equal(await page.locator('.re-panel').count(),1);
    } finally { await page.setViewportSize({width:1200,height:850}); }
  });
  await check('ancestor opacity and overflow clipping exclude invisible text from the selected target', async () => {
    for(const hidden of ['<div style="opacity:0;position:absolute;left:30px;top:100px"><span>不可见的旧标题</span></div>',
      '<div style="position:absolute;left:30px;top:30px;width:200px;height:20px;overflow:hidden"><span style="position:absolute;left:0;top:70px;white-space:nowrap">不可见的旧标题</span></div>']) {
      await fixture(); await page.evaluate(hidden=>{document.querySelector('[data-textpreview-body]').innerHTML='<div style="position:relative;width:500px;height:400px">'+hidden+'<span id="visible" style="position:absolute;left:30px;top:100px">用户看见的新标题</span></div>';},hidden);
      await pick('#visible'); assert.equal(await page.locator('.re-quote').textContent(),'用户看见的新标题');
      await page.locator('textarea').fill('修改可见标题'); await page.getByRole('button',{name:'发送修改',exact:true}).click(); await page.waitForFunction(()=>records.sent.length===1);
      const prompt=await page.evaluate(()=>records.sent[0]),data=JSON.parse(prompt.slice(prompt.indexOf('{\n')));
      assert.equal(data.selection.text,'用户看见的新标题'); assert.ok(data.selection.elements.every(e=>!e.text.includes('不可见')));
    }
  });
  await check('manual mode and target survive resizing and require confirmation before reuse', async () => {
    await fixture('image'); await page.evaluate(()=>{records.recognitionDelay=30000;}); await pickImage();
    await page.getByRole('button',{name:'停止识别，手动指定',exact:true}).click();
    await page.getByLabel('圈中的目标',{exact:true}).fill('右上方的校徽'); await page.locator('textarea').fill('缩小一点');
    try {
      await page.setViewportSize({width:1200,height:820}); await page.locator('.re-instruction').waitFor(); await pickImage();
      assert.equal(await page.getByLabel('圈中的目标',{exact:true}).inputValue(),'右上方的校徽');
      assert.equal(await page.getByLabel('圈中的目标',{exact:true}).isDisabled(),false);
      assert.equal(await page.locator('textarea').inputValue(),'缩小一点');
      assert.equal(await page.evaluate(()=>records.recognitionRequests.length),1);
      assert.equal(await page.getByRole('button',{name:'发送修改',exact:true}).isDisabled(),true);
      await page.locator('textarea').press('Control+Enter'); assert.equal(await page.evaluate(()=>records.sent.length),0);
      await page.getByRole('button',{name:'确认沿用此目标',exact:true}).click();
      await page.getByRole('button',{name:'发送修改',exact:true}).click(); await page.waitForFunction(()=>records.sent.length===1);
    } finally {await page.setViewportSize({width:1200,height:850});}
  });
  await check('editing a retained target confirms it and explicit recognition restores automatic mode', async () => {
    await fixture('image'); await pickImage(); await page.getByLabel('圈中的目标',{exact:true}).fill('原目标'); await page.locator('textarea').fill('修改');
    await page.getByRole('button',{name:'重选',exact:true}).click(); await page.locator('.re-instruction').waitFor(); await pickImage();
    await page.getByLabel('圈中的目标',{exact:true}).fill('新目标');
    assert.equal(await page.getByRole('button',{name:'发送修改',exact:true}).isDisabled(),false);
    assert.equal(await page.evaluate(()=>records.recognitionRequests.length),1);
    await page.getByRole('button',{name:'重新识别',exact:true}).click(); await page.waitForFunction(()=>records.recognitionRequests.length===2);
    await page.waitForFunction(()=>document.querySelector('#re-target')?.value==='圈内测试标题');
    await page.keyboard.press('Escape'); await pickImage(); await page.waitForFunction(()=>records.recognitionRequests.length===3);
  });
  await check('local CSS imports, backgrounds and font URLs resolve from each stylesheet and are watched once', async () => {
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="19" height="11"><rect width="19" height="11" fill="blue"/></svg>';
    await fixture('html',true,'<!doctype html><html><head><link rel="stylesheet" href="styles/main.css"></head><body><div id="card">A</div><div id="inline" style="background-image:url(images/bg.svg)">B</div><img id="asset-image" src="images/bg.svg"></body></html>',{
      'styles/main.css':'@import "nested/base.css" screen; @font-face{font-family:PreviewFont;src:url("../fonts/test.woff2")} #card{width:100px;height:80px;background-image:url("../images/bg.svg")} /* url(missing.png) */',
      'styles/nested/base.css':'@import "../main.css"; #card{border:3px solid rgb(10,20,30)}',
      'images/bg.svg':svg,'fonts/test.woff2':[0,1,2,3]
    });
    const frame=page.frameLocator('[data-region-frame]'); await frame.locator('#card').waitFor();
    const result=await frame.locator('#card').evaluate(async el=>{
      const background=getComputedStyle(el).backgroundImage; const url=background.slice(5,-2); const image=new Image();image.src=url;await image.decode();
      return {background,width:image.naturalWidth,height:image.naturalHeight,border:getComputedStyle(el).borderTopWidth,styles:document.querySelector('style').textContent,inline:document.querySelector('#inline').style.backgroundImage};
    });
    assert.match(result.background,/data:image\/svg\+xml;base64/);assert.equal(result.width,19);assert.equal(result.height,11);assert.equal(result.border,'3px');
    assert.match(result.styles,/data:font\/woff2;base64,AAECAw==/);assert.match(result.inline,/data:image\/svg\+xml;base64/);
    assert.deepEqual((await page.evaluate(()=>records.assetReads)).sort(),['fonts/test.woff2','images/bg.svg','styles/main.css','styles/nested/base.css']);
    assert.equal(await page.evaluate(()=>records.watchedResources.length),4);
  });
  await check('CSS asset expansion keeps the existing local-resource count limit', async () => {
    const assets={};for(let i=0;i<33;i++)assets['img'+i+'.svg']='<svg xmlns="http://www.w3.org/2000/svg"/>';
    await fixture('html',true,'<!doctype html><style>'+Object.keys(assets).map((name,i)=>'.i'+i+'{background:url('+name+')}').join('')+'</style><p>content</p>',assets);
    await page.getByRole('alert').filter({hasText:'关联文件超过 32 个'}).waitFor();assert.equal(await page.evaluate(()=>records.assetReads.length),32);
  });
  await check('crossed freehand outlines explain the problem and allow a clean redraw', async () => {
    await fixture();const b=await page.locator('[data-textpreview-body]').boundingBox();await page.locator('[data-region-edit]').click();await page.locator('.re-layer').waitFor();
    await trace([{x:30,y:100},{x:230,y:300},{x:30,y:300},{x:230,y:100}].map(p=>({x:b.x+p.x,y:b.y+p.y})));
    await page.getByText('圈选轮廓发生交叉，请沿目标外围重新画一圈。',{exact:false}).waitFor();assert.equal(await page.locator('.re-panel').count(),0);
    await pick(); await page.locator('textarea').fill('重新画圈后修改');await page.getByRole('button',{name:'发送修改',exact:true}).click();await page.waitForFunction(()=>records.sent.length===1);
  });
  await check('point selection maps a nested repeated-label button to its original tag and CSS context', async () => {
    await fixture('html', true, pointSource, pointAssets);
    await page.frameLocator('[data-region-frame]').locator('.primary').evaluate(node => node.addEventListener('click', () => node.dataset.clicked = 'yes'));
    await point('.primary span');
    assert.equal(await page.frameLocator('[data-region-frame]').locator('.primary').getAttribute('data-clicked'), null);
    await page.getByText('定位信息 · 第 8 行', { exact: true }).waitFor();
    await page.locator('textarea').fill('放大一点，沿用主色');
    await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.waitForFunction(() => records.sent.length === 1);
    const e = await sentEvidence(), target = e.selection.elements[0];
    assert.equal(target.tag, 'button'); assert.equal(target.source.line, 8);
    assert.equal(target.source.snippet, '<button class="primary">');
    assert.equal(target.context.classes, 'primary'); assert.equal(target.context.variables['--brand'], '#315edd');
    assert.equal(target.context.styles['background-color'], 'rgb(49, 94, 221)');
    assert.equal(target.context.parent.styles.display, 'flex'); assert.equal(target.context.parent.styles.gap, '16px');
    assert.ok(target.context.rules.some(r => r.file === 'styles/main.css' && r.selector === '.primary'));
    assert.ok(!target.context.rules.some(r => r.declarations.includes('color: red')));
    assert.equal(await page.evaluate(() => records.recognitionRequests.length), 0);
    assert.equal(await page.evaluate(() => records.imageParts.length), 0);
  });
  await check('parent and child selection preserve the request and update the actual target', async () => {
    await fixture('html', true, pointSource, pointAssets); await point('.primary');
    await page.locator('textarea').fill('调整两颗按钮之间的间距');
    await page.getByRole('button', { name: '选择外层', exact: true }).click();
    await page.getByText('定位信息 · 第 6 行', { exact: true }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), '调整两颗按钮之间的间距');
    await page.getByRole('button', { name: '返回内层', exact: true }).click();
    await page.getByText('定位信息 · 第 8 行', { exact: true }).waitFor();
    await page.getByRole('button', { name: '放入输入框', exact: true }).click();
    await page.waitForFunction(() => records.draft.text.includes('调整两颗按钮'));
    assert.match(await page.evaluate(() => records.draft.text), /"classes": "primary"/);
  });
  await check('replacing a selected DOM node cannot redirect a request to an identical clone', async () => {
    await fixture('html', true, pointSource, pointAssets); await point('.primary');
    await page.locator('textarea').fill('修改这个按钮');
    await page.frameLocator('[data-region-frame]').locator('.primary').evaluate(node => node.replaceWith(node.cloneNode(true)));
    await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '目标元素已被替换' }).waitFor();
    assert.equal(await page.evaluate(() => records.sent.length), 0);
    assert.equal(await page.locator('textarea').inputValue(), '修改这个按钮');
  });
  await check('a CSS change after point selection requires a refreshed selection', async () => {
    await fixture('html', true, pointSource, pointAssets); await point('.primary'); await page.locator('textarea').fill('修改');
    await page.frameLocator('[data-region-frame]').locator('.primary').evaluate(node => node.style.backgroundColor = 'purple');
    await page.getByRole('button', { name: '发送修改', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '选区内容已变化' }).waitFor();
    assert.equal(await page.evaluate(() => records.sent.length), 0);
  });
  await check('dynamic nodes do not inherit precise locations from a cloned static element', async () => {
    await fixture('html', true, pointSource, pointAssets);
    await page.frameLocator('[data-region-frame]').locator('.primary').evaluate(node => { const clone = node.cloneNode(true); clone.id = 'generated'; node.replaceWith(clone); });
    await point('#generated'); await page.locator('textarea').fill('修改动态按钮');
    await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.waitForFunction(() => records.sent.length === 1);
    assert.equal((await sentEvidence()).selection.elements[0].source, undefined);
  });
  await check('source and preview version mismatch is rejected before exposing a stale line number', async () => {
    await fixture('html', true, pointSource, pointAssets); await page.locator('[data-region-connected]').waitFor();
    await page.evaluate(() => { records.version++; records.sourceText = '\n' + records.sourceText; });
    await page.locator('[data-region-edit]').click();
    await page.getByRole('alert').filter({ hasText: '文件与页面预览版本不一致' }).waitFor();
    assert.equal(await page.locator('.re-layer').count(), 0);
  });
  await check('interactive page scripts keep picking but disable claims of exact static source positions', async () => {
    await fixture('html'); await page.frameLocator('[data-region-frame]').locator('#start').waitFor();
    await page.evaluate(() => { records.interactive = true; rerender(); });
    await page.waitForFunction(() => document.querySelector('[data-region-frame]')?.getAttribute('srcdoc')?.includes('exampleRan=true'));
    await point('#start'); await page.locator('textarea').fill('修改');
    await page.getByRole('button', { name: '发送修改', exact: true }).click(); await page.waitForFunction(() => records.sent.length === 1);
    assert.equal((await sentEvidence()).selection.elements[0].source, undefined);
  });
  await check('expanded point-selection details keep actions reachable in a small window', async () => {
    await page.setViewportSize({ width: 720, height: 540 });
    try {
      await fixture('html', true, pointSource, pointAssets);
      await page.locator('.chat').evaluate(node => node.remove());
      await point('.primary'); await page.locator('textarea').fill('小窗口也能修改');
      await page.locator('.re-location summary').click();
      await page.locator('.re-panel').evaluate(node => node.scrollTop = node.scrollHeight);
      const panel = await page.locator('.re-panel').boundingBox(), button = await page.getByRole('button', { name: '发送修改', exact: true }).boundingBox();
      assert.ok(panel.y >= 0 && panel.y + panel.height <= 540);
      assert.ok(button.y >= 0 && button.y + button.height <= 540);
      await page.getByRole('button', { name: '发送修改', exact: true }).click();
      await page.waitForFunction(() => records.sent.length === 1);
    } finally { await page.setViewportSize({ width: 1200, height: 850 }); }
  });
  await check('HTML requests save a session record before staging and can remove an unsent record', async () => {
    await fixture('html',true,pointSource,pointAssets);await point('.primary');await page.locator('textarea').fill('增大按钮');
    await page.getByRole('button',{name:'放入输入框',exact:true}).click();
    await page.waitForFunction(()=>records.draft.text.includes('[dsh-region-edit:'));
    assert.match(await page.evaluate(()=>records.draft.text),/\[dsh-region-edit:change-1\]/);
    await page.getByRole('button',{name:/^修改记录/}).click();await page.getByRole('dialog').waitFor();
    await page.getByText('等待开始',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/^回滚本次/}).isDisabled(),true);
    await page.getByRole('button',{name:'移除记录',exact:true}).click();
    await page.getByRole('button',{name:'确认移除记录（不改文件）',exact:true}).click();
    await page.getByText(/还没有修改记录/).waitFor();assert.equal(await page.evaluate(()=>records.sent.length),0);
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  });
  await check('failed baseline capture prevents delivery and keeps the user instruction', async () => {
    await fixture('html',true,pointSource,pointAssets);await point('.primary');await page.locator('textarea').fill('保留我的要求');
    await page.evaluate(()=>records.historyFail=true);await page.getByRole('button',{name:'发送修改',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'无法保存修改前的文件'}).waitFor();
    assert.equal(await page.evaluate(()=>records.sent.length),0);assert.equal(await page.locator('textarea').inputValue(),'保留我的要求');
  });
  await check('failed delivery removes its unused baseline so retry can create a fresh record', async () => {
    await fixture('html',true,pointSource,pointAssets);await point('.primary');await page.locator('textarea').fill('重试修改');
    await page.evaluate(()=>records.fail=true);await page.getByRole('button',{name:'发送修改',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'发送失败'}).waitFor();assert.equal(await page.evaluate(()=>records.changes.length),0);
    await page.evaluate(()=>records.fail=false);await page.getByRole('button',{name:'发送修改',exact:true}).click();await page.waitForFunction(()=>records.sent.length===1);
    assert.equal(await page.evaluate(()=>records.changes.length),1);
  });
  async function comparisonFixture(){
    await fixture('html',true,pointSource,pointAssets);await point('.primary');await page.locator('textarea').fill('增大主按钮，并把标题改成“开始你的计划”');
    await page.getByRole('button',{name:'发送修改',exact:true}).click();await page.waitForFunction(()=>records.sent.length===1);
    await page.evaluate(()=>{
      const r=records.changes[0];r.state='ready';r.after=structuredClone(r.before);r.after.source=r.before.source.replace('选择适合你的计划','开始你的计划');
      const css=new TextDecoder().decode(r.after.assets[0].data);r.after.assets[0].data=new TextEncoder().encode(css+' .primary{padding:20px 32px;font-size:20px}');
      r.files=[{path:r.path,restored:false},{path:'C:/测试/styles/main.css',restored:false}];
      r.texts=[{path:r.path,before:r.before.source,after:r.after.source},{path:'C:/测试/styles/main.css',before:css,after:new TextDecoder().decode(r.after.assets[0].data)}];
    });
    await page.getByRole('button',{name:/^修改记录/}).click();await page.frameLocator('iframe[title="修改后"]').locator('h1').waitFor();
  }
  await check('comparison freezes both styles, shows changed files and uses opaque scriptless previews', async()=>{
    await comparisonFixture();
    assert.equal(await page.frameLocator('iframe[title="修改前"]').locator('.primary').evaluate(n=>getComputedStyle(n).padding),'12px 20px');
    assert.equal(await page.frameLocator('iframe[title="修改后"]').locator('.primary').evaluate(n=>getComputedStyle(n).padding),'20px 32px');
    assert.equal(await page.locator('iframe[title="修改前"]').getAttribute('sandbox'),'');
    await page.locator('.re-history-files summary').click();await page.getByText('C:/测试/styles/main.css · 可恢复',{exact:true}).waitFor();
    await page.screenshot({path:'artifacts/comparison-v0.5.0.png'});
    await page.getByRole('button',{name:'文件内容',exact:true}).click();await page.getByLabel('对比文件').selectOption('1');
    assert.match(await page.locator('.re-compare-side').nth(1).textContent(),/padding:20px 32px/);
    await page.getByRole('button',{name:/^回滚本次修改/}).click();await page.getByRole('button',{name:'已回滚',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>records.changes[0].files.every(f=>f.restored)),true);
  });
  await check('a rollback conflict keeps the comparison and exposes the server refusal',async()=>{
    await comparisonFixture();await page.evaluate(()=>records.restoreConflict=true);await page.getByRole('button',{name:/^回滚本次修改/}).click();
    await page.getByRole('alert').filter({hasText:'文件后来又被修改'}).waitFor();
    assert.equal(await page.evaluate(()=>records.changes[0].state),'ready');
    assert.equal(await page.frameLocator('iframe[title="修改前"]').locator('h1').textContent(),'选择适合你的计划');
  });
  await check('comparison dialog fits a small window and keeps rollback reachable',async()=>{
    await comparisonFixture();await page.setViewportSize({width:640,height:540});
    try {
      const dialog=await page.getByRole('dialog').boundingBox();assert.ok(dialog.y>=0&&dialog.y+dialog.height<=540);
      await page.getByRole('button',{name:/^回滚本次修改/}).scrollIntoViewIfNeeded();
      const button=await page.getByRole('button',{name:/^回滚本次修改/}).boundingBox();assert.ok(button.y>=0&&button.y+button.height<=540);
      await page.screenshot({path:'artifacts/comparison-small-v0.5.0.png'});
    }finally{await page.setViewportSize({width:1200,height:850});}
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ passed: passed.length, failed: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;

// Run in the installed Electron runtime to read its bundled host modules.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
async function main() {
  const hostRequire = createRequire(process.env.DSH_HOST_PACKAGE || 'D:/deepseek harness/resources/app.asar/dsh/package.json');
  const manifest = require('../package.json');
  assert.equal(hostRequire('./package.json').version, manifest.peerDependencies['@deepseek-ai/dsh'], 'Installed host must match the declared compatibility version');
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    assert.equal(hostRequire(name + '/package.json').version, version, `Installed ${name} must match the declared version`);
  }
  const { evaluatePluginCompatibility } = hostRequire('@deepseek-ai/dsh-app-boot');
  assert.equal(evaluatePluginCompatibility(manifest), undefined, 'Host compatibility gate must accept the plugin without exemptions');
  for (const name of manifest.dsh.client.inject) {
    const dependency = hostRequire(name + '/package.json');
    assert.equal(dependency.version, manifest.peerDependencies['@deepseek-ai/dsh'], `Client dependency ${name} must match the installed host`);
  }
  console.log('PASS installed host compatibility gate, peer versions and client dependencies');
  const { Context } = hostRequire('@deepseek-ai/cordis');
  const { remoteMethods } = hostRequire('@deepseek-ai/dsh-typert-protocol');
  const { requireTool } = await import('../scripts/toolchain.mjs');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../dist/index.js'),'utf8');
  const built = await requireTool('esbuild').transform(source,{format:'cjs',target:'node22'});
  const mod={exports:{}};new Function('require','module','exports',built.code)(hostRequire,mod,mod.exports);
  // Persisted history goes to a temporary directory, never the user's real application data.
  require('node:fs').mkdirSync(require('node:path').join(process.cwd(),'.work'),{recursive:true});
  const historyDir=require('node:fs').mkdtempSync(require('node:path').join(process.cwd(),'.work','history-store-'));
  process.env.DSH_REGION_EDIT_HISTORY_DIR=historyDir;
  const plugin=mod.exports, root=new Context();let ctx;
  const owner=root.plugin(owned=>{ctx=owned;});await owner.await();
  const path='C:/poster.png', file={version:1,bytes:9,absolutePath:path,data:new Uint8Array([137,80,78,71,13,10,26,10,42])};
  const calls=[], stored=[], agent={session:{id:'qa',header:{cwd:'C:/'},requestHeader:()=>({config:{provider:'old',model:'old-model'}})}};
  let modalities=['text','image'], changeDuringStream=false;
  const expected={label:'海报标题',kind:'文字',text:'测试标题',confidence:.9,ambiguous:false};
  const image={width:800,height:600,pixels:{x:100,y:100,width:200,height:100},normalized:{x:.125,y:1/6,width:.25,height:1/6},
    polygon:{pixels:[{x:100,y:100},{x:300,y:100},{x:200,y:200}],normalized:[{x:.125,y:1/6},{x:.375,y:1/6},{x:.25,y:1/3}]}};
  const request={path,version:'1',image};
  const services={
    workspaceFiles:{async stat(){return {...file};},async readBytes(){return {...file};}},
    attachments:{imageLimits:{maxImageBytes:1000},async saveImage(input){stored.push(input);return{attachmentId:'sha256:'+'0'.repeat(64),mediaType:'image/png',bytes:9,width:800,height:600};}},
    sessionProjections:{stateOf:(_session,key)=>key==='turnBoundary'?{lastTurn:1,openTurnStartSeq:null}:{pending:{provider:'deepseek-current',model:'current-vision'}}},
    sandboxPolicy:{defaultMode:'workspace-write',resolve:({session}={})=>({mode:'workspace-write',workspaceRoot:session?.header.cwd??process.cwd()})},
    workspaceChanges:{summary:()=>undefined},
    agentDefaultModel:{currentSelection:()=>({provider:'default',model:'default-model'})},
    llm:{async prepareCall(config){return{config,inputModalities:modalities,async *stream(options){calls.push(options);
      yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:JSON.stringify(expected)};
      yield{type:'block-end',index:0,block:{type:'text',text:JSON.stringify(expected)}};
      if(changeDuringStream)file.version++;yield{type:'finish',reason:{kind:'stop'}};}};}}
  };
  try {
    for(const [key,value]of Object.entries(services))ctx.provide(key,value);
    const {default: NativeFs}=hostRequire('@deepseek-ai/dsh-fs-sandbox');
    const fsFiber=ctx.plugin(NativeFs,{cwd:process.cwd(),diffBasisMaxBytes:1024*1024});await fsFiber.await();const nativeFs=ctx.get('fs');
    let fiber=ctx.plugin(plugin);await fiber.await();const service=ctx.get('regionEdit');assert.ok(service);
    assert.deepEqual(remoteMethods(service).map(m=>m.method).sort(),['recognize','prepareChange','listChanges','changeDetail','changeContent','removeChange','restoreChange'].sort());
    assert.ok(/recognize\(agent,\s*request,\s*signal\)/.test(plugin.RegionVision.prototype.recognize.toString()));
    const result=await service.recognize(agent,request,new AbortController().signal);
    assert.deepEqual(result,{...expected,source:'vision'});
    assert.equal(calls[0].provider,'deepseek-current');assert.equal(calls[0].model,'current-vision');
    assert.deepEqual([...stored[0].data],[137,80,78,71,13,10,26,10,42]);
    assert.equal(calls[0].messages[0].content[0].type,'image');assert.match(calls[0].messages[0].content[1].text,/polygon/);
    assert.equal(calls[0].tools,undefined);
    modalities=['text'];await assert.rejects(()=>service.recognize(agent,request,new AbortController().signal),/未开放图片输入/);assert.equal(calls.length,1);
    modalities=['text','image'];changeDuringStream=true;await assert.rejects(()=>service.recognize(agent,request,new AbortController().signal),/原图已更新/);
    const controller=new AbortController();controller.abort();await assert.rejects(()=>service.recognize(agent,request,controller.signal));
    const io=require('node:fs/promises'), paths=require('node:path');
    const scratch=await io.mkdtemp(paths.join(process.cwd(),'.work','history-host-'));
    try {
      const main=paths.join(scratch,'index.html'),css=paths.join(scratch,'main.css');
      const original='\ufeff<!doctype html>\r\n<link rel="stylesheet" href="main.css"><button>原按钮</button>\r\n';
      await io.writeFile(main,original);await io.writeFile(css,'button{padding:12px}');
      const editing={session:{id:'history-qa',header:{cwd:scratch},requestHeader:agent.session.requestHeader}},signal=new AbortController().signal;
      const target=await nativeFs.resolve(main,{cwd:scratch,signal}), stat=await nativeFs.stat(target,signal);
      const record=await service.prepareChange(editing,{path:main,version:JSON.stringify(stat.version),instruction:'增大按钮'},signal);
      assert.equal((await service.listChanges(editing,signal)).length,1);
      await ctx.parallel('session/event',editing.session,{type:'turn/start',seq:1,data:{turn:1}});
      await ctx.parallel('session/event',editing.session,{type:'user/message',seq:2,data:{source:{kind:'user'},content:[{type:'text',text:`[dsh-region-edit:${record.id}]`}]}});
      await ctx.serial('tools/pre-execute',{agent:editing,signal},()=>Promise.resolve());
      await io.writeFile(main,original.replace('原按钮','新按钮'));await io.writeFile(css,'button{padding:24px}');
      await ctx.parallel('session/event',editing.session,{type:'turn/end',seq:3,data:{turn:1}});
      for(let i=0;i<100;i++){if((await service.listChanges(editing,signal))[0].state==='ready')break;await new Promise(r=>setTimeout(r,10));}
      const detail=await service.changeDetail(editing,{id:record.id},signal);
      assert.equal(detail.state,'ready');assert.equal(detail.files.length,2);assert.deepEqual(detail.snapshots,{before:true,after:true});
      assert.equal((await service.changeContent(editing,{id:record.id,part:'before'},signal)).source,original);
      assert.match((await service.changeContent(editing,{id:record.id,part:'after'},signal)).source,/新按钮/);
      assert.equal((await service.restoreChange(editing,{id:record.id},signal)).state,'restored');
      assert.deepEqual(await io.readFile(main),Buffer.from(original));assert.equal(await io.readFile(css,'utf8'),'button{padding:12px}');
      // The real backend must refuse a stale version even when called through the plugin.
      const next=await service.prepareChange(editing,{path:main,version:JSON.stringify((await nativeFs.stat(target,signal)).version),instruction:'再修改'},signal);
      await ctx.parallel('session/event',editing.session,{type:'turn/start',seq:4,data:{turn:2}});
      await ctx.parallel('session/event',editing.session,{type:'user/message',seq:5,data:{content:[{type:'text',text:`[dsh-region-edit:${next.id}]`}]}});
      await ctx.serial('tools/pre-execute',{agent:editing,signal},()=>Promise.resolve());
      await io.writeFile(css,'button{padding:30px}');
      await ctx.parallel('session/event',editing.session,{type:'turn/end',seq:6,data:{turn:2}});
      for(let i=0;i<100;i++){if((await service.changeDetail(editing,{id:next.id},signal)).state==='ready')break;await new Promise(r=>setTimeout(r,10));}
      await io.writeFile(css,'human edit');
      assert.match((await service.restoreChange(editing,{id:next.id},signal)).error,/后来又被修改/);
      assert.equal(await io.readFile(css,'utf8'),'human edit');
      // Finished records are stored and come back after the plugin restarts.
      const recordsDir=paths.join(historyDir,'records'),saved=async()=>{try{const names=await io.readdir(recordsDir);
        const texts=await Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>io.readFile(paths.join(recordsDir,n),'utf8')));
        return texts.length===2&&texts.some(t=>t.includes('"state":"restored"'))&&texts.some(t=>t.includes('后来又被修改'));}catch{return false;}};
      for(let i=0;i<200&&!await saved();i++)await new Promise(r=>setTimeout(r,10));assert.ok(await saved(),'finished records must be written to the history directory');
      await fiber.dispose();fiber=ctx.plugin(plugin);await fiber.await();const again=ctx.get('regionEdit');
      assert.deepEqual((await again.listChanges(editing,signal)).map(r=>r.state).sort(),['ready','restored']);
      assert.equal((await again.changeContent(editing,{id:record.id,part:'before'},signal)).source,original);
      assert.match((await again.restoreChange(editing,{id:next.id},signal)).error,/后来又被修改/);assert.equal(await io.readFile(css,'utf8'),'human edit');
      console.log('PASS native sandbox filesystem: actual HTML/CSS restore, exact BOM/CRLF, session events, later-edit conflict refusal, persisted records after restart');
    } finally {
      assert.ok(paths.resolve(scratch).startsWith(paths.resolve(process.cwd(),'.work')+paths.sep));
      await io.rm(scratch,{recursive:true,force:true});
    }
    await fiber.dispose();assert.equal(ctx.get('regionEdit'),undefined);
    console.log('PASS real host Cordis/Remote/LLM assembly; original image, selected route, capability gate, stale-file refusal, cancellation, disposal');
  } finally {await owner.dispose();require('node:fs').rmSync(historyDir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

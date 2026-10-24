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
    sessionProjections:{stateOf:()=>({pending:{provider:'deepseek-current',model:'current-vision'}})},
    agentDefaultModel:{currentSelection:()=>({provider:'default',model:'default-model'})},
    llm:{async prepareCall(config){return{config,inputModalities:modalities,async *stream(options){calls.push(options);
      yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:JSON.stringify(expected)};
      yield{type:'block-end',index:0,block:{type:'text',text:JSON.stringify(expected)}};
      if(changeDuringStream)file.version++;yield{type:'finish',reason:{kind:'stop'}};}};}}
  };
  try {
    for(const [key,value]of Object.entries(services))ctx.provide(key,value);
    const fiber=ctx.plugin(plugin);await fiber.await();const service=ctx.get('regionEdit');assert.ok(service);
    assert.equal(remoteMethods(service)[0].method,'recognize');
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
    await fiber.dispose();assert.equal(ctx.get('regionEdit'),undefined);
    console.log('PASS real host Cordis/Remote/LLM assembly; original image, selected route, capability gate, stale-file refusal, cancellation, disposal');
  } finally {await owner.dispose();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

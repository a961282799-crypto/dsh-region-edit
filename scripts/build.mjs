import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { requireTool } from './toolchain.mjs';
const { build } = requireTool('esbuild');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const root = fileURLToPath(new URL('../', import.meta.url));
const common = { absWorkingDir: root, tsconfig: resolve(root, 'tsconfig.json') };
await mkdir('dist', { recursive: true });
const frame = await build({ ...common, entryPoints: [resolve(root, 'src/frame.ts')], bundle: true, format: 'iife',
  platform: 'browser', target: 'chrome120', minify: true, write: false });
const frameScript = frame.outputFiles[0].text;
await build({ ...common, entryPoints: [resolve(root, 'src/client.tsx')], outfile: resolve(root, 'dist/client.js'), bundle: true,
  format: 'cjs', platform: 'browser', target: 'chrome120', jsx: 'automatic', minify: true,
  external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'text' },
  plugins: [{ name: 'frame-source', setup(build) {
    build.onResolve({ filter: /^frame-source$/ }, () => ({ path: 'frame-source', namespace: 'inline' }));
    build.onLoad({ filter: /.*/, namespace: 'inline' }, () => ({ contents: `export default ${JSON.stringify(frameScript)}` }));
  } }],
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' }
});
await build({ ...common, entryPoints: [resolve(root, 'src/server.ts')], outfile: resolve(root, 'dist/index.js'), bundle: true,
  format: 'esm', platform: 'node', target: 'node22', minifySyntax: true, minifyWhitespace: true,
  external: ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-llm'] });
console.log(`Built ${pkg.name}@${pkg.version}; shared host React, no runtime dependencies.`);

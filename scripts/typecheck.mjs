import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireTool } from './toolchain.mjs';
const manifest = requireTool.resolve('typescript/package.json');
const pkg = JSON.parse(await readFile(manifest, 'utf8'));
let config = resolve('tsconfig.json');
if (process.env.DSH_DEV_DEPS) {
  const deps = resolve(process.env.DSH_DEV_DEPS);
  await mkdir('.work', { recursive: true });
  config = resolve('.work/tsconfig.check.json');
  await writeFile(config, JSON.stringify({ extends: '../tsconfig.json', compilerOptions: {
    typeRoots: [resolve(deps, '@types')], paths: {
      react: [resolve(deps, '@types/react/index.d.ts')],
      'react/jsx-runtime': [resolve(deps, '@types/react/jsx-runtime.d.ts')],
      'react-dom': [resolve(deps, '@types/react-dom/index.d.ts')]
    }
  } }));
}
const bin = resolve(dirname(manifest), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsc);
const result = spawnSync(process.execPath, [bin, '--project', config], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

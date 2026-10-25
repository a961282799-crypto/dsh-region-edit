import { mkdtemp, mkdir, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const workspace = resolve('.work'); await mkdir(workspace, { recursive: true });
const stage = await mkdtemp(resolve(workspace, 'pack-'));
if (!stage.startsWith(workspace + sep)) throw new Error('Invalid package staging directory.');
try {
  const root = resolve(stage, 'package'); await mkdir(root);
  for (const name of ['package.json', 'dist', 'cordis.patch.yml', 'README.md', 'VALIDATION.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(resolve(name), resolve(root, name), { recursive: true });
  await mkdir('artifacts', { recursive: true });
  const output = resolve('artifacts', `${pkg.name}-${pkg.version}.tgz`);
  const result = spawnSync('tar', ['-czf', output, '-C', stage, 'package'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Package archive failed.');
  const archive = await readFile(output), hash = createHash('sha256').update(archive).digest('hex');
  await writeFile('artifacts/SHA256SUMS', `${hash}  ${pkg.name}-${pkg.version}.tgz\n`);
  console.log(`${output}\n${archive.length} bytes\nSHA256 ${hash}`);
} finally { await rm(stage, { recursive: true, force: true }); }

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const executable = process.env.DSH_HOST_EXECUTABLE || 'D:/deepseek harness/DeepSeek Harness.exe';
if (!existsSync(executable)) throw new Error('找不到 Harness 桌面程序。请将 DSH_HOST_EXECUTABLE 设为已安装程序的完整路径，再运行宿主契约检查。');
const hostPackage = process.env.DSH_HOST_PACKAGE || resolve(dirname(executable), 'resources/app.asar/dsh/package.json');
const result = spawnSync(executable, [resolve('tests/host-contract.cjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOST_PACKAGE: hostPackage },
  stdio: 'inherit', windowsHide: true, timeout: 60000
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

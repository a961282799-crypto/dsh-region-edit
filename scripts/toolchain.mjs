import { createRequire } from 'node:module';
import { resolve } from 'node:path';
export const requireTool = createRequire(process.env.DSH_DEV_DEPS
  ? resolve(process.env.DSH_DEV_DEPS, '../package.json')
  : new URL('../package.json', import.meta.url));

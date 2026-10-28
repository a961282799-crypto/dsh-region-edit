/** The few Node built-ins the server-side history store uses; the host runtime is Node 22 (Electron). */
declare module 'node:fs/promises' {
  export function mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options: { force: true; recursive?: boolean }): Promise<void>;
  export function stat(path: string): Promise<unknown>;
  export function writeFile(path: string, data: string | Uint8Array, options: { flag: 'wx' }): Promise<void>;
}
declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): { update(data: Uint8Array): { digest(encoding: 'hex'): string } };
  export function randomUUID(): string;
}
declare module 'node:os' { export function homedir(): string; }
declare module 'node:path' { export function join(...parts: string[]): string; }
declare const process: { env: Record<string, string | undefined>; platform: string };

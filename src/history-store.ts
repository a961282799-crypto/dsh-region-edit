import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Durable storage for finished edit records. Values are JSON-like trees whose Uint8Array leaves are file contents. */
export interface HistoryStore {
  load(): Promise<{ id: string; value: unknown }[]>;
  save(id: string, value: unknown): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Per-user application data, outside every project: %APPDATA% on Windows. */
export function defaultHistoryDirectory(env: Record<string, string | undefined> = process.env): string {
  if (env.DSH_REGION_EDIT_HISTORY_DIR) return env.DSH_REGION_EDIT_HISTORY_DIR;
  const base = env.APPDATA || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  return join(base, 'dsh-region-edit', 'history');
}

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, BLOB = /^[0-9a-f]{64}$/;
type Tree = unknown;

/**
 * records/<id>.json holds the record; file contents live once in blobs/<sha256>, shared between the before and after
 * sides and across records. Every file is written to a temporary name first and then renamed into place.
 */
export class FileHistoryStore implements HistoryStore {
  private records: string; private blobs: string;
  private references = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.records = join(directory, 'records'); this.blobs = join(directory, 'blobs'); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work); this.queue = next.catch(() => undefined); return next; }
  private async atomic(path: string, data: string | Uint8Array) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { flag: 'wx' });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  load() {
    return this.serial(async () => {
      let names: string[];
      try { names = await readdir(this.records); } catch { return []; }
      const loaded: { id: string; value: unknown }[] = [];
      for (const name of names) {
        const id = name.replace(/\.json$/, '');
        if (!name.endsWith('.json') || !RECORD_ID.test(id)) continue;
        // A damaged record or a missing blob drops only that record.
        try {
          const hashes = new Set<string>();
          const encoded: Tree = JSON.parse(await readFile(join(this.records, name), 'utf8'));
          const contents = new Map<string, Uint8Array>();
          collect(encoded, hashes);
          for (const hash of hashes) {
            const data = new Uint8Array(await readFile(join(this.blobs, hash)));
            if (createHash('sha256').update(data).digest('hex') !== hash) throw new Error('blob mismatch');
            contents.set(hash, data);
          }
          loaded.push({ id, value: decode(encoded, contents) }); this.references.set(id, hashes);
        } catch { /* Skipped: it never reaches the panel and is never restored. */ }
      }
      return loaded;
    });
  }
  save(id: string, value: unknown) {
    if (!RECORD_ID.test(id)) return Promise.reject(new Error('invalid record id'));
    return this.serial(async () => {
      await mkdir(this.records, { recursive: true }); await mkdir(this.blobs, { recursive: true });
      const blobs = new Map<string, Uint8Array>(), encoded = encode(value, blobs);
      for (const [hash, data] of blobs) {
        const path = join(this.blobs, hash);
        if (!await stat(path).then(() => true, () => false)) await this.atomic(path, data);
      }
      await this.atomic(join(this.records, `${id}.json`), JSON.stringify(encoded));
      const previous = this.references.get(id); this.references.set(id, new Set(blobs.keys()));
      await this.collectGarbage(previous);
    });
  }
  remove(id: string) {
    if (!RECORD_ID.test(id)) return Promise.resolve();
    return this.serial(async () => {
      await rm(join(this.records, `${id}.json`), { force: true });
      const previous = this.references.get(id); this.references.delete(id);
      await this.collectGarbage(previous);
    });
  }
  /** Delete blobs that no remaining record references. */
  private async collectGarbage(candidates?: Set<string>) {
    if (!candidates) return;
    const live = new Set([...this.references.values()].flatMap(set => [...set]));
    for (const hash of candidates) if (!live.has(hash)) await rm(join(this.blobs, hash), { force: true });
  }
}

function encode(value: Tree, blobs: Map<string, Uint8Array>): Tree {
  if (value instanceof Uint8Array) { const hash = createHash('sha256').update(value).digest('hex'); blobs.set(hash, value); return { $blob: hash }; }
  if (Array.isArray(value)) return value.map(item => encode(item, blobs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, encode(item, blobs)]));
  return value;
}
function isBlob(value: Tree): value is { $blob: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { $blob?: unknown }).$blob === 'string';
}
function collect(value: Tree, hashes: Set<string>) {
  if (isBlob(value)) { if (!BLOB.test(value.$blob)) throw new Error('invalid blob'); hashes.add(value.$blob); }
  else if (Array.isArray(value)) value.forEach(item => collect(item, hashes));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => collect(item, hashes));
}
function decode(value: Tree, contents: Map<string, Uint8Array>): Tree {
  if (isBlob(value)) return contents.get(value.$blob)!;
  if (Array.isArray(value)) return value.map(item => decode(item, contents));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, contents)]));
  return value;
}

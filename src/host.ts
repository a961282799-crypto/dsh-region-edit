/** Narrow adapter for the public services verified in Harness Desktop 0.2.1-rc.5. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface FileStat { version: unknown; bytes?: number; absolutePath: string }
export interface PageTarget { sessionId: string; tabId?: string; occurrence?: { signal?: AbortSignal } }
export interface TabInfo { tab: { id: string; contentId: string; signal: AbortSignal; visible: boolean } }
export interface SlotOptions {
  name: string; id?: string; key?: string; order?: number;
  inject?: (sessionId: string) => Record<string, unknown>;
}
export interface Host {
  effect(effect: () => void | (() => void)): void;
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: SlotOptions, component: unknown): () => void;
  };
  sidebarRight: {
    focusedTarget(element: Element): PageTarget | undefined;
    isTargetCurrent(target: PageTarget): boolean;
  };
  sessions: {
    scope(id: string): { get(name: 'conversation'): Conversation | undefined } | undefined;
    binding(id: string): { session: unknown } | undefined;
  };
  connection: { rpc: { call<T>(channel: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<Result<T>> } };
  remote: { workspaceFiles: {
    stat(sessionId: string, path: string, signal?: AbortSignal): Promise<Result<FileStat>>;
    readBytes(sessionId: string, path: string, options: { baseFile?: string }, signal?: AbortSignal): Promise<Result<{ data: Uint8Array; version: unknown; absolutePath: string }>>;
  } };
  documentPreviews: { register(definition: {
    id: string; extensions: string[]; title(): string; loading: 'bytes-complete'; wrap: boolean;
  }): () => void };
  configForms: { developerTools: { enabled: Source<boolean> } };
}
export interface Conversation {
  send(text: string): Promise<void>;
  createDrafts(sessionId: string, files: File[]): { id: string }[];
  releaseDraftAttachment(id: string): void;
  sendSession(session: unknown, text: string, attachmentIds: string[], mode: 'queue', signal: AbortSignal): Promise<{ kind: string }>;
  input: { for(scope: unknown): {
    readonly draftSnapshot: { text: string; references: unknown[]; command?: { token: string } };
    setDraft(text: string | { text: string; references: unknown[]; command?: { token: string } }): void;
    addAttachments(ids: string[]): boolean;
    focus(): void;
    notify(level: 'info' | 'error', text: string): void;
  } };
}
export function fileAddress(sessionId: string, path: string): string {
  return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.replaceAll('\\', '/').split('/').map(p => encodeURIComponent(p).replace(/%3A/gi, ':')).join('/')}`;
}
export function fileFromAddress(address: string): { sessionId: string; path: string } {
  const match = /^dsh-resource:\/\/file\/session\/([^/]+)\/([^?#]+)(?:[?#].*)?$/.exec(address);
  if (!match) throw new Error('无法识别当前文件，请从侧边栏重新打开。');
  return { sessionId: decodeURIComponent(match[1]!), path: match[2]!.split('/').map(decodeURIComponent).join('/') };
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

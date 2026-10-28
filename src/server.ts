import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { imageMediaType, parseRecognition, recognitionPrompt, recognitionSystem } from './recognition.ts';
import { validPoints } from './lasso.ts';
import type { ImageSelection } from './image.ts';
import type { FileStat } from './host.ts';
import { EditHistory } from './history.ts';
import { FileHistoryStore, defaultHistoryDirectory } from './history-store.ts';
import type { HistoryHost, HistorySession, FsTarget } from './history.ts';
export interface Route { provider: string; model: string }
export interface Agent { session: { id: string; header: { cwd?: string }; requestHeader(): { config: Route } | undefined } }
export interface ServerHost extends HistoryHost {
  on(name: 'session/event', listener: (session: HistorySession, event: { type: string; seq: number; data: unknown }) => void): unknown;
  on(name: 'session/disposed', listener: (session: HistorySession) => void): unknown;
  on(name: 'tools/pre-execute', listener: (exec: { agent?: { session: HistorySession }; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>): unknown;
  on(name: 'fs/write-intent' | 'fs/edit-intent', listener: (target: FsTarget, exec: { agent?: { session: HistorySession }; signal: AbortSignal } | undefined, next: () => Promise<unknown>) => Promise<unknown>): unknown;
  effect(callback: () => (() => void)): void;
  workspaceFiles: {
    stat(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<FileStat>;
    readBytes(scope: { workspaceRoot: string }, path: string, options: object, signal: AbortSignal): Promise<FileStat & { data: Uint8Array }>;
  };
  attachments: { imageLimits: { maxImageBytes: number }; saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown> };
  sessionProjections: { stateOf(session: HistorySession, key: string): { pending?: Route | null; lastTurn?: number; openTurnStartSeq?: number | null } | undefined };
  agentDefaultModel: { currentSelection(): Route };
  llm: { prepareCall(route: Route & { maxTokens: number }, signal: AbortSignal): Promise<{
    config: Route; inputModalities?: readonly string[];
    stream(options: Route & { messages: unknown[]; system: string; sessionId: string; signal: AbortSignal }): AsyncIterable<unknown>;
  }> };
}
export interface RecognitionRequest { path: string; version: string; image: ImageSelection }
export const inject = ['workspaceFiles', 'llm', 'attachments', 'sessionProjections', 'agentDefaultModel', 'fs', 'sandboxPolicy', 'workspaceChanges'];
export class RegionVision extends TypertRemoteService {
  declare readonly ctx: ServerHost;
  private lifetime = new AbortController();
  private history: EditHistory;
  /** Attachments are content-addressed; reuse one per file version so re-recognition skips the read and normalization. */
  private images = new Map<string, Promise<unknown>>();
  constructor(ctx: ServerHost) {
    super(ctx, 'regionEdit'); this.history = new EditHistory(ctx, new FileHistoryStore(defaultHistoryDirectory()));
    ctx.effect(() => () => { this.lifetime.abort(); this.history.dispose(); this.images.clear(); });
    // Hooks run inside the host's session and tool pipeline: plugin failures are recorded, never rethrown.
    ctx.on('session/event', (session, event) => { try { this.history.event(session, event); } catch (error) { this.history.fault(session, error); } });
    ctx.on('session/disposed', session => this.history.forget(session));
    ctx.on('tools/pre-execute', async (exec, next) => {
      const session = exec.agent?.session;
      if (session) await this.history.beforeTool(session, exec.signal).catch(error => this.history.fault(session, error));
      return next();
    });
    for (const name of ['fs/write-intent', 'fs/edit-intent'] as const) ctx.on(name, async (target, exec, next) => {
      const intent = await next();
      const session = exec?.agent?.session;
      if (session) await this.history.beforeMutation(session, target, exec.signal).catch(error => this.history.fault(session, error));
      return intent;
    });
  }
  private image(scope: { workspaceRoot: string }, path: string, version: string, mediaType: string, signal: AbortSignal, check: (stat: FileStat) => void) {
    const key = JSON.stringify([scope.workspaceRoot, path, version, mediaType]);
    let entry = this.images.get(key);
    if (!entry) {
      // Shared by later callers, so the load follows the plugin lifetime rather than the first caller's cancel signal.
      const shared = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60000)]);
      entry = (async () => {
        const file = await this.ctx.workspaceFiles.readBytes(scope, path, {}, shared); check(file);
        return this.ctx.attachments.saveImage({ data: file.data, mediaType, name: path.split(/[\\/]/).pop()! });
      })();
      this.images.set(key, entry); entry.catch(() => { if (this.images.get(key) === entry) this.images.delete(key); });
      while (this.images.size > 4) this.images.delete(this.images.keys().next().value!);
    }
    signal.throwIfAborted();
    return Promise.race([entry, new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
  }
  @Remote
  async prepareChange(agent: Agent, request: { path: string; version: string; instruction: string }, signal: AbortSignal) {
    await this.history.loaded; return this.history.prepare(agent.session, request, signal);
  }
  @Remote
  async listChanges(agent: Agent, signal: AbortSignal) { await this.history.loaded; signal.throwIfAborted(); return this.history.list(agent.session); }
  @Remote
  async changeDetail(agent: Agent, request: { id: string }, signal: AbortSignal) { await this.history.loaded; signal.throwIfAborted(); return this.history.detail(agent.session, request?.id); }
  @Remote
  async changeContent(agent: Agent, request: { id: string; part: 'before' | 'after' | 'texts' }, signal: AbortSignal) {
    await this.history.loaded; signal.throwIfAborted(); return this.history.content(agent.session, request?.id, request?.part);
  }
  @Remote
  async removeChange(agent: Agent, request: { id: string }, signal: AbortSignal) { await this.history.loaded; signal.throwIfAborted(); this.history.remove(agent.session, request?.id); return true; }
  @Remote
  async restoreChange(agent: Agent, request: { id: string }, signal: AbortSignal) { await this.history.loaded; return this.history.restore(agent.session, request?.id, signal); }
  // Keep parameter names: the host's SRC Remote protocol reads agent/request/signal.
  @Remote
  async recognize(agent: Agent, request: RecognitionRequest, signal: AbortSignal) {
    if (!request || typeof request.path !== 'string' || request.path.length > 4096 || typeof request.version !== 'string'
      || !request.image || !validPoints(request.image.polygon?.normalized)
      || request.image.polygon.normalized.some(p => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)
      || ![request.image.width, request.image.height].every(n => Number.isFinite(n) && n > 0 && n < 100000)) throw new Error('自由选区数据无效，请重新圈选。');
    const mediaType = imageMediaType(request.path);
    if (!mediaType) throw new Error('当前视觉通道支持 PNG、JPEG、WebP 和 GIF，可以自行填写这个文件中的目标。');
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(60000)]);
    if (!agent.session.header.cwd) throw new Error('当前会话没有可用的文件工作区。');
    const scope = { workspaceRoot: agent.session.header.cwd };
    const check = (stat: FileStat) => { if (JSON.stringify(stat.version) !== request.version) throw new Error('原图已更新，请重新圈选。'); };
    const stat = await this.ctx.workspaceFiles.stat(scope, request.path, deadline); check(stat);
    if ((stat.bytes ?? Infinity) > this.ctx.attachments.imageLimits.maxImageBytes) throw new Error('原图超过当前视觉输入大小限制，可以自行填写圈中目标。');
    const pending = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending;
    const route = pending ?? agent.session.requestHeader()?.config ?? this.ctx.agentDefaultModel.currentSelection();
    const call = await this.ctx.llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 1600 }, deadline);
    if (call.inputModalities && !call.inputModalities.includes('image')) throw new Error('当前选择的模型未开放图片输入，请切换到视觉模型，或自行填写目标。');
    const attachment = await this.image(scope, request.path, request.version, mediaType, deadline, check);
    const messages = [createUserMessage({ source: { kind: 'dsh-region-edit' }, content: [
      { type: 'image', attachment }, { type: 'text', text: recognitionPrompt(request.image) }
    ] })];
    const assembler = new BlockAssembler();
    for await (const chunk of call.stream({ ...call.config, messages, system: recognitionSystem, sessionId: agent.session.id, signal: deadline })) { deadline.throwIfAborted(); assembler.push(chunk); }
    deadline.throwIfAborted();
    if (assembler.finish.kind !== 'stop') throw new Error(assembler.finish.failure?.message ?? '识别没有完整返回，可以重试或自行填写目标。');
    const result = parseRecognition(assembler.blocks().filter(b => b.type === 'text').map(b => b.text ?? '').join(''));
    check(await this.ctx.workspaceFiles.stat(scope, request.path, deadline));
    return result;
  }
}
export function apply(ctx: ServerHost): void { new RegionVision(ctx); }

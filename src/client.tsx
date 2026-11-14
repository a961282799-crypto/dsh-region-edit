import { useCallback, useEffect, useRef, useState } from 'react';
import { RegionPicker } from './overlay.tsx';
import { HtmlPreview } from './html.tsx';
import { buildPrompt } from './prompt.ts';
import { unwrap, fileFromAddress, fileAddress } from './host.ts';
import type { Host, PageTarget } from './host.ts';
import type { Region } from './selection.ts';
import type { Selection } from './bridge.ts';
import { imageMediaType, parseRecognition } from './recognition.ts';
import type { Recognition } from './recognition.ts';
import { checkPreviewSource, readRegion } from './bridge.ts';
import css from './style.css';
import historyCss from './history-style.css';
import { HistoryAction } from './history-ui.tsx';
import { changeMarker } from './changes.ts';
import { markerImage, markerSetting, saveMarkerSetting } from './marker.ts';
import { toBase64 } from './base64.ts';
import type { ImageSelection } from './image.ts';
import type { ChangeApi, ChangeSummary, ChangeDetail, ChangeText, PrepareResult, PreviewSnapshot } from './changes.ts';

const HTML_RENDERER = 'dsh-region-edit/html';
const TEXT_FILE = /\.(?:txt|md|markdown|rst|html?|css|[cm]?js|jsx|tsx?|json|ya?ml|csv|tsv|py|rs|go|java|c|h|cpp|vue|svelte|xml|svg)$/i;
interface Capture { root: HTMLElement; path: string; source: string; version: string; target: PageTarget }
interface ActionProps {
  absolutePath: string;
  history: ChangeApi;
  begin(element: HTMLElement, path: string, signal: AbortSignal): Promise<Capture>;
  recognize(capture: Capture, region: Region, signal: AbortSignal, marked: boolean): Promise<Recognition>;
  submit(capture: Capture, instruction: string, region: Region, selection: Selection, draft: boolean, signal: AbortSignal, target: Recognition | undefined, marked: boolean): Promise<void>;
}
function RegionAction({ absolutePath, history, begin, recognize, submit }: ActionProps) {
  const button = useRef<HTMLButtonElement>(null), abort = useRef<AbortController | undefined>(undefined);
  const [capture, setCapture] = useState<Capture>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [instruction, setInstruction] = useState(''), [hint, setHint] = useState('');
  const [manualTarget, setManualTarget] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [marked, setMarked] = useState(markerSetting);
  const html = /\.html?$/i.test(absolutePath);
  const close = useCallback(() => { abort.current?.abort(); setCapture(undefined); setLoading(false); setInstruction(''); setManualTarget(undefined); button.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { abort.current?.abort(); setCapture(undefined); setLoading(false); setError(''); setInstruction(''); setManualTarget(undefined); }, [absolutePath]);
  const refresh = useCallback(async (reason = '') => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setCapture(undefined); setGeneration(n => n + 1); setLoading(true); setError(''); setHint(reason);
    try {
      const selected = await begin(button.current!, absolutePath, controller.signal);
      if (!controller.signal.aborted) setCapture(selected);
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [absolutePath, begin]);
  return <>
    <button ref={button} className="re-tool" type="button" data-region-edit="" disabled={loading} aria-pressed={!!capture}
      title={error || (html ? '点选页面元素，写下修改要求。' : '圈选预览内容，写下修改要求，无需截图。')}
      onClick={() => { if (capture) close(); else void refresh(); }}>{loading ? '准备中…' : error ? '重新选择' : html ? '点选修改' : '圈选修改'}</button>
    {error && <span className="re-inline-error" role="alert">{error}</span>}
    {html && <HistoryAction api={history} revision={historyRevision} />}
    {capture && abort.current && <RegionPicker key={generation} root={capture.root} path={absolutePath} signal={abort.current.signal} onClose={close}
      instruction={instruction} onInstructionChange={setInstruction} hint={hint} onReselect={refresh}
      manualTarget={manualTarget} onManualTargetChange={setManualTarget}
      marked={marked} onMarkedChange={value => { setMarked(value); saveMarkerSetting(value); }}
      onRecognize={(region, signal) => recognize(capture, region, signal, marked)}
      onSubmit={async (instruction, region, draft, selection, target) => { try { await submit(capture, instruction, region, selection, draft, abort.current!.signal, target, marked); } finally { setHistoryRevision(n => n + 1); } }} />}
  </>;
}

/** The marker is an aid: when the image cannot be decoded or drawn, recognition and sending go on without it. */
async function drawMarker(data: Uint8Array, image: ImageSelection, mediaType: string): Promise<Uint8Array | undefined> {
  try { return await markerImage(data, mediaType, image.width, image.height, image.polygon.normalized); } catch { return undefined; }
}
export const inject = ['slots', 'sidebarRight', 'documentPreviews', 'sessions', 'conversation', 'remote', 'remote.workspaceFiles', 'configForms', 'connection'];
export function apply(ctx: Host): void {
  // Desktop uses the shared client loader (platform "web"); this plugin activates only in its desktop shell.
  if (!(globalThis as typeof globalThis & { dshDesktop?: { protocolVersion?: number } }).dshDesktop?.protocolVersion) return;
  /** One call to this plugin's host service, bound to a session: `{ args: { agentId, request } }` on the wire. */
  const remote = <T,>(sessionId: string, method: string, request: unknown, signal: AbortSignal): Promise<T> =>
    ctx.connection.rpc.call<T>('/api', `regionEdit/${method}`, { args: { agentId: sessionId, ...(request === undefined ? {} : { request }) } }, signal).then(unwrap);
  /** Every await can outlive the preview it started from; each step re-checks before acting on it. */
  const ensureCurrent = (target: PageTarget, message = '当前预览已切换，请重新圈选。') => { if (!ctx.sidebarRight.isTargetCurrent(target)) throw new Error(message); };
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.plugin = 'dsh-region-edit'; style.textContent = css + '\n' + historyCss; document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'dsh-region-edit', order: 20,
    inject: sessionId => ({
      history: {
        list: (signal: AbortSignal) => remote<ChangeSummary[]>(sessionId, 'listChanges', undefined, signal),
        detail: (id: string, signal: AbortSignal) => remote<ChangeDetail>(sessionId, 'changeDetail', { id }, signal),
        snapshot: (id: string, side: 'before' | 'after', signal: AbortSignal) => remote<PreviewSnapshot>(sessionId, 'changeContent', { id, part: side }, signal),
        texts: (id: string, signal: AbortSignal) => remote<ChangeText[]>(sessionId, 'changeContent', { id, part: 'texts' }, signal),
        remove: (id: string, signal: AbortSignal) => remote<unknown>(sessionId, 'removeChange', { id }, signal),
        restore: (id: string, signal: AbortSignal) => remote<ChangeSummary>(sessionId, 'restoreChange', { id }, signal)
      },
      async begin(element: HTMLElement, path: string, signal: AbortSignal): Promise<Capture> {
        const root = element.closest('[data-textpreview-url]')?.querySelector<HTMLElement>('[data-textpreview-body]');
        const target = ctx.sidebarRight.focusedTarget(element);
        if (!root || !target || target.sessionId !== sessionId) throw new Error('请先打开要修改的文件预览。');
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        const stat = unwrap(await ctx.remote.workspaceFiles.stat(sessionId, path, deadline));
        let source = '';
        if (TEXT_FILE.test(path) && (stat.bytes ?? Infinity) <= 1024 * 1024) {
          const file = unwrap(await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, deadline));
          if (JSON.stringify(file.version) !== JSON.stringify(stat.version)) throw new Error('文件已更新，请刷新预览后重新圈选。');
          try { source = new TextDecoder('utf-8', { fatal: true }).decode(file.data); } catch { /* Layout text is still usable. */ }
        }
        ensureCurrent(target);
        checkPreviewSource(root, source);
        return { root, path, source, target, version: JSON.stringify(stat.version) };
      },
      async recognize(capture: Capture, region: Region, signal: AbortSignal, marked: boolean): Promise<Recognition> {
        ensureCurrent(capture.target);
        const mediaType = imageMediaType(capture.path);
        if (!region.image || !mediaType) return { label: (region.text.split('\n')[0] || region.elements[0]?.text || 'SVG 图形选区').slice(0, 120),
          kind: region.elements[0]?.tag ?? '文字', text: region.text.slice(0, 1000), confidence: 1, ambiguous: false, source: 'document' };
        let marker: Uint8Array | undefined;
        if (marked) {
          // Drawn from the file's own bytes at the version the selection was made on.
          const file = unwrap(await ctx.remote.workspaceFiles.readBytes(sessionId, capture.path, {}, AbortSignal.any([signal, AbortSignal.timeout(8000)])));
          if (JSON.stringify(file.version) !== capture.version) throw new Error('原图已更新，请重新圈选。');
          marker = await drawMarker(file.data, region.image, mediaType);
        }
        const result = await remote<Recognition>(sessionId, 'recognize', { path: capture.path, version: capture.version, image: region.image, ...(marker ? { marker: toBase64(marker) } : {}) },
          AbortSignal.any([signal, AbortSignal.timeout(65000)]));
        signal.throwIfAborted();
        ensureCurrent(capture.target);
        return parseRecognition(JSON.stringify(result));
      },
      async submit(capture: Capture, instruction: string, region: Region, selection: Selection, draft: boolean, signal: AbortSignal, target: Recognition | undefined, marked: boolean) {
        ensureCurrent(capture.target); if (!capture.root.isConnected) throw new Error('当前预览已切换，请重新圈选。');
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        const stat = unwrap(await ctx.remote.workspaceFiles.stat(sessionId, capture.path, deadline));
        if (JSON.stringify(stat.version) !== capture.version) throw new Error('原文件已更新，请刷新预览后重新圈选。');
        checkPreviewSource(capture.root, capture.source);
        const current = await readRegion(capture.root, selection, deadline);
        if (current.text !== region.text || JSON.stringify(current.elements) !== JSON.stringify(region.elements)
          || JSON.stringify(current.image) !== JSON.stringify(region.image)) throw new Error('选区内容已变化，请重新圈选。');
        signal.throwIfAborted();
        ensureCurrent(capture.target);
        const scope = ctx.sessions.scope(sessionId), conversation = scope?.get('conversation');
        if (!scope || !conversation) throw new Error('当前会话不可用，请重新打开会话。');
        const mediaType = region.image && imageMediaType(capture.path);
        const attachments: string[] = [];
        let staged = false, change: ChangeSummary | undefined, delivered = false, skipped = '';
        // Everything created from here on is released or removed unless the request is delivered.
        try {
          // Images travel as attachments: the original file and, when enabled, the contour marker.
          let markerAttached = false;
          if (mediaType) {
            const file = unwrap(await ctx.remote.workspaceFiles.readBytes(sessionId, capture.path, {}, deadline));
            if (JSON.stringify(file.version) !== capture.version) throw new Error('原图已更新，请重新圈选。');
            const original = new File([new Uint8Array(file.data).buffer], capture.path.split(/[\\/]/).pop()!, { type: mediaType });
            const marker = marked ? await drawMarker(file.data, region.image!, mediaType) : undefined;
            signal.throwIfAborted();
            ensureCurrent(capture.target);
            const files = marker ? [original, new File([new Uint8Array(marker).buffer], '选区标记.jpg', { type: 'image/jpeg' })] : [original];
            attachments.push(...conversation.createDrafts(sessionId, files, false).map(a => a.id));
            markerAttached = !!marker;
          }
          let prompt = buildPrompt(capture.path, instruction, region, capture.source, target, markerAttached);
          // HTML requests open a change record for rollback, or learn why this one goes out without it.
          if (/\.html?$/i.test(capture.path)) {
            const prepared = await remote<PrepareResult>(sessionId, 'prepareChange', { path: capture.path, version: capture.version, instruction }, signal);
            if ('change' in prepared) { change = prepared.change; prompt = `${changeMarker(change.id)}\n\n${prompt}`; } else skipped = prepared.skipped;
            signal.throwIfAborted();
            ensureCurrent(capture.target, '当前预览已切换，请重新选择。');
          }
          const unrecorded = skipped ? `本次没有修改记录，不能一键回滚：${skipped}` : '';
          if (draft) {
            // Appended to whatever the user has drafted; their text, references and attachments stay.
            const input = conversation.input.for(scope);
            const previous = input.draftSnapshot;
            if (attachments.length && !input.addAttachments(attachments)) throw new Error('聊天输入框正在提交，请稍后重试。');
            input.setDraft({ ...previous, text: previous.text ? `${previous.text}\n\n${prompt}` : prompt });
            staged = delivered = true;
            if (unrecorded) input.notify('info', `已放入输入框。${unrecorded}`);
            requestAnimationFrame(() => input.focus());
          } else {
            if (attachments.length) {
              const session = ctx.sessions.binding(sessionId)?.session;
              if (!session) throw new Error('当前会话不可用，请重新打开会话。');
              if ((await conversation.sendSession(session, prompt, attachments, 'queue', signal)).kind !== 'success') throw new Error('图片修改请求没有发送成功，请重试。');
            } else await conversation.send(prompt);
            delivered = true;
            conversation.input.for(scope).notify('info', `圈选修改要求已发送。${unrecorded}`);
          }
        } finally {
          if (!staged) for (const id of attachments) conversation.releaseDraftAttachment(id);
          if (change && !delivered) await remote(sessionId, 'removeChange', { id: change.id }, AbortSignal.timeout(8000)).catch(() => undefined);
        }
      }
    })
  }, RegionAction));
  ctx.effect(() => ctx.documentPreviews.register({ id: HTML_RENDERER, extensions: ['html', 'htm'], title: () => '圈选预览', loading: 'bytes-complete', wrap: false }));
  ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: HTML_RENDERER,
    inject: sessionId => ({
      hooks: { interactivePreview: ctx.configForms.developerTools.enabled },
      async readAsset(address: string, reference: string, signal: AbortSignal) {
        const file = fileFromAddress(address);
        if (file.sessionId !== sessionId) throw new Error('文件不属于当前会话。');
        let path = reference.split(/[?#]/)[0]!;
        try { path = decodeURIComponent(path); } catch { /* A literal percent sign is also a valid local filename. */ }
        const result = unwrap(await ctx.remote.workspaceFiles.readBytes(sessionId, path, { baseFile: file.path }, signal));
        return { ...result, resourceAddress: fileAddress(sessionId, result.absolutePath) };
      }
    })
  }, HtmlPreview));
}

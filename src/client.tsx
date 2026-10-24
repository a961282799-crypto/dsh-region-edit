import { useCallback, useEffect, useRef, useState } from 'react';
import { RegionPicker } from './overlay.tsx';
import { HtmlPreview } from './html.tsx';
import { buildPrompt } from './prompt.ts';
import { unwrap, fileFromAddress, fileAddress } from './host.ts';
import type { Host, PageTarget } from './host.ts';
import type { Region } from './selection.ts';
import type { Lasso } from './lasso.ts';
import { imageMediaType, parseRecognition } from './recognition.ts';
import type { Recognition } from './recognition.ts';
import { readRegion } from './bridge.ts';
import css from './style.css';

const HTML_RENDERER = 'dsh-region-edit/html';
const TEXT_FILE = /\.(?:txt|md|markdown|rst|html?|css|[cm]?js|jsx|tsx?|json|ya?ml|csv|tsv|py|rs|go|java|c|h|cpp|vue|svelte|xml|svg)$/i;
interface Capture { root: HTMLElement; path: string; source: string; version: string; target: PageTarget }
interface ActionProps {
  absolutePath: string;
  begin(element: HTMLElement, path: string, signal: AbortSignal): Promise<Capture>;
  recognize(capture: Capture, region: Region, signal: AbortSignal): Promise<Recognition>;
  submit(capture: Capture, instruction: string, region: Region, selection: Lasso, draft: boolean, signal: AbortSignal, target?: Recognition): Promise<void>;
}
function RegionAction({ absolutePath, begin, recognize, submit }: ActionProps) {
  const button = useRef<HTMLButtonElement>(null), abort = useRef<AbortController | undefined>(undefined);
  const [capture, setCapture] = useState<Capture>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [instruction, setInstruction] = useState(''), [hint, setHint] = useState('');
  const [manualTarget, setManualTarget] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);
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
      title={error || '圈选预览内容，写下修改要求，无需截图。'}
      onClick={() => { if (capture) close(); else void refresh(); }}>{loading ? '准备中…' : error ? '重试圈选' : '圈选修改'}</button>
    {error && <span className="re-inline-error" role="alert">{error}</span>}
    {capture && abort.current && <RegionPicker key={generation} root={capture.root} path={absolutePath} signal={abort.current.signal} onClose={close}
      instruction={instruction} onInstructionChange={setInstruction} hint={hint} onReselect={refresh}
      manualTarget={manualTarget} onManualTargetChange={setManualTarget}
      onRecognize={(region, signal) => recognize(capture, region, signal)}
      onSubmit={(instruction, region, draft, selection, target) => submit(capture, instruction, region, selection, draft, abort.current!.signal, target)} />}
  </>;
}

export const inject = ['slots', 'sidebarRight', 'documentPreviews', 'sessions', 'conversation', 'remote', 'remote.workspaceFiles', 'configForms', 'connection'];
export function apply(ctx: Host): void {
  // Desktop uses the shared client loader (platform "web"); this plugin activates only in its desktop shell.
  if (!(globalThis as typeof globalThis & { dshDesktop?: { protocolVersion?: number } }).dshDesktop?.protocolVersion) return;
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.plugin = 'dsh-region-edit'; style.textContent = css; document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'dsh-region-edit', order: 20,
    inject: sessionId => ({
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
        if (!ctx.sidebarRight.isTargetCurrent(target)) throw new Error('当前预览已切换，请重新圈选。');
        return { root, path, source, target, version: JSON.stringify(stat.version) };
      },
      async recognize(capture: Capture, region: Region, signal: AbortSignal): Promise<Recognition> {
        if (!ctx.sidebarRight.isTargetCurrent(capture.target)) throw new Error('当前预览已切换，请重新圈选。');
        if (!region.image || !imageMediaType(capture.path)) return { label: (region.text.split('\n')[0] || region.elements[0]?.text || 'SVG 图形选区').slice(0, 120),
          kind: region.elements[0]?.tag ?? '文字', text: region.text.slice(0, 1000), confidence: 1, ambiguous: false, source: 'document' };
        const result = await ctx.connection.rpc.call<Recognition>('/api', 'regionEdit/recognize', {
          args: { agentId: sessionId, request: { path: capture.path, version: capture.version, image: region.image } }
        }, AbortSignal.any([signal, AbortSignal.timeout(65000)]));
        signal.throwIfAborted();
        if (!ctx.sidebarRight.isTargetCurrent(capture.target)) throw new Error('当前预览已切换，请重新圈选。');
        return parseRecognition(JSON.stringify(unwrap(result)));
      },
      async submit(capture: Capture, instruction: string, region: Region, selection: Lasso, draft: boolean, signal: AbortSignal, target?: Recognition) {
        if (!ctx.sidebarRight.isTargetCurrent(capture.target) || !capture.root.isConnected) throw new Error('当前预览已切换，请重新圈选。');
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        const stat = unwrap(await ctx.remote.workspaceFiles.stat(sessionId, capture.path, deadline));
        if (JSON.stringify(stat.version) !== capture.version) throw new Error('原文件已更新，请刷新预览后重新圈选。');
        const current = await readRegion(capture.root, selection, deadline);
        if (current.text !== region.text || JSON.stringify(current.elements) !== JSON.stringify(region.elements)
          || JSON.stringify(current.image) !== JSON.stringify(region.image)) throw new Error('选区内容已变化，请重新圈选。');
        signal.throwIfAborted();
        if (!ctx.sidebarRight.isTargetCurrent(capture.target)) throw new Error('当前预览已切换，请重新圈选。');
        const scope = ctx.sessions.scope(sessionId), conversation = scope?.get('conversation');
        if (!scope || !conversation) throw new Error('当前会话不可用，请重新打开会话。');
        const prompt = buildPrompt(capture.path, instruction, region, capture.source, target);
        const mediaType = region.image && imageMediaType(capture.path);
        const attachments: string[] = [];
        if (mediaType) {
          const file = unwrap(await ctx.remote.workspaceFiles.readBytes(sessionId, capture.path, {}, deadline));
          if (JSON.stringify(file.version) !== capture.version) throw new Error('原图已更新，请重新圈选。');
          const original = new File([new Uint8Array(file.data).buffer], capture.path.split(/[\\/]/).pop()!, { type: mediaType });
          signal.throwIfAborted();
          if (!ctx.sidebarRight.isTargetCurrent(capture.target)) throw new Error('当前预览已切换，请重新圈选。');
          attachments.push(...conversation.createDrafts(sessionId, [original]).map(a => a.id));
        }
        let staged = false;
        try {
        if (draft) {
          const input = conversation.input.for(scope);
          const previous = input.draftSnapshot;
          if (attachments.length && !input.addAttachments(attachments)) throw new Error('聊天输入框正在提交，请稍后重试。');
          input.setDraft({ ...previous, text: previous.text ? `${previous.text}\n\n${prompt}` : prompt });
          staged = true;
          requestAnimationFrame(() => input.focus());
        } else {
          if (attachments.length) {
            const session = ctx.sessions.binding(sessionId)?.session;
            if (!session) throw new Error('当前会话不可用，请重新打开会话。');
            if ((await conversation.sendSession(session, prompt, attachments, 'queue', signal)).kind !== 'success') throw new Error('图片修改请求没有发送成功，请重试。');
          } else await conversation.send(prompt);
          conversation.input.for(scope).notify('info', '圈选修改要求已发送。');
        }
        } finally { if (!staged) for (const id of attachments) conversation.releaseDraftAttachment(id); }
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

import { useEffect, useRef, useState } from 'react';
import { connectFrame } from './bridge.ts';
import { htmlDocument } from './html-document.ts';
import type { AssetReader } from './html-document.ts';
import type { TabInfo } from './host.ts';
import picker from 'frame-source';
export interface HtmlProps {
  content: { kind: string; data?: Uint8Array };
  resourceAddress: string;
  useTabInfo(): TabInfo;
  useInteractivePreview<T>(selector: (value: boolean) => T): T;
  readAsset(address: string, reference: string, signal: AbortSignal): ReturnType<AssetReader>;
  addResource(address: string): void;
  setResources(addresses: string[]): void;
}
export function HtmlPreview({ content, resourceAddress, useTabInfo, useInteractivePreview, readAsset, addResource, setResources }: HtmlProps) {
  const interactive = useInteractivePreview(value => value);
  const { tab } = useTabInfo();
  const [state, setState] = useState<{ html?: string; error?: string }>({});
  const disconnect = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    const cancel = () => abort.abort(); tab.signal.addEventListener('abort', cancel, { once: true });
    const dispose = () => { abort.abort(); tab.signal.removeEventListener('abort', cancel); disconnect.current?.(); };
    setState({});
    setResources([]);
    if (content.kind === 'bytes' && content.data) {
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(content.data); }
      catch { setState({ error: '文件不是有效的 UTF-8 文本，请使用普通预览。' }); return dispose; }
      void htmlDocument(source, picker, interactive, async (ref, signal) => {
        const result = await readAsset(resourceAddress, ref, signal);
        if (!signal.aborted && result.resourceAddress) addResource(result.resourceAddress);
        return result;
      }, abort.signal)
        .then(html => { if (!abort.signal.aborted) setState({ html }); })
        .catch(error => { if (!abort.signal.aborted) setState({ error: String(error.message ?? error) }); });
    }
    return dispose;
  }, [content.data, content.kind, resourceAddress, interactive, readAsset, tab.signal, addResource, setResources]);
  if (state.error) return <p className="re-status" role="alert">{state.error}</p>;
  if (!state.html) return <p className="re-status" role="status">正在载入预览…</p>;
  return <iframe className="re-frame" name={`dsh-sidebar-html-${tab.id}`} title="圈选预览" sandbox="allow-scripts"
    srcDoc={state.html} data-region-frame="" onLoad={event => { disconnect.current?.(); disconnect.current = connectFrame(event.currentTarget); }} />;
}

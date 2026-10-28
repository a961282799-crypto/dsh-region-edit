/** Wire format for bounded, session-owned edit records. No caller supplies restore bytes. */
export interface ChangeFile { path: string; restored: boolean; problem?: string }
export interface ChangeSummary {
  id: string; path: string; instruction: string; created: number;
  state: 'prepared' | 'running' | 'finishing' | 'ready' | 'restored' | 'failed';
  files: ChangeFile[]; problems: string[]; error?: string;
}
export interface SnapshotAsset { reference: string; data: Uint8Array }
export interface PreviewSnapshot { source: string; assets: SnapshotAsset[]; error?: string }
export interface ChangeDetail extends ChangeSummary {
  before: PreviewSnapshot; after?: PreviewSnapshot;
  texts: { path: string; before?: string; after?: string }[];
}
export interface ChangeApi {
  list(signal: AbortSignal): Promise<ChangeSummary[]>;
  detail(id: string, signal: AbortSignal): Promise<ChangeDetail>;
  remove(id: string, signal: AbortSignal): Promise<unknown>;
  restore(id: string, signal: AbortSignal): Promise<ChangeSummary>;
}
export const changeMarker = (id: string) => `[dsh-region-edit:${id}]`;

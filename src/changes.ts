/** Wire format for bounded, session-owned edit records. No caller supplies restore bytes. */
export interface ChangeFile { path: string; restored: boolean; problem?: string }
export interface ChangeSummary {
  id: string; path: string; instruction: string; created: number;
  state: 'prepared' | 'running' | 'finishing' | 'ready' | 'restored' | 'failed';
  files: ChangeFile[]; problems: string[]; error?: string;
  /** When the turn was saved (ready or failed). */ finished?: number;
  /** Not an error: e.g. the record could not be stored and will not survive a restart. */ notice?: string;
}
export interface SnapshotAsset { reference: string; data: Uint8Array }
export interface PreviewSnapshot { source: string; assets: SnapshotAsset[]; error?: string }
export interface ChangeText { path: string; before?: string; after?: string }
/** Status plus which frozen sides exist. Contents are fetched separately and are immutable once present. */
export interface ChangeDetail extends ChangeSummary { snapshots: { before: boolean; after: boolean } }
export type ChangePart = 'before' | 'after' | 'texts';
export interface ChangeApi {
  list(signal: AbortSignal): Promise<ChangeSummary[]>;
  detail(id: string, signal: AbortSignal): Promise<ChangeDetail>;
  snapshot(id: string, side: 'before' | 'after', signal: AbortSignal): Promise<PreviewSnapshot>;
  texts(id: string, signal: AbortSignal): Promise<ChangeText[]>;
  remove(id: string, signal: AbortSignal): Promise<unknown>;
  restore(id: string, signal: AbortSignal): Promise<ChangeSummary>;
}
export const changeMarker = (id: string) => `[dsh-region-edit:${id}]`;

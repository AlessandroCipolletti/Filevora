/** One progress shape for upload, remote download, encoding, and transforms. */
export interface ProgressVersion {
  version: string;
  status: 'ready' | 'failed';
  url?: string;
  mime?: string;
  bytes?: number;
}

export interface ProgressEvent {
  fileId: string;
  assetId: string;
  jobId: string | null;
  phase: 'upload' | 'download' | 'processing';
  state: string;
  percentage: number | null;
  etaMs: number | null;
  quiet: boolean;
  terminal: boolean;
  errorCode?: string;
  /** Present on the terminal success event. `_original` is the current original. */
  versions?: Record<string, ProgressVersion>;
}

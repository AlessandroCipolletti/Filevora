/** One progress shape for upload, remote download, encoding, and transforms. */
export const PROGRESS_EVENT_FIELDS = {
  fileId: 'string',
  assetId: 'string',
  jobId: 'string | null',
  phase: 'upload | download | processing',
  state: 'string',
  percentage: 'number | null',
  etaMs: 'number | null',
  quiet: 'boolean',
  terminal: 'boolean',
  errorCode: 'string?',
  versions: 'Record<version, { version, status, url?, mime?, bytes? }>?',
} as const;

type _ProgressFieldsCoverEvent =
  Exclude<keyof ProgressEvent, keyof typeof PROGRESS_EVENT_FIELDS> extends never
    ? true
    : never;
const _progressFieldsCoverEvent: _ProgressFieldsCoverEvent = true;
void _progressFieldsCoverEvent;

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

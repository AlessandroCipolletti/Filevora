import { useEffect, useState } from 'react';
import type { UploadProgress, UploadState } from '../client/upload-client.js';
import type { ProcessingUpdate } from '../client/progress-stream.js';

interface UploadLike {
  upload(file: File): {
    on(event: 'progress', listener: (progress: UploadProgress) => void): void;
    on(event: 'state', listener: (state: UploadState) => void): void;
    complete(): Promise<{ id: string }>;
  };
  uploadDirect(
    file: Blob & { name?: string },
    init: {
      mimeType: string;
      mode?: 'single' | 'multipart';
      onProgress?: (progress: UploadProgress) => void;
    },
  ): Promise<{ id: string }>;
  watchProcessing(
    fileId: string,
    listener: (update: ProcessingUpdate) => void,
    watch?: { signal?: AbortSignal },
  ): Promise<void>;
}

/** State for an upload. Renders nothing. The app draws the UI. */
export function useUpload(client: UploadLike) {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [state, setState] = useState<UploadState>('queued');
  const [error, setError] = useState<unknown>(null);
  const [fileId, setFileId] = useState<string | null>(null);

  function start(file: File) {
    setError(null);
    const task = client.upload(file);
    task.on('progress', setProgress);
    task.on('state', setState);
    return task.complete().then(
      (record) => {
        setFileId(record.id);
        return record;
      },
      (reason: unknown) => {
        setError(reason);
        throw reason;
      },
    );
  }

  function uploadToS3(file: Blob & { name?: string }, mimeType: string) {
    setError(null);
    setState('uploading');
    return client
      .uploadDirect(file, { mimeType, onProgress: setProgress })
      .then(
        (record) => {
          setState('completed');
          setFileId(record.id);
          return record;
        },
        (reason: unknown) => {
          setState('failed');
          setError(reason);
          throw reason;
        },
      );
  }

  return { start, uploadToS3, progress, state, error, fileId };
}

/** Processing updates for one asset. Renders nothing. */
export function useAssetProgress(client: UploadLike, fileId: string | null) {
  const [update, setUpdate] = useState<ProcessingUpdate | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!fileId) return;
    const controller = new AbortController();
    client
      .watchProcessing(fileId, setUpdate, { signal: controller.signal })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      });
    return () => controller.abort();
  }, [client, fileId]);
  return { update, error };
}

export interface ResumeRecord {
  fingerprint: string;
  endpoint: string;
  sessionId: string;
  fileId: string;
  idempotencyKey: string;
  partSize: number;
  partCount: number;
  uploadedParts: number[];
  partUrlTemplate: string;
  completeUrl: string;
  expiresAt: string;
  filename?: string;
  blob?: Blob;
}

export interface ResumeStore {
  get(key: string): Promise<ResumeRecord | undefined>;
  set(key: string, value: ResumeRecord): Promise<void>;
  delete(key: string): Promise<void>;
  list?(): Promise<ResumeRecord[]>;
}

export function resumeKey(endpoint: string, fingerprint: string): string {
  return `${endpoint}\n${fingerprint}`;
}

/** In-memory resume store for tests and for callers that do not want IndexedDB. */
export function createMemoryResumeStore(): ResumeStore {
  const records = new Map<string, ResumeRecord>();
  return {
    async get(key) {
      const value = records.get(key);
      return value
        ? { ...value, uploadedParts: [...value.uploadedParts] }
        : undefined;
    },
    async set(key, value) {
      records.set(key, { ...value, uploadedParts: [...value.uploadedParts] });
    },
    async delete(key) {
      records.delete(key);
    },
    async list() {
      return [...records.values()].map((value) => ({
        ...value,
        uploadedParts: [...value.uploadedParts],
      }));
    },
  };
}

/**
 * Best-effort IndexedDB resume store. Quota failures reject; callers should
 * treat persistence as optional and keep the server session as the source of truth.
 */
interface IdbRequest {
  result: unknown;
  error: { message?: string } | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IdbDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): void;
  transaction(name: string, mode: 'readonly' | 'readwrite'): IdbTransaction;
  close(): void;
}

interface IdbTransaction {
  objectStore(name: string): {
    get(key: string): IdbRequest;
    getAll(): IdbRequest;
    put(value: ResumeRecord, key: string): IdbRequest;
    delete(key: string): IdbRequest;
  };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: { message?: string } | null;
}

type OpenRequest = IdbRequest & {
  result: IdbDatabase;
  onupgradeneeded: (() => void) | null;
};

function indexedDb(): { open(name: string, version: number): OpenRequest } {
  const candidate = (
    globalThis as {
      indexedDB?: { open(name: string, version: number): OpenRequest };
    }
  ).indexedDB;
  if (!candidate)
    throw new Error('IndexedDB is not available in this environment.');
  return candidate;
}

export function createIndexedDbResumeStore(dbName = 'filevora'): ResumeStore {
  const storeName = 'resumes';
  const open = () =>
    new Promise<IdbDatabase>((resolve, reject) => {
      const request = indexedDb().open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName))
          request.result.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(request.error?.message ?? 'IndexedDB open failed'));
    });
  const run = async (
    mode: 'readonly' | 'readwrite',
    fn: (store: ReturnType<IdbTransaction['objectStore']>) => IdbRequest,
  ) => {
    const database = await open();
    try {
      const tx = database.transaction(storeName, mode);
      const result = await requestToPromise(fn(tx.objectStore(storeName)));
      await transactionDone(tx);
      return result;
    } finally {
      database.close();
    }
  };
  return {
    async get(key) {
      return (await run('readonly', (store) => store.get(key))) as
        ResumeRecord | undefined;
    },
    async set(key, value) {
      await run('readwrite', (store) => store.put(value, key));
    },
    async delete(key) {
      await run('readwrite', (store) => store.delete(key));
    },
    async list() {
      const rows = (await run('readonly', (store) => store.getAll())) as
        ResumeRecord[] | undefined;
      return rows ?? [];
    },
  };
}

function requestToPromise(request: IdbRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(request.error?.message ?? 'IndexedDB request failed'));
  });
}

function transactionDone(tx: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(new Error(tx.error?.message ?? 'IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(new Error(tx.error?.message ?? 'IndexedDB transaction aborted'));
  });
}

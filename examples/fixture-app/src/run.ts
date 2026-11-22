import { createUploadClient } from 'filevora/client';
import { createFilesHandler } from 'filevora/http';
import { createFiles } from 'filevora/server';
import type { FileRecord } from 'filevora/types';
import { runWorker } from 'filevora/worker';

const files = createFiles({ env: 'test' });
const unused: FileRecord | null = null;
void unused;
void createUploadClient;
void createFilesHandler;
void runWorker;

process.stdout.write(`provider=${files.config.provider}\n`);
await files.close();

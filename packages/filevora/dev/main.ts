import { createUploadClient } from '../src/client/index.ts';

const client = createUploadClient({ endpoint: '/api/files' });
const status = globalThis.document?.querySelector('#status');
if (status) status.textContent = typeof client.upload;

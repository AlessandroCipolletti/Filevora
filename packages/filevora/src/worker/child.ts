import { runWorker } from './run.js';

const abort = new AbortController();
process.on('SIGTERM', () => abort.abort());
process.on('SIGINT', () => abort.abort());

await runWorker({ signal: abort.signal });
process.exit(0);

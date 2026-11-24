import type { ProgressEvent } from '../progress/event.js';

export type { ProgressEvent as ProcessingUpdate } from '../progress/event.js';

/** Parse an SSE body. Resolves when a terminal update arrives or the body ends. */
export async function readEventStream(
  response: Response,
  onEvent: (update: ProgressEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The progress response has no body.');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const data = part
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data.startsWith('{') === false) continue;
      const update = JSON.parse(data) as ProgressEvent;
      onEvent(update);
      if (update.terminal) return;
    }
  }
}

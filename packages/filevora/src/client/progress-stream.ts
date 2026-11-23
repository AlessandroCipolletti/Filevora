export interface ProcessingUpdate {
  fileId: string;
  state: string;
  percentage: number | null;
  etaMs: number | null;
  quiet: boolean;
  terminal: boolean;
}

/** Parse an SSE body. Resolves when a terminal update arrives or the body ends. */
export async function readEventStream(
  response: Response,
  onEvent: (update: ProcessingUpdate) => void,
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
      const update = JSON.parse(data) as ProcessingUpdate;
      onEvent(update);
      if (update.terminal) return;
    }
  }
}

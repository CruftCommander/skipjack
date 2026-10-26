// Reads a server-sent events stream, as both Anthropic's and OpenAI's APIs send one. Each event's
// "data:" lines are joined and handed to `onData`; the event's own "event:" line is not needed,
// because both APIs repeat the type inside the JSON.

export interface SseOptions {
  /** Called for every chunk received, so the caller can reset an idle timeout. */
  onChunk?: (() => void) | undefined;
}

const dataOf = (chunk: string): string =>
  chunk
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');

/**
 * Reads `body` to the end, calling `onData` with each event's data. Handles CRLF line endings and a
 * final event with no blank line after it. If `onData` throws, or a read fails, the download is
 * cancelled rather than left running, and the error is rethrown.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void, { onChunk }: SseOptions = {}): Promise<void> {
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      onChunk?.();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      // Events are separated by a blank line.
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        const data = dataOf(chunk);
        if (data) onData(data);
      }
      if (done) break;
    }
    finished = true;
  } finally {
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
  }
  if (buffer.trim()) {
    const data = dataOf(buffer);
    if (data) onData(data);
  }
}

/** Parses one event's data as JSON, or returns null for anything that is not a JSON object. */
export function parseEvent(data: string): Record<string, unknown> | null {
  try {
    const e: unknown = JSON.parse(data);
    return e && typeof e === 'object' ? (e as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

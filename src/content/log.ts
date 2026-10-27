// Console logging with a fixed prefix, so `[Skipjack]` filters the DevTools console to this extension.
// While the diagnostic log is on, each line is also handed to a sink that sends it to the background
// script, which keeps it in local storage (see logbook.ts).

import { clip, LOG_MAX_BATCH, type LogEntry, type LogLevel } from '../core/logbook';
import type { Timers } from '../core/skipper';

const PREFIX = '[Skipjack]';

type Sink = (entry: LogEntry) => void;
let sink: Sink | null = null;

/** Sets where log lines go besides the console, or stops sending them with null. */
export function setLogSink(next: Sink | null): void {
  sink = next;
}

function write(level: LogLevel, message: string): void {
  if (level === 'warn') console.warn(PREFIX, message);
  else console.info(PREFIX, message);
  if (!sink) return;
  try {
    sink({ at: Date.now(), level, text: clip(message) });
  } catch {
    // The log is a convenience; a failure to record a line must never break what logged it.
  }
}

export const log = {
  info: (message: string): void => write('info', message),
  warn: (message: string): void => write('warn', message),
};

/** Lines waiting to be sent before the oldest are dropped, if the background stops answering. */
const MAX_QUEUED = 1000;

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Collects log lines and sends them to the background in batches, `delayMs` after the first line of
 * a batch, so a burst of lines costs one message and one storage write.
 */
export class LogForwarder {
  private queue: LogEntry[] = [];
  private timer: unknown = null;

  constructor(
    private readonly send: (entries: LogEntry[]) => Promise<unknown>,
    private readonly delayMs = 1000,
    private readonly timers: Timers = realTimers,
  ) {}

  push(entry: LogEntry): void {
    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    if (this.timer === null) this.timer = this.timers.set(() => this.flush(), this.delayMs);
  }

  /** Sends everything queued now. */
  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, LOG_MAX_BATCH);
      try {
        void this.send(batch).catch(() => undefined);
      } catch {
        // The extension was reloaded or removed under this page; its lines have nowhere to go.
      }
    }
  }
}

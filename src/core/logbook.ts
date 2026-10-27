// The diagnostic log: a copy of Skipjack's `[Skipjack]` console lines, kept on this computer while
// the user has it turned on, so a session can be read after the fact. Pure functions only: the
// background script stores the log, and the settings page saves it as a text file.

export type LogLevel = 'info' | 'warn';

export interface LogEntry {
  /** Milliseconds since the epoch. */
  at: number;
  level: LogLevel;
  text: string;
}

/** Local storage key of the log. Local only: it names the videos watched, so it never syncs. */
export const LOG_KEY = 'diagnosticLog';
/** Lines kept before the oldest are dropped. A busy evening of videos is a few hundred. */
export const LOG_MAX_LINES = 2000;
/** Lines older than this are dropped. */
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest line kept; longer lines are cut. Skipjack's own lines are well under it. */
export const LOG_MAX_TEXT = 1000;
/** Most lines one message to the background may carry. */
export const LOG_MAX_BATCH = 100;
/** How far ahead of the background's clock a line's time may be, for clock skew between contexts. */
const FUTURE_SLACK_MS = 60_000;

export function isLogEntry(v: unknown): v is LogEntry {
  const e = v as Record<string, unknown> | null;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    e.at > 0 &&
    (e.level === 'info' || e.level === 'warn') &&
    typeof e.text === 'string' &&
    e.text.length > 0 &&
    e.text.length <= LOG_MAX_TEXT
  );
}

/** The valid entries in whatever is stored under LOG_KEY. */
export function readLog(raw: unknown): LogEntry[] {
  return Array.isArray(raw) ? raw.filter(isLogEntry) : [];
}

/** Cuts a line to LOG_MAX_TEXT characters. */
export function clip(text: string): string {
  return text.length <= LOG_MAX_TEXT ? text : `${text.slice(0, LOG_MAX_TEXT - 1)}…`;
}

/**
 * Hides anything shaped like an API key. Skipjack never logs a key, but a provider's error message
 * could echo one, and the log is meant to be safe to hand to someone else.
 */
export function redact(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]');
}

/**
 * Adds `incoming` to `existing`: redacts each new line, sorts by time (lines from several tabs
 * interleave), and keeps the newest LOG_MAX_LINES that are no older than LOG_MAX_AGE_MS.
 */
export function appendLog(existing: readonly LogEntry[], incoming: readonly LogEntry[], now: number): LogEntry[] {
  const cutoff = now - LOG_MAX_AGE_MS;
  const fresh = incoming.map((e) => ({ at: e.at, level: e.level, text: redact(clip(e.text)) }));
  const kept = [...existing, ...fresh].filter((e) => e.at >= cutoff && e.at <= now + FUTURE_SLACK_MS);
  // Array.prototype.sort is stable, so lines from one tab in the same millisecond keep their order.
  kept.sort((a, b) => a.at - b.at);
  return kept.slice(-LOG_MAX_LINES);
}

/** The log as a text file: `header` lines marked with `#`, then one line per entry, times in UTC. */
export function formatLog(entries: readonly LogEntry[], header: readonly string[]): string {
  const head = header.map((h) => `# ${h}`);
  const body = entries.map((e) => `${new Date(e.at).toISOString()} ${e.level === 'warn' ? 'WARN' : 'INFO'} ${e.text}`);
  return `${[...head, ...(head.length ? [''] : []), ...body].join('\n')}\n`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** File name for a log saved at `when`, in local time: skipjack-log-2026-10-26-2053.txt. */
export function logFileName(when: Date): string {
  return `skipjack-log-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}.txt`;
}

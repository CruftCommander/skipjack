// The diagnostic log's store, in the background script: content scripts can't write local storage,
// so they send their lines here. Appends and clears run one at a time, so lines from several tabs
// are never lost to a race, and a clear cannot be undone by a batch that was already in flight.
// Nothing is stored unless the user turned the log on; turning it off stops recording and keeps
// what was saved until the user clears it or it ages out.

import type { BrowserShell } from '../browser/shell';
import type { ClearLogResponse, LogResponse } from '../core/messages';
import { appendLog, clip, LOG_KEY, readLog, type LogEntry, type LogLevel } from '../core/logbook';
import { normalizeSettings, SETTINGS_KEY } from '../core/settings';

export class DiagnosticLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly shell: BrowserShell,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs `task` after every earlier one has finished, whether or not they succeeded. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Adds content script lines to the log, if the setting is on. */
  append(entries: LogEntry[]): Promise<LogResponse> {
    return this.serial(async () => {
      const settings = normalizeSettings(await this.shell.getSynced(SETTINGS_KEY));
      if (!settings.diagnostics.log) return { ok: true, stored: false };
      const log = readLog(await this.shell.getLocal(LOG_KEY));
      await this.shell.setLocalItems({ [LOG_KEY]: appendLog(log, entries, this.now()) });
      return { ok: true, stored: true };
    });
  }

  /** Logs one of the background script's own lines, to the console and, if the setting is on, the log. */
  record(level: LogLevel, text: string): void {
    (level === 'warn' ? console.warn : console.info)('[Skipjack]', text);
    void this.append([{ at: this.now(), level, text: `background: ${clip(text)}` }]).catch(() => undefined);
  }

  /** Deletes the log. */
  clear(): Promise<ClearLogResponse> {
    return this.serial(async () => {
      const removed = readLog(await this.shell.getLocal(LOG_KEY)).length;
      await this.shell.removeLocal([LOG_KEY]);
      return { ok: true, removed };
    });
  }

  /** Drops lines that aged out while nothing was logged. Run when the browser starts. */
  prune(): Promise<void> {
    return this.serial(async () => {
      const raw = await this.shell.getLocal(LOG_KEY);
      if (raw === undefined) return;
      const kept = appendLog(readLog(raw), [], this.now());
      if (kept.length === 0) await this.shell.removeLocal([LOG_KEY]);
      else await this.shell.setLocalItems({ [LOG_KEY]: kept });
    });
  }
}

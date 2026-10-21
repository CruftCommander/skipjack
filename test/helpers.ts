import { normalizeSettings, type Settings } from '../src/core/settings';
import type { MediaLike, Timers } from '../src/core/skipper';
import type { Category, Segment } from '../src/core/types';

export function seg(category: Category, start: number, end: number, id = `${category}-${start}`): Segment {
  return { id, category, start, end, source: 'test' };
}

/** Defaults with zero margins, so expected times in tests are the raw segment times. */
export function settings(overrides: Record<string, unknown> = {}): Settings {
  return normalizeSettings({ margin: { beforeSeconds: 0, afterSeconds: 0 }, ...overrides });
}

export class FakeMedia implements MediaLike {
  currentTimeValue = 0;
  duration = 600;
  paused = false;
  playbackRate = 1;
  seeks: number[] = [];
  pauses = 0;
  private listeners = new Map<string, Set<() => void>>();

  get currentTime(): number {
    return this.currentTimeValue;
  }
  set currentTime(value: number) {
    this.currentTimeValue = value;
    this.seeks.push(value);
    // A real element fires `seeked` asynchronously; tests fire it by hand with emit('seeked').
  }
  pause(): void {
    this.paused = true;
    this.pauses++;
  }
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  /** Moves playback to `time` without recording a seek, as normal playback does. */
  playTo(time: number): void {
    this.currentTimeValue = time;
    this.emit('timeupdate');
  }
}

export class FakeTimers implements Timers {
  pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 1;
  set(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** The single pending timer's delay, or undefined when none is pending. */
  only(): number | undefined {
    if (this.pending.size > 1) throw new Error(`expected at most one timer, found ${this.pending.size}`);
    return [...this.pending.values()][0]?.ms;
  }
  fire(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of entries) t.callback();
  }
}

// Drives skips on one media element. Platform- and browser-neutral: it sees only MediaLike.

import { decide, nextStart, type PlannedSkip, type SkipRun } from './policy';
import type { Settings } from './settings';

/** The subset of HTMLMediaElement the controller uses, so tests can pass a fake. */
export interface MediaLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly playbackRate: number;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SkipEvent {
  /** The windows skipped, merged into one run. */
  run: SkipRun;
  /** Where playback was when the skip happened. */
  fromTime: number;
  /** Where the skip landed. */
  toTime: number;
  paused: boolean;
}

export interface SkipControllerOptions {
  media: MediaLike;
  plan: PlannedSkip[];
  settings: Settings;
  /**
   * IDs of segments the user undid. Owned by the caller so it survives a new controller for the
   * same media, for example when the platform swaps the media element.
   */
  undone: Set<string>;
  /** False while the platform is showing its own ad, the player holds other media, or the extension is gone. */
  canAct: () => boolean;
  onSkip: (event: SkipEvent) => void;
  timers?: Timers;
}

const EVENTS = ['timeupdate', 'playing', 'play', 'seeked', 'ratechange', 'durationchange', 'loadedmetadata', 'pause'];

/** Fire a scheduled check this many milliseconds early, then re-check, so the skip is not late. */
const EARLY_MS = 30;
const MIN_TIMER_MS = 15;

export class SkipController {
  private readonly media: MediaLike;
  private readonly canAct: () => boolean;
  private readonly onSkip: (event: SkipEvent) => void;
  private readonly timers: Timers;
  private readonly undone: Set<string>;
  private plan: PlannedSkip[];
  private settings: Settings;
  /**
   * Segments skipped-and-paused near the end, mapped to their run's start. Not skipped again, so
   * pressing play continues, until playback moves back before the run, which re-arms them.
   */
  private readonly endPaused = new Map<string, number>();
  /** An Undo requested while the controller could not act (for example during an ad). */
  private pendingUndo: SkipEvent | null = null;
  private timer: unknown = null;
  private started = false;
  private destroyed = false;
  private readonly listener = (): void => this.check();

  constructor(options: SkipControllerOptions) {
    this.media = options.media;
    this.plan = options.plan;
    this.settings = options.settings;
    this.undone = options.undone;
    this.canAct = options.canAct;
    this.onSkip = options.onSkip;
    this.timers = options.timers ?? realTimers;
  }

  /** Starts listening and runs the first check. Separate from the constructor so `onSkip` can use the instance. */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    for (const type of EVENTS) this.media.addEventListener(type, this.listener);
    this.check();
  }

  /** Replaces the plan, for example after a settings change. Keeps the undo state. */
  update(plan: PlannedSkip[], settings: Settings): void {
    this.plan = plan;
    this.settings = settings;
    this.check();
  }

  /**
   * Undoes a skip: goes back to the start of the run and lets it play. Its segments are not
   * skipped again for this media. If a seek is not allowed right now, the undo waits until it is.
   */
  undo(event: SkipEvent): void {
    if (this.destroyed) return;
    for (const w of event.run.windows) {
      this.undone.add(w.segment.id);
      this.endPaused.delete(w.segment.id);
    }
    if (!this.canAct()) {
      this.pendingUndo = event;
      return;
    }
    this.pendingUndo = null;
    this.media.currentTime = event.run.from;
    this.check();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    for (const type of EVENTS) this.media.removeEventListener(type, this.listener);
  }

  /** Visible for tests. */
  check(): void {
    if (this.destroyed || !this.started) return;
    this.clearTimer();
    if (!this.canAct()) return;

    if (this.pendingUndo) {
      const event = this.pendingUndo;
      this.pendingUndo = null;
      this.media.currentTime = event.run.from;
    }

    const time = this.media.currentTime;
    for (const [id, runStart] of this.endPaused) if (time < runStart) this.endPaused.delete(id);
    if (this.media.paused) return;

    const excluded = this.excluded();
    const decision = decide(time, this.media.duration, this.plan, excluded, this.settings);
    if (decision.kind === 'skip') {
      const { run, seekTo, pause } = decision;
      if (pause) {
        for (const w of run.windows) this.endPaused.set(w.segment.id, run.from);
        this.media.pause();
      }
      if (seekTo !== time) this.media.currentTime = seekTo;
      this.onSkip({ run, fromTime: time, toTime: seekTo, paused: pause });
      if (pause) return;
    }
    this.schedule(excluded);
  }

  private excluded(): Set<string> {
    if (this.endPaused.size === 0) return this.undone;
    return new Set([...this.undone, ...this.endPaused.keys()]);
  }

  private schedule(excluded: ReadonlySet<string>): void {
    const time = this.media.currentTime;
    const next = nextStart(time, this.plan, excluded);
    if (next === null) return;
    const rate = this.media.playbackRate > 0 ? this.media.playbackRate : 1;
    // The floor keeps a stalled player (buffering, so time is not advancing) from spinning the loop.
    const ms = Math.max(MIN_TIMER_MS, ((next - time) * 1000) / rate - EARLY_MS);
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.check();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}

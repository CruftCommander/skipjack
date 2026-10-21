// Pure skip policy: which segments to skip and where a skip lands. No timers, no DOM.

import type { Settings } from './settings';
import type { Segment } from './types';

/** A segment that passed the filters, with the margins applied. */
export interface PlannedSkip {
  segment: Segment;
  /** Start of the skip window, in seconds: segment start minus the before-margin. */
  from: number;
  /** End of the skip window, in seconds: segment end plus the after-margin. */
  to: number;
}

/**
 * Overlapping or touching windows merged into one, so back-to-back segments are skipped with a
 * single seek and undone as a unit. With the default margins, adjacent segments always overlap.
 */
export interface SkipRun {
  windows: PlannedSkip[];
  from: number;
  to: number;
}

export type SkipDecision =
  | { kind: 'none' }
  | { kind: 'skip'; run: SkipRun; seekTo: number; pause: boolean };

/** A skip that would move playback forward by less than this is not worth a visible seek. */
export const MIN_SKIP_SECONDS = 0.1;

/** When pausing near the end, never land later than this before the end, so the media does not finish. */
export const PAUSE_BEFORE_END_SECONDS = 0.25;

/**
 * Filters segments by the settings and applies the margins. Returns windows sorted by start.
 */
export function planSkips(segments: readonly Segment[], settings: Settings): PlannedSkip[] {
  if (!settings.enabled) return [];
  const plan: PlannedSkip[] = [];
  for (const segment of segments) {
    if (!settings.categories[segment.category]) continue;
    if (!(Number.isFinite(segment.start) && Number.isFinite(segment.end))) continue;
    const length = segment.end - segment.start;
    if (length <= 0) continue;
    // The minimum length applies to reminders and self-promotion only. Sponsors are skipped at any length.
    if (segment.category !== 'sponsor' && settings.minLength.enabled && length < settings.minLength.seconds) continue;
    plan.push({
      segment,
      from: Math.max(0, segment.start - settings.margin.beforeSeconds),
      to: segment.end + settings.margin.afterSeconds,
    });
  }
  plan.sort((a, b) => a.from - b.from || a.to - b.to);
  return plan;
}

/** Merges the windows not in `excluded` into runs. `plan` must be sorted by `from`, as planSkips returns it. */
export function buildRuns(plan: readonly PlannedSkip[], excluded: ReadonlySet<string>): SkipRun[] {
  const runs: SkipRun[] = [];
  let current: SkipRun | null = null;
  for (const window of plan) {
    if (excluded.has(window.segment.id)) continue;
    if (current && window.from <= current.to) {
      current.windows.push(window);
      current.to = Math.max(current.to, window.to);
    } else {
      current = { windows: [window], from: window.from, to: window.to };
      runs.push(current);
    }
  }
  return runs;
}

/**
 * Decides what to do at playback position `time` (seconds) in media of length `duration`
 * (seconds; NaN or Infinity when unknown, as for live streams).
 *
 * End-of-video rule: when a skip would land within `endOfVideo.thresholdSeconds` of the end, the
 * user's `endOfVideo.action` applies:
 * - `play`: the windows that reach into the end zone play. Earlier windows in the same run are still
 *   skipped, landing where they end. A sponsor is never left to play: if one reaches the end zone,
 *   the whole run is skipped and paused instead.
 * - `skip`: skip to the end of the run, which can finish the media.
 * - `skipAndPause`: skip to the end of the run, but no later than just before the end, then pause.
 */
export function decide(
  time: number,
  duration: number,
  plan: readonly PlannedSkip[],
  excluded: ReadonlySet<string>,
  settings: Settings,
): SkipDecision {
  const run = buildRuns(plan, excluded).find((r) => time >= r.from && time < r.to);
  if (!run) return { kind: 'none' };

  const known = Number.isFinite(duration) && duration > 0;
  const runEnd = known ? Math.min(run.to, duration) : run.to;
  const endZone = known ? duration - settings.endOfVideo.thresholdSeconds : Number.POSITIVE_INFINITY;

  if (run.to < endZone) return skipTo(run, time, runEnd, false);

  const tail = run.windows.filter((w) => w.to >= endZone);
  let action = settings.endOfVideo.action;
  if (action === 'play' && tail.some((w) => w.segment.category === 'sponsor')) action = 'skipAndPause';

  if (action === 'skip') return skipTo(run, time, runEnd, false);
  if (action === 'skipAndPause') {
    // Already past the pause point: pause where we are rather than seek backward.
    const seekTo = Math.max(time, Math.min(runEnd, duration - PAUSE_BEFORE_END_SECONDS));
    return { kind: 'skip', run, seekTo, pause: true };
  }

  // `play`: skip the head of the run, if any, and let the tail play.
  const head = run.windows.filter((w) => w.to < endZone);
  if (head.length === 0) return { kind: 'none' };
  const landing = Math.max(...head.map((w) => w.to));
  return skipTo({ windows: head, from: run.from, to: landing }, time, landing, false);
}

function skipTo(run: SkipRun, time: number, seekTo: number, pause: boolean): SkipDecision {
  if (seekTo - time < MIN_SKIP_SECONDS) return { kind: 'none' };
  return { kind: 'skip', run, seekTo, pause };
}

/** The next run start after `time`, ignoring excluded segments. Used to schedule a precise check. */
export function nextStart(time: number, plan: readonly PlannedSkip[], excluded: ReadonlySet<string>): number | null {
  for (const run of buildRuns(plan, excluded)) {
    if (run.from > time) return run.from;
  }
  return null;
}

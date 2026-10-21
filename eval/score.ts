// Scores detected segments against hand-verified ground truth.
// Directions follow the boundary bias: a start that is late or an end that is early shows part of the
// pitch ("pitch shown"); a start that is early or an end that is late costs content ("content lost").

import type { Category } from '../src/core/types';

export interface TruthSegment {
  category: Category;
  start: number;
  end: number;
  /**
   * Optional: any start in [from, to] is as good as `start`, for boundaries where Jeff has no
   * preference. Errors are measured from the nearest edge of the range.
   */
  startRange?: [number, number];
  /** Optional: any end in [from, to] is as good as `end`. */
  endRange?: [number, number];
}

export interface Detected {
  category: Category;
  start: number;
  end: number;
}

/** A boundary passes when it shows at most this much pitch... */
export const PASS_PITCH_SHOWN = 1.0;
/** ...and costs at most this much content. Matches what Jeff has accepted so far (2 s long, 1 s short). */
export const PASS_CONTENT_LOST = 3.0;

export interface BoundaryScore {
  /** Positive: seconds of pitch shown. */
  pitchShown: number;
  /** Positive: seconds of content skipped. */
  contentLost: number;
  pass: boolean;
}

export interface Match {
  truth: TruthSegment;
  detected: Detected;
  start: BoundaryScore;
  end: BoundaryScore;
}

export interface VideoScore {
  matches: Match[];
  missed: TruthSegment[];
  /** Detections that overlap no truth segment of the same category. */
  falsePositives: Detected[];
  /** Missed truth segments that a detection covered under a different category. */
  wrongCategory: { truth: TruthSegment; detected: Detected }[];
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function boundary(pitchShown: number, contentLost: number): BoundaryScore {
  const p = Math.max(0, pitchShown);
  const c = Math.max(0, contentLost);
  return { pitchShown: p, contentLost: c, pass: p <= PASS_PITCH_SHOWN && c <= PASS_CONTENT_LOST };
}

export function scoreVideo(truth: TruthSegment[], detected: Detected[]): VideoScore {
  const used = new Set<number>();
  const matches: Match[] = [];
  const missed: TruthSegment[] = [];

  for (const t of truth) {
    let best = -1;
    let bestOverlap = 0;
    detected.forEach((d, i) => {
      if (used.has(i) || d.category !== t.category) return;
      const o = overlap(t, d);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = i;
      }
    });
    const d = detected[best];
    if (!d || bestOverlap < 0.3 * (t.end - t.start)) {
      missed.push(t);
      continue;
    }
    used.add(best);
    matches.push({
      truth: t,
      detected: d,
      start: boundary(d.start - (t.startRange?.[1] ?? t.start), (t.startRange?.[0] ?? t.start) - d.start),
      end: boundary((t.endRange?.[0] ?? t.end) - d.end, d.end - (t.endRange?.[1] ?? t.end)),
    });
  }

  // A detection nested inside a matched one of another category skips nothing extra, so it is not
  // counted as a false positive.
  const matchedSpans = [...used].map((i) => detected[i]!);
  const falsePositives = detected.filter(
    (d, i) => !used.has(i) && !matchedSpans.some((m) => m.start <= d.start && m.end >= d.end),
  );
  const wrongCategory: VideoScore['wrongCategory'] = [];
  for (const t of missed) {
    const d = falsePositives.find((x) => overlap(t, x) >= 0.3 * (t.end - t.start));
    if (d) wrongCategory.push({ truth: t, detected: d });
  }
  return { matches, missed, falsePositives, wrongCategory };
}

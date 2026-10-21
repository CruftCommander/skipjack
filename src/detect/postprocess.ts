// Turns a model's line-based report into timed DetectedSegments.
//
// Times come from code, not the model: a boundary is placed at the quoted words' position inside
// their line, interpolated across the line's time span. When the quote can't be found, the boundary
// falls back to the edge of the line that skips more, never less, following the boundary bias.
// Then segments are clamped, merged, and snapped outward to chapter marks and the video end.

import { isCategory, type Category } from '../core/types';
import type { Line } from './prompt';
import type { Chapter, DetectedSegment } from '../llm/provider';

/** A chapter start or the video end within this many seconds of a boundary pulls the boundary to it. */
export const SNAP_SECONDS = 3;
/** Shorter detections are dropped as noise. */
export const MIN_DETECTED_SECONDS = 1;
/** Same-category segments closer than this are merged. */
export const MERGE_GAP_SECONDS = 1;
/** Chapter titles that mark a sponsor read. */
const SPONSOR_CHAPTER = /\b(sponsor(ed)?|sponsor break|ad|ads|advert(isement)?|promo(tion)?)\b/i;

export interface ReportedSegment {
  category: Category;
  firstLine: number;
  lastLine: number;
  firstWords?: string;
  lastWords?: string;
  confidence: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}

export function parseToolInput(input: unknown): ReportedSegment[] {
  const list = (input as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) throw new Error('model output has no segments array');
  const out: ReportedSegment[] = [];
  for (const raw of list) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || !isCategory(s.category)) continue;
    const firstLine = Number(s.first_line);
    const lastLine = Number(s.last_line);
    if (!Number.isInteger(firstLine) || !Number.isInteger(lastLine)) continue;
    const confidence = Number(s.confidence);
    const seg: ReportedSegment = {
      category: s.category,
      firstLine,
      lastLine,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    };
    const first = text(s.first_words);
    const last = text(s.last_words);
    if (first) seg.firstWords = first;
    if (last) seg.lastWords = last;
    out.push(seg);
  }
  return out;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Where a quote starts (side 'start') or ends (side 'end') inside a line, as a fraction of the line's
 * words widened outward by one word, or null when the quote is not in the line. Tries the quote's first (or last) four words,
 * then fewer, so a quote that runs past the line still matches.
 */
export function quotePosition(lineText: string, quote: string | undefined, side: 'start' | 'end'): number | null {
  if (!quote) return null;
  const line = words(lineText);
  const q = words(quote);
  if (line.length === 0 || q.length === 0) return null;
  for (let n = Math.min(4, q.length); n >= 1; n--) {
    const probe = side === 'start' ? q.slice(0, n) : q.slice(q.length - n);
    // Single words only count when they are unique in the line; otherwise the match is a guess.
    const hits: number[] = [];
    for (let i = 0; i + probe.length <= line.length; i++) {
      if (probe.every((w, k) => line[i + k] === w)) hits.push(i);
    }
    if (hits.length === 0 || (n === 1 && hits.length > 1)) continue;
    // For a start, the earliest hit skips more; for an end, the latest hit does. Then widen by one
    // word: line times are only line starts, and pauses are not spread evenly across a line.
    const at = side === 'start' ? Math.min(...hits) - 1 : Math.max(...hits) + probe.length + 1;
    return Math.min(1, Math.max(0, at / line.length));
  }
  return null;
}

/** How many lines either side of the stated line to search when a quote is not in it. */
export const QUOTE_SEARCH_LINES = 2;

/**
 * Finds a quote in the stated line or, failing that, the nearest line within QUOTE_SEARCH_LINES.
 * Models sometimes quote the right words but name a neighboring line.
 */
function locate(lines: Line[], index: number, quote: string | undefined, side: 'start' | 'end'): { line: Line; frac: number } | null {
  for (let d = 0; d <= QUOTE_SEARCH_LINES; d++) {
    for (const i of d === 0 ? [index] : [index - d, index + d]) {
      const line = lines[i];
      if (!line) continue;
      const frac = quotePosition(line.text, quote, side);
      if (frac !== null) return { line, frac };
    }
  }
  return null;
}

/** Converts line-based reports to times. Reports pointing outside the transcript are dropped. */
export function toTimed(reports: ReportedSegment[], lines: Line[]): DetectedSegment[] {
  const out: DetectedSegment[] = [];
  for (const r of reports) {
    const firstIndex = Math.min(r.firstLine, r.lastLine);
    const lastIndex = Math.max(r.firstLine, r.lastLine);
    const first = lines[firstIndex];
    const last = lines[lastIndex];
    if (!first || !last) continue;
    // Without a match, fall back to the edge of the stated line that skips more.
    const a = locate(lines, firstIndex, r.firstWords, 'start') ?? { line: first, frac: 0 };
    const b = locate(lines, lastIndex, r.lastWords, 'end') ?? { line: last, frac: 1 };
    const start = a.line.start + a.frac * (a.line.next - a.line.start);
    const end = b.line.start + b.frac * (b.line.next - b.line.start);
    if (end <= start) continue;
    const seg: DetectedSegment = { category: r.category, start, end, confidence: r.confidence };
    if (r.firstWords) seg.firstWords = r.firstWords;
    if (r.lastWords) seg.lastWords = r.lastWords;
    out.push(seg);
  }
  return out;
}

/**
 * Clamps to the video, merges same-category neighbors, fits sponsor detections to a chapter the
 * creator titled as a sponsor, and snaps outward to nearby chapter marks and the video end.
 */
export function refine(segments: DetectedSegment[], durationSeconds: number, chapters: Chapter[] = []): DetectedSegment[] {
  const known = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const sorted = [...chapters].filter((c) => Number.isFinite(c.start)).sort((a, b) => a.start - b.start);
  const marks = sorted.map((c) => c.start).filter((t) => t > 0);

  let list = segments
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: known ? Math.min(durationSeconds, s.end) : s.end }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // A chapter the creator titled "Sponsor" is the best boundary evidence there is. Sponsor detections
  // that overlap it become exactly that chapter, widened by at most SNAP_SECONDS where a detection
  // reaches past it.
  sorted.forEach((c, i) => {
    if (!SPONSOR_CHAPTER.test(c.title)) return;
    const span = { start: c.start, end: sorted[i + 1]?.start ?? (known ? durationSeconds : Number.POSITIVE_INFINITY) };
    if (!Number.isFinite(span.end)) return;
    const hits = list.filter((s) => s.category === 'sponsor' && s.start < span.end && s.end > span.start);
    if (hits.length === 0) return;
    const start = Math.min(span.start, ...hits.map((h) => (span.start - h.start <= SNAP_SECONDS ? h.start : span.start)));
    const end = Math.max(span.end, ...hits.map((h) => (h.end - span.end <= SNAP_SECONDS ? h.end : span.end)));
    const best = hits.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    list = list.filter((s) => !hits.includes(s));
    list.push({ ...best, start, end });
    list.sort((a, b) => a.start - b.start);
  });

  // Merge same-category neighbors.
  const merged: DetectedSegment[] = [];
  for (const s of list) {
    let prev: DetectedSegment | undefined;
    for (let i = merged.length - 1; i >= 0 && !prev; i--) if (merged[i]?.category === s.category) prev = merged[i];
    if (prev && s.start - prev.end <= MERGE_GAP_SECONDS) {
      prev.end = Math.max(prev.end, s.end);
      prev.confidence = Math.max(prev.confidence, s.confidence);
      if (s.lastWords) prev.lastWords = s.lastWords;
    } else {
      merged.push({ ...s });
    }
  }

  // A segment nested inside one of another category is kept: results are cached and filtered by
  // the user's category settings later, and the nested one still matters if the outer category is off.
  const out: DetectedSegment[] = [];
  for (const seg of merged) {
    let { start, end } = seg;
    // Outward only: an earlier chapter mark can move the start back, a later one can move the end on.
    for (const m of marks) {
      if (m <= start && start - m <= SNAP_SECONDS) start = Math.min(start, m);
      if (m >= end && m - end <= SNAP_SECONDS) end = Math.max(end, m);
    }
    if (known && durationSeconds - end <= SNAP_SECONDS) end = durationSeconds;
    if (end - start < MIN_DETECTED_SECONDS) continue;
    out.push({ ...seg, start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Turns a model's raw tool input into clean DetectedSegments: validates every field, clamps to the
// video, snaps to nearby chapter marks and the video end, and always moves a boundary outward, never
// inward, following the boundary bias.

import { isCategory } from '../core/types';
import type { Chapter, DetectedSegment } from '../llm/provider';

/** A chapter start or the video end within this many seconds of a boundary pulls the boundary to it. */
export const SNAP_SECONDS = 3;
/** Shorter detections are dropped as noise. */
export const MIN_DETECTED_SECONDS = 1;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
}

export function parseToolInput(input: unknown): DetectedSegment[] {
  const list = (input as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) throw new Error('model output has no segments array');
  const out: DetectedSegment[] = [];
  for (const raw of list) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || !isCategory(s.category)) continue;
    const start = Number(s.start_seconds);
    const end = Number(s.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const confidence = Number(s.confidence);
    const seg: DetectedSegment = {
      category: s.category,
      start,
      end,
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

export function refine(segments: DetectedSegment[], durationSeconds: number, chapters: Chapter[] = []): DetectedSegment[] {
  const known = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const marks = chapters.map((c) => c.start).filter((t) => Number.isFinite(t) && t > 0);
  const out: DetectedSegment[] = [];

  for (const seg of segments) {
    let start = Math.max(0, seg.start);
    let end = known ? Math.min(durationSeconds, seg.end) : seg.end;
    if (end <= start) continue;

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

// Sponsor segments from chapter titles. A creator who titles a chapter "Sponsor" has marked the read
// already, so it is skipped without asking an LLM, and works with no API key. Decided by Jeff on
// 2026-10-25. Chapters the platform generated itself are never used this way.

import { CHAPTER_SOURCE } from './sources';
import type { MediaChapter, Segment } from './types';

/** A chapter longer than this is not taken as a sponsor read, in case the title means something else. */
export const MAX_SPONSOR_CHAPTER_SECONDS = 600;

/**
 * Titles that mark a sponsor read on their own: they start with "sponsor", "sponsored" or
 * "sponsorship" ("Sponsor", "Sponsor Pax Historia", "Sponsored by ..."), or are exactly an ad
 * label ("Ad", "Ad break", "Advertisement", "Paid promotion"). Deliberately narrower than the
 * pattern detection uses to fit boundaries, because here the title alone causes a skip.
 */
const SPONSOR_TITLE = /^\s*(?:sponsor(?:ed|ship)?\b|(?:ad(?:\s+(?:break|read|spot))?|advert(?:isement)?|paid\s+promotion)\s*$)/i;

export function isSponsorChapterTitle(title: string): boolean {
  return SPONSOR_TITLE.test(title);
}

/**
 * One sponsor segment per creator chapter with a sponsor title, from its start to the next chapter,
 * or to the end of the media for the last one. `lengthSeconds` is NaN or Infinity when unknown or
 * live; a last chapter is then left alone, because it has no end.
 */
export function sponsorChapterSegments(chapters: readonly MediaChapter[], lengthSeconds: number): Segment[] {
  const known = Number.isFinite(lengthSeconds) && lengthSeconds > 0;
  const sorted = chapters.filter((c) => Number.isFinite(c.start) && c.start >= 0).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  sorted.forEach((chapter, i) => {
    if (!chapter.byCreator || !isSponsorChapterTitle(chapter.title)) return;
    const next = sorted.slice(i + 1).find((c) => c.start > chapter.start);
    let end = next ? next.start : known ? lengthSeconds : Number.NaN;
    if (known) end = Math.min(end, lengthSeconds);
    if (!Number.isFinite(end) || end <= chapter.start) return;
    if (end - chapter.start > MAX_SPONSOR_CHAPTER_SECONDS) return;
    out.push({ id: `${CHAPTER_SOURCE}:${chapter.start}`, category: 'sponsor', start: chapter.start, end, source: CHAPTER_SOURCE });
  });
  return out;
}

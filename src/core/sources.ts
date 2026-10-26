// How segments from the community database and from transcript detection combine.

import type { DetectionMode, Settings } from './settings';
import { CATEGORIES, type Category, type Segment } from './types';

/** Segment.source for transcript detection. */
export const DETECTION_SOURCE = 'detect';

/** Segment.source for a sponsor segment taken from a chapter the creator titled as one. */
export const CHAPTER_SOURCE = 'chapter';

/** Detection is not worth running on media shorter than this. */
export const MIN_DETECTION_SECONDS = 60;

/** The enabled categories that community segments do not cover. */
export function missingCategories(community: readonly Segment[], settings: Settings): Category[] {
  const have = new Set(community.map((s) => s.category));
  return CATEGORIES.filter((c) => settings.categories[c] && !have.has(c));
}

/** Why the settings alone rule detection out, or null when they allow it. */
export function settingsSkipReason(mode: DetectionMode, settings: Settings): string | null {
  if (!settings.enabled) return 'Skipjack is switched off';
  if (mode === 'off') return 'detection is off in settings';
  if (!CATEGORIES.some((c) => settings.categories[c])) return 'every category is switched off';
  return null;
}

/**
 * Why detection should not run, given what the community database returned, or null when it
 * should. `durationSeconds` is Infinity for a live stream and NaN when the length isn't known.
 * The reason is logged, so that a video detection skipped can be told apart from one it missed.
 */
export function detectionSkipReason(
  mode: DetectionMode,
  community: readonly Segment[],
  settings: Settings,
  durationSeconds: number,
): string | null {
  const fromSettings = settingsSkipReason(mode, settings);
  if (fromSettings) return fromSettings;
  // Live streams have no fixed length, and very short media rarely carries a pitch.
  if (durationSeconds === Number.POSITIVE_INFINITY) return 'live streams are not analyzed';
  if (!Number.isFinite(durationSeconds)) return "the video's length isn't known";
  if (durationSeconds < MIN_DETECTION_SECONDS) return `shorter than ${MIN_DETECTION_SECONDS} seconds`;
  if (mode === 'noCommunity' && community.length > 0) return 'SponsorBlock has segments, and detection is set to run only when it has none';
  if (mode === 'fillGaps' && missingCategories(community, settings).length === 0) return 'SponsorBlock covers every enabled category';
  return null;
}

/** Whether detection should run, given what the community database returned. */
export function shouldDetect(
  mode: DetectionMode,
  community: readonly Segment[],
  settings: Settings,
  durationSeconds: number,
): boolean {
  return detectionSkipReason(mode, community, settings, durationSeconds) === null;
}

/**
 * Community segments plus detected segments for the categories the community lacks. The community
 * wins wherever it has a category: its boundaries were placed and voted on by people.
 */
export function mergeSources(community: readonly Segment[], detected: readonly Segment[]): Segment[] {
  const have = new Set(community.map((s) => s.category));
  return [...community, ...detected.filter((s) => !have.has(s.category))];
}

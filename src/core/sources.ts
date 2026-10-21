// How segments from the community database and from transcript detection combine.

import type { DetectionMode, Settings } from './settings';
import { CATEGORIES, type Category, type Segment } from './types';

/** Segment.source for transcript detection. */
export const DETECTION_SOURCE = 'detect';

/** Detection is not worth running on media shorter than this. */
export const MIN_DETECTION_SECONDS = 60;

/** The enabled categories that community segments do not cover. */
export function missingCategories(community: readonly Segment[], settings: Settings): Category[] {
  const have = new Set(community.map((s) => s.category));
  return CATEGORIES.filter((c) => settings.categories[c] && !have.has(c));
}

/** Whether detection should run, given what the community database returned. */
export function shouldDetect(
  mode: DetectionMode,
  community: readonly Segment[],
  settings: Settings,
  durationSeconds: number,
): boolean {
  if (!settings.enabled || mode === 'off') return false;
  // Live streams have no fixed length, and very short media rarely carries a pitch.
  if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_DETECTION_SECONDS) return false;
  if (mode === 'noCommunity') return community.length === 0;
  return missingCategories(community, settings).length > 0;
}

/**
 * Community segments plus detected segments for the categories the community lacks. The community
 * wins wherever it has a category: its boundaries were placed and voted on by people.
 */
export function mergeSources(community: readonly Segment[], detected: readonly Segment[]): Segment[] {
  const have = new Set(community.map((s) => s.category));
  return [...community, ...detected.filter((s) => !have.has(s.category))];
}

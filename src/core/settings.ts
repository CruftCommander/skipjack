import { CATEGORIES, type Category } from './types';

/**
 * What to do when a skip would land within `thresholdSeconds` of the end of the media.
 * - `play`: don't skip; the segment plays. Sponsors are the exception: see `decide` in policy.ts.
 * - `skip`: skip anyway, which can end the media and start autoplay.
 * - `skipAndPause`: skip, then pause, so the next media does not start.
 */
export type EndOfVideoAction = 'play' | 'skip' | 'skipAndPause';

export const END_OF_VIDEO_ACTIONS: readonly EndOfVideoAction[] = ['play', 'skip', 'skipAndPause'];

/**
 * When transcript detection runs.
 * - `fillGaps`: on every video, for the categories SponsorBlock has no segments for. SponsorBlock
 *   wins wherever it has a category.
 * - `noCommunity`: only on videos SponsorBlock has no segments for at all.
 * - `off`: never.
 */
export type DetectionMode = 'fillGaps' | 'noCommunity' | 'off';

export const DETECTION_MODES: readonly DetectionMode[] = ['fillGaps', 'noCommunity', 'off'];

/** The model detection uses unless the user picks another. Chosen by the eval on 2026-10-21. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export interface Settings {
  /** Master switch. */
  enabled: boolean;
  /** Which categories are skipped. */
  categories: Record<Category, boolean>;
  /** Interaction reminders and self-promotion shorter than this are left alone. Sponsors ignore it. */
  minLength: { enabled: boolean; seconds: number };
  /** Show a toast with an Undo button after each skip. */
  toast: { enabled: boolean };
  /** Behavior near the end of the media. */
  endOfVideo: { action: EndOfVideoAction; thresholdSeconds: number };
  /**
   * Extra time added to each side of a segment. Jeff's boundary bias: skip a little extra rather than
   * show any part of the pitch.
   */
  margin: { beforeSeconds: number; afterSeconds: number };
  /** Transcript detection. The API key is not here: it stays in local storage on this computer. */
  detection: {
    mode: DetectionMode;
    /** Model ID, for example `claude-sonnet-5-5`. */
    model: string;
    /**
     * Turn captions on for a moment, with the overlay hidden, so the player fetches the transcript.
     * Off: detection runs only when the viewer already has captions on.
     */
    captionsToggle: boolean;
  };
}

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze<Settings>({
  enabled: true,
  categories: { sponsor: true, selfpromo: true, interaction: true },
  minLength: { enabled: true, seconds: 5 },
  toast: { enabled: true },
  endOfVideo: { action: 'play', thresholdSeconds: 5 },
  margin: { beforeSeconds: 0.5, afterSeconds: 0.5 },
  detection: { mode: 'fillGaps', model: DEFAULT_MODEL, captionsToggle: true },
});

export const LIMITS = {
  minLengthSeconds: { min: 0, max: 120 },
  endThresholdSeconds: { min: 0, max: 120 },
  marginSeconds: { min: 0, max: 5 },
} as const;

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Turns whatever is in storage into a complete, valid Settings object. Unknown keys are dropped,
 * missing or invalid values fall back to the defaults, and numbers are clamped to LIMITS.
 */
export function normalizeSettings(raw: unknown): Settings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS;
  const cats = obj(r.categories);
  const minLength = obj(r.minLength);
  const toast = obj(r.toast);
  const end = obj(r.endOfVideo);
  const margin = obj(r.margin);
  const detection = obj(r.detection);

  const categories = {} as Record<Category, boolean>;
  for (const c of CATEGORIES) categories[c] = bool(cats[c], d.categories[c]);

  const action = (END_OF_VIDEO_ACTIONS as readonly unknown[]).includes(end.action)
    ? (end.action as EndOfVideoAction)
    : d.endOfVideo.action;

  return {
    enabled: bool(r.enabled, d.enabled),
    categories,
    minLength: {
      enabled: bool(minLength.enabled, d.minLength.enabled),
      seconds: num(minLength.seconds, d.minLength.seconds, LIMITS.minLengthSeconds),
    },
    toast: { enabled: bool(toast.enabled, d.toast.enabled) },
    endOfVideo: {
      action,
      thresholdSeconds: num(end.thresholdSeconds, d.endOfVideo.thresholdSeconds, LIMITS.endThresholdSeconds),
    },
    margin: {
      beforeSeconds: num(margin.beforeSeconds, d.margin.beforeSeconds, LIMITS.marginSeconds),
      afterSeconds: num(margin.afterSeconds, d.margin.afterSeconds, LIMITS.marginSeconds),
    },
    detection: {
      mode: (DETECTION_MODES as readonly unknown[]).includes(detection.mode) ? (detection.mode as DetectionMode) : d.detection.mode,
      model: typeof detection.model === 'string' && /^[a-z0-9][a-z0-9.-]{2,80}$/.test(detection.model) ? detection.model : d.detection.model,
      captionsToggle: bool(detection.captionsToggle, d.detection.captionsToggle),
    },
  };
}

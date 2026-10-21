// The segment model. Nothing in core knows about a specific media site or browser.

/** Segment categories. The names match SponsorBlock's, so its data maps straight onto the settings. */
export type Category = 'sponsor' | 'selfpromo' | 'interaction';

export const CATEGORIES: readonly Category[] = ['sponsor', 'selfpromo', 'interaction'];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  sponsor: 'Sponsor',
  selfpromo: 'Self-promotion',
  interaction: 'Interaction reminder',
};

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** Identifies one piece of media. Keyed by platform so the cache can hold more than one platform. */
export interface MediaRef {
  /** Platform adapter ID, for example `youtube`. */
  platform: string;
  /** The platform's own ID for the media, for example a YouTube video ID. */
  id: string;
}

/** A span of media to skip, as reported by a segment source. Times are in seconds. */
export interface Segment {
  /** Unique within the media. Prefixed with the source ID, for example `sponsorblock:<uuid>`. */
  id: string;
  category: Category;
  start: number;
  end: number;
  /** ID of the segment source that produced it. */
  source: string;
}

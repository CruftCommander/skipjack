// Plug-in point 2 of 4: segment sources.
// A source turns a MediaRef into segments: a community database, labeled chapters, the transcript
// classifier (step 3), or a shared cache. Adding a source means adding one module.

import type { MediaRef, Segment } from '../core/types';

export interface SegmentSource {
  /** Stable ID, used as the prefix of Segment.id and in Segment.source. */
  readonly id: string;
  /** True when this source can answer for the given platform. */
  supports(platform: string): boolean;
  /** Segments for the media. An empty array means the source knows of none. Throws on failure. */
  getSegments(media: MediaRef, signal?: AbortSignal): Promise<Segment[]>;
}

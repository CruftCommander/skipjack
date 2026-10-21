// Collects segments for a media item from every source that supports its platform, with a small
// in-memory cache. The Chromium service worker can be stopped at any time, which empties the cache;
// that only costs one more lookup.

import type { GetSegmentsResponse } from '../core/messages';
import type { MediaRef, Segment } from '../core/types';
import type { SegmentSource } from '../sources/source';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 100;
const TIMEOUT_MS = 8000;

interface Entry {
  at: number;
  response: GetSegmentsResponse;
}

export class SegmentService {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly sources: readonly SegmentSource[],
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(media: MediaRef): Promise<GetSegmentsResponse> {
    const key = `${media.platform}:${media.id}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.response;

    const applicable = this.sources.filter((s) => s.supports(media.platform));
    const results = await Promise.allSettled(applicable.map((s) => withTimeout(s, media)));

    const segments: Segment[] = [];
    const used: string[] = [];
    const errors: string[] = [];
    results.forEach((result, i) => {
      const source = applicable[i];
      if (!source) return;
      if (result.status === 'fulfilled') {
        segments.push(...result.value);
        used.push(source.id);
      } else {
        errors.push(`${source.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    });

    // Every source failed: report the error and do not cache it, so the next video view retries.
    if (applicable.length > 0 && used.length === 0) return { ok: false, error: errors.join('; ') };

    const response: GetSegmentsResponse = { ok: true, segments, sources: used };
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), response });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return response;
  }
}

async function withTimeout(source: SegmentSource, media: MediaRef): Promise<Segment[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await source.getSegments(media, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

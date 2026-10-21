// SponsorBlock's community database. Queried by hash prefix, so the server never learns which video
// is being watched: it returns every video whose SHA-256 ID hash starts with the same 4 hex digits.
// API: https://wiki.sponsor.ajay.app/w/API_Docs (GET /api/skipSegments/:sha256HashPrefix).
// Segment data is SponsorBlock's; see the attribution in README.md.

import { CATEGORIES, isCategory, type MediaRef, type Segment } from '../core/types';
import type { SegmentSource } from './source';

export const SPONSORBLOCK_ID = 'sponsorblock';
export const SPONSORBLOCK_BASE_URL = 'https://sponsor.ajay.app';
const PREFIX_LENGTH = 4;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildUrl(prefix: string, base = SPONSORBLOCK_BASE_URL): string {
  const params = new URLSearchParams({
    // Always ask for every category Skipjack knows. The settings filter them later, so a cached
    // answer stays valid when the user changes a toggle.
    categories: JSON.stringify(CATEGORIES),
    actionTypes: JSON.stringify(['skip']),
    service: 'YouTube',
  });
  return `${base}/api/skipSegments/${prefix}?${params.toString()}`;
}

/** Extracts this video's skip segments from a hash-prefix response, dropping anything malformed. */
export function parseResponse(body: unknown, videoId: string): Segment[] {
  if (!Array.isArray(body)) return [];
  const entry = body.find((e: unknown) => (e as { videoID?: unknown } | null)?.videoID === videoId) as
    | { segments?: unknown }
    | undefined;
  if (!entry || !Array.isArray(entry.segments)) return [];

  const out: Segment[] = [];
  for (const raw of entry.segments as unknown[]) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') continue;
    if (s.actionType !== 'skip' || !isCategory(s.category)) continue;
    const span = s.segment;
    if (!Array.isArray(span) || span.length < 2) continue;
    const [start, end] = span as unknown[];
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    const uuid = typeof s.UUID === 'string' && s.UUID ? s.UUID : `${start}-${end}-${s.category}`;
    out.push({ id: `${SPONSORBLOCK_ID}:${uuid}`, category: s.category, start, end, source: SPONSORBLOCK_ID });
  }
  return out;
}

export function createSponsorBlockSource(fetchFn: FetchFn = (i, init) => fetch(i, init)): SegmentSource {
  return {
    id: SPONSORBLOCK_ID,
    supports: (platform) => platform === 'youtube',
    async getSegments(media: MediaRef, signal?: AbortSignal) {
      const prefix = (await sha256Hex(media.id)).slice(0, PREFIX_LENGTH);
      const init: RequestInit = { headers: { Accept: 'application/json' } };
      if (signal) init.signal = signal;
      const response = await fetchFn(buildUrl(prefix), init);
      // 404 means no video with this hash prefix has segments.
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`SponsorBlock returned HTTP ${response.status}`);
      return parseResponse(await response.json(), media.id);
    },
  };
}

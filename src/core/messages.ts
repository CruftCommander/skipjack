// Typed messages between the content script and the background script.

import type { MediaRef, Segment } from './types';

export interface GetSegmentsRequest {
  type: 'getSegments';
  media: MediaRef;
}

export type GetSegmentsResponse =
  | { ok: true; segments: Segment[]; sources: string[] }
  | { ok: false; error: string };

export type Request = GetSegmentsRequest;

export function isRequest(value: unknown): value is Request {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type !== 'getSegments') return false;
  const media = v.media as Record<string, unknown> | null | undefined;
  return (
    media !== null &&
    typeof media === 'object' &&
    typeof media.platform === 'string' &&
    typeof media.id === 'string' &&
    media.platform.length > 0 &&
    media.id.length > 0
  );
}

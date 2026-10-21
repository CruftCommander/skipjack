// Typed messages between the content script, the background script, and the popup.

import type { ChannelRef } from './channels';
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

/** Sent by the popup to the content script in the active tab. */
export interface GetChannelRequest {
  type: 'getChannel';
}

export type GetChannelResponse =
  | { ok: true; media: MediaRef; channel: ChannelRef | null }
  | { ok: false };

export function isGetChannelRequest(value: unknown): value is GetChannelRequest {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'getChannel';
}

// Typed messages between the content script, the background script, and the popup.

import type { ChannelRef } from './channels';
import type { DetectionInput } from '../llm/provider';
import { isLogEntry, LOG_MAX_BATCH, type LogEntry } from './logbook';
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

/** Content to background: is a detection result cached, and could detection run at all? */
export interface DetectionStatusRequest {
  type: 'detectionStatus';
  media: MediaRef;
  model: string;
}

export type DetectionStatusResponse = { ok: true; cached: Segment[] | null; keySet: boolean } | { ok: false; error: string };

/** Content to background: run detection on this transcript. */
export interface DetectRequest {
  type: 'detect';
  model: string;
  input: DetectionInput;
}

export type DetectResponse =
  | { ok: true; segments: Segment[]; cached: boolean; inputTokens: number; outputTokens: number }
  | { ok: false; error: string };

/** Local storage key of the last detection's outcome, written by the background, shown on the settings page. */
export const DETECTION_STATUS_KEY = 'detectionStatus';

/** Prefix of every cached detection result and failure hold in local storage. */
export const DETECTION_CACHE_PREFIX = 'det:';

/** Shown on the settings page, so a failing key or a quota problem is visible. */
export interface DetectionStatus {
  at: number;
  ok: boolean;
  message: string;
  media?: MediaRef;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The local storage keys "Clear detection cache" removes: every cached result and failure hold, and
 * the last detection's status, which names the last video analyzed. Not the API key or the hourly budget.
 */
export function detectionCacheKeys(all: Record<string, unknown>): string[] {
  return Object.keys(all).filter((k) => k.startsWith(DETECTION_CACHE_PREFIX) || k === DETECTION_STATUS_KEY);
}

/** Background to content (active tab): the undo shortcut was pressed. */
export interface UndoLastSkipRequest {
  type: 'undoLastSkip';
}

/** The most cues a transcript may carry: about 6 hours of auto-captions. */
export const MAX_CUES = 12000;

function isMediaRef(v: unknown): v is MediaRef {
  const m = v as Record<string, unknown> | null;
  return !!m && typeof m === 'object' && typeof m.platform === 'string' && typeof m.id === 'string' && m.platform.length > 0 && m.id.length > 0;
}

export function isDetectionStatusRequest(v: unknown): v is DetectionStatusRequest {
  const r = v as Record<string, unknown> | null;
  return !!r && r.type === 'detectionStatus' && isMediaRef(r.media) && typeof r.model === 'string';
}

/** Limits on what a content script may ask the background to send to a provider. */
export const MAX_TRANSCRIPT_CHARS = 400_000;
export const MAX_CHAPTERS = 100;
export const MAX_PROMO_LINES = 10;
const MAX_LINE_CHARS = 2000;
/** Longer than any real video; a guard against nonsense, not a policy. */
export const MAX_DURATION_SECONDS = 48 * 3600;

function finiteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function shortString(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_LINE_CHARS;
}

function isSignals(v: unknown, duration: number): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.paidPromotion !== undefined && typeof s.paidPromotion !== 'boolean') return false;
  if (s.chapters !== undefined) {
    if (!Array.isArray(s.chapters) || s.chapters.length > MAX_CHAPTERS) return false;
    const ok = s.chapters.every((c) => {
      const ch = c as Record<string, unknown> | null;
      return !!ch && shortString(ch.title) && finiteIn(ch.start, 0, duration);
    });
    if (!ok) return false;
  }
  if (s.descriptionPromoLines !== undefined) {
    if (!Array.isArray(s.descriptionPromoLines) || s.descriptionPromoLines.length > MAX_PROMO_LINES) return false;
    if (!s.descriptionPromoLines.every(shortString)) return false;
  }
  return true;
}

export function isDetectRequest(v: unknown): v is DetectRequest {
  const r = v as Record<string, unknown> | null;
  if (!r || r.type !== 'detect' || typeof r.model !== 'string' || r.model.length > 100) return false;
  const input = r.input as Record<string, unknown> | null;
  if (!input || !isMediaRef(input.media)) return false;
  if (!finiteIn(input.durationSeconds, 1, MAX_DURATION_SECONDS)) return false;
  if (input.title !== undefined && !shortString(input.title)) return false;
  const duration = input.durationSeconds;
  if (!input.signals || !isSignals(input.signals, duration)) return false;
  const t = input.transcript;
  if (!Array.isArray(t) || t.length === 0 || t.length > MAX_CUES) return false;
  let chars = 0;
  for (const c of t) {
    const cue = c as Record<string, unknown> | null;
    if (!cue || !finiteIn(cue.start, 0, duration + 60) || !finiteIn(cue.duration, 0, 3600) || !shortString(cue.text)) return false;
    chars += cue.text.length;
    if (chars > MAX_TRANSCRIPT_CHARS) return false;
  }
  return true;
}

export function isUndoLastSkipRequest(v: unknown): v is UndoLastSkipRequest {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'undoLastSkip';
}

/** Content to background: lines for the diagnostic log. Stored only while the setting is on. */
export interface LogRequest {
  type: 'log';
  entries: LogEntry[];
}

export type LogResponse = { ok: true; stored: boolean } | { ok: false; error: string };

export function isLogRequest(v: unknown): v is LogRequest {
  const r = v as Record<string, unknown> | null;
  return (
    !!r &&
    r.type === 'log' &&
    Array.isArray(r.entries) &&
    r.entries.length > 0 &&
    r.entries.length <= LOG_MAX_BATCH &&
    r.entries.every(isLogEntry)
  );
}

/**
 * Settings page to background: delete the diagnostic log. Done in the background, where appends are
 * queued, so a batch in flight cannot bring cleared lines back.
 */
export interface ClearLogRequest {
  type: 'clearLog';
}

export type ClearLogResponse = { ok: true; removed: number } | { ok: false; error: string };

export function isClearLogRequest(v: unknown): v is ClearLogRequest {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'clearLog';
}

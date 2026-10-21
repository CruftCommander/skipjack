// Transcript detection in the background script: the API key never reaches a web page. Results are
// cached per video in local storage for 60 days (up to 2,000 videos), so a video is not paid for
// again on every visit, and two tabs opening the same video share one request. A failure after the
// provider accepted the request is held for a day, so a video that fails is not paid for on every
// visit, and fresh detections are capped per hour, so a bug or a hostile page cannot run up a bill.

import type { BrowserShell } from '../browser/shell';
import {
  DETECTION_CACHE_PREFIX,
  DETECTION_STATUS_KEY,
  type DetectionStatus,
  type DetectionStatusResponse,
  type DetectResponse,
} from '../core/messages';
import { DETECTION_SOURCE } from '../core/sources';
import { isCategory, type MediaRef, type Segment } from '../core/types';
import { SpentError, type DetectedSegment, type DetectionInput, type LlmProvider } from '../llm/provider';

/** Cached results kept before the oldest are pruned. Each is a few hundred bytes. */
const CACHE_MAX = 2000;
/** Results older than this are detected again, in case the video was edited. */
const CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
/** A failure that cost tokens is remembered this long before the video is tried again. */
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const BUDGET_KEY = 'detectionBudget';
/** Fresh detections allowed per rolling hour. Watching videos back to back stays well under it. */
export const HOURLY_LIMIT = 60;
const HOUR_MS = 60 * 60 * 1000;
/** Longest wait with nothing from the provider: no response headers, or no new chunk of the stream. */
export const IDLE_TIMEOUT_MS = 60_000;
/**
 * Longest a detection may take in all. Chromium may stop a service worker that takes more than five
 * minutes to handle one event, and the content script's message is that event.
 */
export const TOTAL_TIMEOUT_MS = 240_000;
/** How often to make an extension API call while a detection runs, under Chromium's 30-second idle limit. */
export const KEEPALIVE_MS = 20_000;

interface CacheEntry {
  at: number;
  /** The model that answered, or for a failure, the model that was asked. */
  model: string;
  segments: { category: string; start: number; end: number; confidence: number }[];
  /** Set when detection failed after the request was accepted. */
  failed?: string;
}

export interface DetectionServiceOptions {
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  keepAliveMs?: number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every?: (fn: () => void, ms: number) => () => void;
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

export function cacheKey(media: MediaRef): string {
  return `${DETECTION_CACHE_PREFIX}${media.platform}:${media.id}`;
}

function toSegments(entry: CacheEntry): Segment[] {
  const out: Segment[] = [];
  entry.segments.forEach((s, i) => {
    if (!isCategory(s.category) || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) return;
    out.push({ id: `${DETECTION_SOURCE}:${i}-${s.category}`, category: s.category, start: s.start, end: s.end, source: DETECTION_SOURCE });
  });
  return out;
}

/**
 * A usable cache entry for `model`, or null. A failure hold applies only to the model that failed,
 * so switching models on the settings page tries the video again.
 */
function readEntry(raw: unknown, now: number, model: string): CacheEntry | null {
  const e = raw as CacheEntry | null;
  if (!e || typeof e !== 'object' || typeof e.at !== 'number' || !Array.isArray(e.segments)) return null;
  const failed = typeof e.failed === 'string';
  if (failed && e.model !== model) return null;
  return now - e.at < (failed ? FAILURE_TTL_MS : CACHE_TTL_MS) ? e : null;
}

function failedMessage(entry: CacheEntry): string {
  return `detection failed on this video within the last day (${entry.failed}); it is tried again after that`;
}

function limitMessage(): string {
  return `The limit of ${HOURLY_LIMIT} detections an hour is reached; detection resumes within the hour.`;
}

export class DetectionService {
  private readonly inFlight = new Map<string, Promise<DetectResponse>>();
  /** Serializes reads and writes of the hourly budget. */
  private budgetLock: Promise<unknown> = Promise.resolve();
  private stopKeepAlive: (() => void) | null = null;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly keepAliveMs: number;
  private readonly every: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly shell: BrowserShell,
    private readonly providerFor: (model: string) => LlmProvider | null,
    private readonly apiKeyFor: (provider: LlmProvider) => Promise<string | null>,
    private readonly now: () => number = () => Date.now(),
    options: DetectionServiceOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
    this.keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS;
    this.every = options.every ?? defaultEvery;
  }

  async status(media: MediaRef, model: string): Promise<DetectionStatusResponse> {
    const entry = readEntry(await this.shell.getLocal(cacheKey(media)), this.now(), model);
    if (entry?.failed !== undefined) return { ok: false, error: failedMessage(entry) };
    if (entry) return { ok: true, cached: toSegments(entry), keySet: true };
    const provider = this.providerFor(model);
    if (!provider) return this.refuse(media, `No provider offers the model ${model}; choose a model on the settings page.`);
    const keySet = Boolean(await this.apiKeyFor(provider));
    if (keySet && (await this.recentDetections()).length >= HOURLY_LIMIT) return this.refuse(media, limitMessage());
    return { ok: true, cached: null, keySet };
  }

  detect(input: DetectionInput, model: string): Promise<DetectResponse> {
    const key = cacheKey(input.media);
    const running = this.inFlight.get(key);
    if (running) return running;
    // Chromium can stop the service worker partway through a long stream; keep it alive meanwhile.
    if (this.inFlight.size === 0) this.startKeepAlive();
    const job = this.run(input, model).finally(() => {
      this.inFlight.delete(key);
      if (this.inFlight.size === 0) this.endKeepAlive();
    });
    this.inFlight.set(key, job);
    return job;
  }

  private startKeepAlive(): void {
    this.endKeepAlive();
    this.stopKeepAlive = this.every(() => void this.shell.keepAlive().catch(() => undefined), this.keepAliveMs);
  }

  private endKeepAlive(): void {
    this.stopKeepAlive?.();
    this.stopKeepAlive = null;
  }

  private async run(input: DetectionInput, model: string): Promise<DetectResponse> {
    const key = cacheKey(input.media);
    const cached = readEntry(await this.shell.getLocal(key), this.now(), model);
    if (cached?.failed !== undefined) return { ok: false, error: failedMessage(cached) };
    if (cached) return { ok: true, segments: toSegments(cached), cached: true, inputTokens: 0, outputTokens: 0 };

    const provider = this.providerFor(model);
    if (!provider) return this.fail(input.media, `No provider offers the model ${model}.`);
    const apiKey = await this.apiKeyFor(provider);
    if (!apiKey) return this.fail(input.media, `No ${provider.label} API key is set.`);
    if (!(await this.reserve())) return this.fail(input.media, limitMessage());

    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => {
      timedOut = true;
      controller.abort();
    };
    let idle = setTimeout(abort, this.idleTimeoutMs);
    const total = setTimeout(abort, this.totalTimeoutMs);
    const onActivity = (): void => {
      clearTimeout(idle);
      idle = setTimeout(abort, this.idleTimeoutMs);
    };

    let result;
    try {
      result = await provider.detect(input, { apiKey, model, signal: controller.signal, onActivity });
    } catch (error) {
      // Only a failure after the provider accepted the request may have been billed, so only that
      // holds the video for a day. A timeout before then is tried again on the next visit.
      const spent = error instanceof SpentError;
      const message = timedOut
        ? spent
          ? `Detection timed out after ${provider.label} accepted the request.`
          : `Detection timed out before ${provider.label} accepted the request; it is tried again on the next visit.`
        : error instanceof Error
          ? error.message
          : String(error);
      if (spent) {
        const entry: CacheEntry = { at: this.now(), model, segments: [], failed: message.slice(0, 300) };
        await this.shell.setLocalItems({ [key]: entry }).catch(() => undefined);
      }
      return this.fail(input.media, message);
    } finally {
      clearTimeout(idle);
      clearTimeout(total);
    }

    // The result is paid for. Nothing after this point may turn it into a reported failure: if the
    // cache can't be written, the result is still used, and the video is detected again next time.
    const entry: CacheEntry = {
      at: this.now(),
      model: result.model,
      segments: result.segments.map((s: DetectedSegment) => ({
        category: s.category,
        start: Math.round(s.start * 100) / 100,
        end: Math.round(s.end * 100) / 100,
        confidence: Math.round(s.confidence * 100) / 100,
      })),
    };
    await this.shell.setLocalItems({ [key]: entry }).catch(() => undefined);
    await this.prune().catch(() => undefined);
    const { inputTokens, outputTokens } = result.usage;
    await this.record({
      at: this.now(),
      ok: true,
      media: input.media,
      message: `${entry.segments.length} segment(s) found with ${result.model}`,
      inputTokens,
      outputTokens,
    });
    return { ok: true, segments: toSegments(entry), cached: false, inputTokens, outputTokens };
  }

  private async fail(media: MediaRef, message: string): Promise<DetectResponse> {
    await this.record({ at: this.now(), ok: false, media, message });
    return { ok: false, error: message };
  }

  /**
   * A status check that refuses detection. Shown on the settings page, so it doesn't keep showing an
   * older success; written only when the message changes, since every video asks.
   */
  private async refuse(media: MediaRef, message: string): Promise<DetectionStatusResponse> {
    const current = (await this.shell.getLocal(DETECTION_STATUS_KEY).catch(() => undefined)) as DetectionStatus | undefined;
    if (!current || current.ok || current.message !== message) await this.record({ at: this.now(), ok: false, media, message });
    return { ok: false, error: message };
  }

  private async record(status: DetectionStatus): Promise<void> {
    await this.shell.setLocalItems({ [DETECTION_STATUS_KEY]: status }).catch(() => undefined);
  }

  private async recentDetections(): Promise<number[]> {
    const raw = await this.shell.getLocal(BUDGET_KEY);
    const cutoff = this.now() - HOUR_MS;
    return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === 'number' && t > cutoff && t <= this.now()) : [];
  }

  /** Takes one detection from the hourly budget, or returns false when none is left. */
  private reserve(): Promise<boolean> {
    const next = this.budgetLock.then(async () => {
      const recent = await this.recentDetections();
      if (recent.length >= HOURLY_LIMIT) return false;
      await this.shell.setLocalItems({ [BUDGET_KEY]: [...recent, this.now()] });
      return true;
    });
    this.budgetLock = next.catch(() => undefined);
    return next;
  }

  /** Drops the oldest cached results once there are more than CACHE_MAX. */
  private async prune(): Promise<void> {
    const all = await this.shell.getAllLocal();
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith(DETECTION_CACHE_PREFIX))
      .map(([k, v]) => ({ k, at: (v as CacheEntry | null)?.at ?? 0 }));
    if (entries.length <= CACHE_MAX) return;
    entries.sort((a, b) => a.at - b.at);
    await this.shell.removeLocal(entries.slice(0, entries.length - CACHE_MAX).map((e) => e.k));
  }
}

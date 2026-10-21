// Transcript detection in the background script: the API key never reaches a web page. Results are
// cached per video in local storage, so each video costs tokens once, and two tabs opening the same
// video share one request. A failure after the provider accepted the request is cached for a day, so
// a video that fails is not paid for on every visit, and fresh detections are capped per hour, so a
// bug or a hostile page cannot run up a bill.

import type { BrowserShell } from '../browser/shell';
import type { DetectResponse, DetectionStatusResponse } from '../core/messages';
import { DETECTION_SOURCE } from '../core/sources';
import { isCategory, type MediaRef, type Segment } from '../core/types';
import { SpentError, type DetectedSegment, type DetectionInput, type LlmProvider } from '../llm/provider';

const CACHE_PREFIX = 'det:';
/** Cached results kept before the oldest are pruned. Each is a few hundred bytes. */
const CACHE_MAX = 2000;
/** Results older than this are detected again, in case the video was edited. */
const CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
/** A failure that cost tokens is remembered this long before the video is tried again. */
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
export const DETECTION_STATUS_KEY = 'detectionStatus';
const BUDGET_KEY = 'detectionBudget';
/** Fresh detections allowed per rolling hour. Watching videos back to back stays well under it. */
export const HOURLY_LIMIT = 60;
const HOUR_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 120_000;

interface CacheEntry {
  at: number;
  model: string;
  segments: { category: string; start: number; end: number; confidence: number }[];
  /** Set when detection failed after the request was accepted. */
  failed?: string;
}

/** Shown on the settings page, so a failing key or a quota problem is visible. */
export interface DetectionStatus {
  at: number;
  ok: boolean;
  message: string;
  media?: MediaRef;
  inputTokens?: number;
  outputTokens?: number;
}

export function cacheKey(media: MediaRef): string {
  return `${CACHE_PREFIX}${media.platform}:${media.id}`;
}

function toSegments(entry: CacheEntry): Segment[] {
  const out: Segment[] = [];
  entry.segments.forEach((s, i) => {
    if (!isCategory(s.category) || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) return;
    out.push({ id: `${DETECTION_SOURCE}:${i}-${s.category}`, category: s.category, start: s.start, end: s.end, source: DETECTION_SOURCE });
  });
  return out;
}

function readEntry(raw: unknown, now: number): CacheEntry | null {
  const e = raw as CacheEntry | null;
  if (!e || typeof e !== 'object' || typeof e.at !== 'number' || !Array.isArray(e.segments)) return null;
  return now - e.at < (typeof e.failed === 'string' ? FAILURE_TTL_MS : CACHE_TTL_MS) ? e : null;
}

function failedMessage(entry: CacheEntry): string {
  return `detection failed on this video within the last day (${entry.failed}); it is tried again after that`;
}

function limitMessage(): string {
  return `the limit of ${HOURLY_LIMIT} detections an hour is reached; detection resumes within the hour`;
}

export class DetectionService {
  private readonly inFlight = new Map<string, Promise<DetectResponse>>();
  /** Serializes reads and writes of the hourly budget. */
  private budgetLock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly shell: BrowserShell,
    private readonly providerFor: (model: string) => LlmProvider | null,
    private readonly apiKeyFor: (provider: LlmProvider) => Promise<string | null>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async status(media: MediaRef, model: string): Promise<DetectionStatusResponse> {
    const entry = readEntry(await this.shell.getLocal(cacheKey(media)), this.now());
    if (entry?.failed !== undefined) return { ok: false, error: failedMessage(entry) };
    if (entry) return { ok: true, cached: toSegments(entry), keySet: true };
    const provider = this.providerFor(model);
    if (!provider) return { ok: false, error: `no provider offers the model ${model}; choose a model on the settings page` };
    const keySet = Boolean(await this.apiKeyFor(provider));
    if (keySet && (await this.recentDetections()).length >= HOURLY_LIMIT) return { ok: false, error: limitMessage() };
    return { ok: true, cached: null, keySet };
  }

  detect(input: DetectionInput, model: string): Promise<DetectResponse> {
    const key = cacheKey(input.media);
    const running = this.inFlight.get(key);
    if (running) return running;
    const job = this.run(input, model).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async run(input: DetectionInput, model: string): Promise<DetectResponse> {
    const key = cacheKey(input.media);
    const cached = readEntry(await this.shell.getLocal(key), this.now());
    if (cached?.failed !== undefined) return { ok: false, error: failedMessage(cached) };
    if (cached) return { ok: true, segments: toSegments(cached), cached: true, inputTokens: 0, outputTokens: 0 };

    const provider = this.providerFor(model);
    if (!provider) return this.fail(input.media, `No provider offers the model ${model}.`);
    const apiKey = await this.apiKeyFor(provider);
    if (!apiKey) return this.fail(input.media, `No ${provider.label} API key is set.`);
    if (!(await this.reserve())) return this.fail(input.media, `The limit of ${HOURLY_LIMIT} detections an hour is reached.`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const result = await provider.detect(input, { apiKey, model, signal: controller.signal });
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
      await this.shell.setLocalItems({ [key]: entry });
      await this.prune();
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
    } catch (error) {
      const message = controller.signal.aborted ? 'Detection timed out.' : error instanceof Error ? error.message : String(error);
      // A timeout or a failure mid-response may have been billed; don't pay for this video again today.
      if (error instanceof SpentError || controller.signal.aborted) {
        const entry: CacheEntry = { at: this.now(), model, segments: [], failed: message.slice(0, 300) };
        await this.shell.setLocalItems({ [key]: entry }).catch(() => undefined);
      }
      return this.fail(input.media, message);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fail(media: MediaRef, message: string): Promise<DetectResponse> {
    await this.record({ at: this.now(), ok: false, media, message });
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
      .filter(([k]) => k.startsWith(CACHE_PREFIX))
      .map(([k, v]) => ({ k, at: (v as CacheEntry | null)?.at ?? 0 }));
    if (entries.length <= CACHE_MAX) return;
    entries.sort((a, b) => a.at - b.at);
    await this.shell.removeLocal(entries.slice(0, entries.length - CACHE_MAX).map((e) => e.k));
  }
}

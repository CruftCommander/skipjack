// One Session per media item the user opens. It waits briefly to learn the channel, skips nothing on
// a channel the user excluded, otherwise looks up segments, waits for the media element, and runs a
// SkipController on it until the user moves to other media.

import type { ChannelStore } from '../browser/channel-store';
import type { BrowserShell } from '../browser/shell';
import { isExcluded, needsHandle, type ChannelRef } from '../core/channels';
import { formatTime } from '../core/format';
import type {
  DetectionStatusRequest,
  DetectionStatusResponse,
  DetectRequest,
  DetectResponse,
  GetSegmentsRequest,
  GetSegmentsResponse,
} from '../core/messages';
import { planSkips } from '../core/policy';
import type { Settings } from '../core/settings';
import { SkipController, type SkipEvent } from '../core/skipper';
import { DETECTION_SOURCE, mergeSources, shouldDetect } from '../core/sources';
import { CATEGORY_LABELS, type Category, type MediaRef, type Segment } from '../core/types';
import type { PlatformAdapter } from '../platforms/platform';
import type { Toast } from '../ui/toast';
import { log } from './log';

/** How often to look for the media element, and to notice when the platform replaces it. */
const ELEMENT_POLL_MS = 500;
/** Delays before retrying a failed segment lookup. */
const RETRY_DELAYS_MS = [2000, 6000];
/** How long to wait for the channel before looking up segments anyway. */
const CHANNEL_WAIT_MS = 4000;
const CHANNEL_POLL_MS = 200;
/** While held back, how often to re-check whether the channel is still excluded. */
const HELD_BACK_RECHECK_MS = 2000;
/** Transcript attempts, and how long the video must play between them. */
const TRANSCRIPT_ATTEMPTS = 3;
const TRANSCRIPT_RETRY_PLAY_MS = 10_000;

export class Session {
  /** What the community database returned. */
  private community: Segment[] = [];
  /** Community segments plus detected ones for the categories the community lacks. */
  private segments: Segment[] = [];
  private lastSkip: SkipEvent | null = null;
  private controller: SkipController | null = null;
  private element: HTMLMediaElement | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  /** Segments the user undid. Kept here so a replaced media element does not forget them. */
  private readonly undone = new Set<string>();
  private channel: ChannelRef | null = null;
  /** The lookup was held back because the channel is excluded. */
  private heldBack = false;
  private lookupStarted = false;
  private destroyed = false;

  constructor(
    readonly media: MediaRef,
    private readonly adapter: PlatformAdapter,
    private readonly shell: BrowserShell,
    private readonly channels: ChannelStore,
    private settings: Settings,
    private excluded: readonly ChannelRef[],
    private readonly toast: Toast,
  ) {
    void this.start();
  }

  /**
   * The channel, once the platform has told us. Details can arrive at different times, so an answer
   * for the same channel fills in what is missing. An answer naming a different channel ID replaces
   * what was known, so stale details never stick.
   */
  currentChannel(): ChannelRef | null {
    const now = this.adapter.channelOf(this.media.id);
    if (now) {
      const sameId = !this.channel?.id || !now.id || this.channel.id === now.id;
      this.channel = sameId ? { ...this.channel, ...now } : now;
    }
    return this.channel;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.controller?.update(planSkips(this.segments, settings), settings);
  }

  updateExclusions(excluded: readonly ChannelRef[]): void {
    const was = this.isExcluded();
    this.excluded = excluded;
    if (this.isExcluded()) {
      this.toast.hide();
      if (!was) log.info(`${this.media.id}: channel ${describeChannel(this.currentChannel())} is excluded; not skipping`);
    } else {
      this.resumeIfHeldBack();
    }
    // A running controller re-checks canAct on its next tick, so skipping stops or resumes on its own.
    this.controller?.update(planSkips(this.segments, this.settings), this.settings);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.retry) clearTimeout(this.retry);
    if (this.recheck) clearInterval(this.recheck);
    this.adapter.cancelTranscript?.();
    this.controller?.destroy();
    this.controller = null;
    this.toast.hide();
  }

  private isExcluded(): boolean {
    return isExcluded(this.currentChannel(), this.excluded);
  }

  /** True once the channel is known well enough to decide: an ID, plus a handle if any entry needs one. */
  private channelSettled(): boolean {
    // With no exclusions for this platform there is nothing to decide, so never delay the lookup.
    if (!this.excluded.some((e) => e.platform === this.media.platform)) return true;
    const ch = this.currentChannel();
    if (!ch) return false;
    if (isExcluded(ch, this.excluded)) return true;
    return !needsHandle(this.media.platform, this.excluded) || Boolean(ch.handle);
  }

  private async start(): Promise<void> {
    // The channel decides whether to look anything up, so wait for it briefly. Detection in step 3
    // costs tokens, and an excluded channel should cost nothing.
    const until = Date.now() + CHANNEL_WAIT_MS;
    while (!this.destroyed && !this.channelSettled() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, CHANNEL_POLL_MS));
    }
    if (this.destroyed) return;
    if (this.isExcluded()) {
      this.holdBack();
      return;
    }
    await this.lookup();
  }

  private holdBack(): void {
    this.heldBack = true;
    const channel = this.currentChannel();
    log.info(`${this.media.id}: channel ${describeChannel(channel)} is excluded; not skipping`);
    // An entry typed as a handle gains this channel's ID, so later matches don't need the handle.
    if (channel) void this.channels.backfill(channel, this.excluded).catch(() => undefined);
    // The decision rests on what the page said at the time. Re-check in case it was stale.
    this.recheck = setInterval(() => this.resumeIfHeldBack(), HELD_BACK_RECHECK_MS);
  }

  private resumeIfHeldBack(): void {
    if (!this.heldBack || this.lookupStarted || this.destroyed || this.isExcluded()) return;
    this.heldBack = false;
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    void this.lookup();
  }

  private async lookup(attempt = 0): Promise<void> {
    if (this.destroyed || !this.shell.isAlive()) return;
    this.lookupStarted = true;
    const request: GetSegmentsRequest = { type: 'getSegments', media: this.media };
    let response: GetSegmentsResponse;
    try {
      response = await this.shell.sendMessage<GetSegmentsResponse>(request);
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.destroyed) return;
    if (!response?.ok) {
      const delay = RETRY_DELAYS_MS[attempt];
      const error = response?.error ?? 'no response';
      log.warn(`segment lookup failed for ${this.media.id}: ${error}${delay ? `; retrying in ${delay / 1000} s` : ''}`);
      if (delay) this.retry = setTimeout(() => void this.lookup(attempt + 1), delay);
      // SponsorBlock is unreachable: detection can still cover the video on its own.
      else void this.detect().catch((e: unknown) => log.warn(`detection failed for ${this.media.id}: ${String(e)}`));
      return;
    }
    this.community = response.segments;
    this.segments = response.segments;
    const plan = planSkips(this.segments, this.settings);
    log.info(
      `${this.media.id}: ${this.segments.length} segment(s) from ${response.sources.join(', ') || 'no source'}, ` +
        `${plan.length} to skip with current settings`,
    );
    if (this.segments.length > 0) this.startAttaching();
    void this.detect().catch((error: unknown) => log.warn(`detection failed for ${this.media.id}: ${String(error)}`));
  }

  private startAttaching(): void {
    if (this.poll || this.destroyed) return;
    this.attach();
    this.poll = setInterval(() => this.attach(), ELEMENT_POLL_MS);
  }

  /** Undoes the most recent skip in this video. Returns false when there is nothing to undo. */
  undoLast(): boolean {
    return this.lastSkip ? this.undo(this.lastSkip) : false;
  }

  /** The one undo path, for the toast and the shortcut, so a skip is never undone twice. */
  private undo(event: SkipEvent): boolean {
    if (!this.controller) return false;
    this.controller.undo(event);
    this.toast.hide();
    if (this.lastSkip === event) this.lastSkip = null;
    return true;
  }

  /** Detection may run now: re-read before every step, because settings can change mid-way. */
  private detectionAllowed(): boolean {
    const { enabled, detection } = this.settings;
    return !this.destroyed && enabled && detection.mode !== 'off' && !this.isExcluded();
  }

  /**
   * Transcript detection for the categories the community database lacks. Costs tokens, so it checks
   * the cache and the API key before touching the captions.
   */
  private async detect(): Promise<void> {
    if (!this.adapter.readTranscript || !this.detectionAllowed()) return;

    // The length comes from the platform's data for this media: the media element may be playing
    // an ad, or still hold the previous video.
    const length = await this.waitForLength();
    if (!this.detectionAllowed() || !shouldDetect(this.settings.detection.mode, this.community, this.settings, length)) return;
    const element = await this.waitForElement();
    if (!element || !this.detectionAllowed()) return;

    const model = this.settings.detection.model;
    const statusRequest: DetectionStatusRequest = { type: 'detectionStatus', media: this.media, model };
    const status = await this.shell.sendMessage<DetectionStatusResponse>(statusRequest);
    if (!this.detectionAllowed()) return;
    if (!status?.ok) {
      // Refused before any captions are touched: the hourly limit, an unknown model, or a failure hold.
      log.warn(`${this.media.id}: no transcript detection: ${status?.error ?? 'no answer from the background script'}`);
      return;
    }
    if (status.cached) return this.applyDetected(status.cached, true);
    if (!status.keySet) {
      log.info(`${this.media.id}: no API key set, so no transcript detection`);
      return;
    }

    for (let attempt = 1; attempt <= TRANSCRIPT_ATTEMPTS; attempt++) {
      if (!this.detectionAllowed()) return;
      const transcript = await this.adapter.readTranscript(this.media.id, { allowToggle: this.settings.detection.captionsToggle });
      if (!this.detectionAllowed()) return;
      if (transcript.ok) {
        const request: DetectRequest = { type: 'detect', model: this.settings.detection.model, input: transcript.input };
        log.info(`${this.media.id}: detecting with ${request.model} (${transcript.input.transcript.length} caption lines)`);
        const result = await this.shell.sendMessage<DetectResponse>(request);
        // Detection can take a minute: the user may have switched it off or excluded the channel meanwhile.
        if (!this.detectionAllowed()) return;
        if (!result?.ok) {
          log.warn(`${this.media.id}: detection failed: ${result?.error ?? 'no response'}`);
          return;
        }
        if (!result.cached) log.info(`${this.media.id}: detection used ${result.inputTokens} input and ${result.outputTokens} output tokens`);
        return this.applyDetected(result.segments, result.cached);
      }
      log.warn(`${this.media.id}: no transcript (attempt ${attempt} of ${TRANSCRIPT_ATTEMPTS}): ${transcript.reason}`);
      if (!transcript.retry || attempt === TRANSCRIPT_ATTEMPTS) return;
      // The player often fetches captions only once playback is under way, so retry after the
      // video has played a while rather than after a fixed delay.
      await this.waitForPlayback(element, TRANSCRIPT_RETRY_PLAY_MS);
    }
  }

  private async waitForLength(timeoutMs = 15000): Promise<number> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const n = this.adapter.lengthOf?.(this.media.id) ?? null;
      if (n !== null || this.destroyed || Date.now() > until) return n ?? Number.NaN;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private applyDetected(detected: Segment[], cached: boolean): void {
    if (this.destroyed) return;
    this.segments = mergeSources(this.community, detected);
    const used = this.segments.filter((s) => s.source === DETECTION_SOURCE).length;
    log.info(`${this.media.id}: ${detected.length} detected segment(s)${cached ? ' (cached)' : ''}, ${used} used alongside SponsorBlock`);
    if (this.segments.length === 0) return;
    this.startAttaching();
    this.controller?.update(planSkips(this.segments, this.settings), this.settings);
  }

  private async waitForElement(timeoutMs = 15000): Promise<HTMLMediaElement | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const el = this.adapter.findMediaElement();
      if (el || this.destroyed || Date.now() > until) return el;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Resolves once the element has played for `ms` in total, however many pauses that takes. */
  private async waitForPlayback(el: HTMLMediaElement, ms: number): Promise<void> {
    let played = 0;
    while (!this.destroyed && played < ms) {
      await new Promise((r) => setTimeout(r, 500));
      if (!el.paused) played += 500;
    }
  }

  /** Starts a controller on the current media element, or moves it if the platform swapped elements. */
  private attach(): void {
    if (this.destroyed) return;
    // Disabling, reloading, or updating the extension leaves this script running in open tabs.
    if (!this.shell.isAlive()) {
      this.destroy();
      return;
    }
    const element = this.adapter.findMediaElement();
    if (!element || (element === this.element && element.isConnected)) return;
    this.controller?.destroy();
    this.element = element;
    const mediaId = this.media.id;
    this.controller = new SkipController({
      media: element,
      plan: planSkips(this.segments, this.settings),
      settings: this.settings,
      undone: this.undone,
      // The channel can become known, or be excluded, after the controller starts.
      canAct: () => this.shell.isAlive() && !this.isExcluded() && this.adapter.canSkipNow(mediaId),
      onSkip: (event) => this.onSkip(event),
    });
    this.controller.start();
  }

  private onSkip(event: SkipEvent): void {
    this.lastSkip = event;
    const categories = event.run.windows.map((w) => w.segment.category);
    const detected = event.run.windows.some((w) => w.segment.source === DETECTION_SOURCE);
    log.info(
      `skipped ${categories.join(' + ')} ${formatTime(event.fromTime)} -> ${formatTime(event.toTime)}` +
        (event.paused ? ' and paused' : ''),
    );
    if (!this.settings.toast.enabled) return;
    const label = describe(categories) + (detected ? ' (detected)' : '');
    const message = event.paused
      ? `Skipped ${label} and paused`
      : `Skipped ${label} (${formatTime(event.toTime - event.fromTime)})`;
    const controller = this.controller;
    this.toast.show(this.adapter.overlayHost(), message, controller ? () => void this.undo(event) : null);
  }
}

/** "sponsor", or "sponsor and self-promotion" for a run of more than one category. */
function describe(categories: Category[]): string {
  const unique = [...new Set(categories)].map((c) => CATEGORY_LABELS[c].toLowerCase());
  return unique.length <= 1 ? (unique[0] ?? 'segment') : `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}

function describeChannel(channel: ChannelRef | null): string {
  return channel?.name ?? channel?.handle ?? channel?.id ?? 'unknown';
}

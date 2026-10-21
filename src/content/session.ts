// One Session per media item the user opens. It waits briefly to learn the channel, skips nothing on
// a channel the user excluded, otherwise looks up segments, waits for the media element, and runs a
// SkipController on it until the user moves to other media.

import type { ChannelStore } from '../browser/channel-store';
import type { BrowserShell } from '../browser/shell';
import { isExcluded, needsHandle, type ChannelRef } from '../core/channels';
import { formatTime } from '../core/format';
import type { GetSegmentsRequest, GetSegmentsResponse } from '../core/messages';
import { planSkips } from '../core/policy';
import type { Settings } from '../core/settings';
import { SkipController, type SkipEvent } from '../core/skipper';
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

export class Session {
  private segments: Segment[] = [];
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
      return;
    }
    this.segments = response.segments;
    const plan = planSkips(this.segments, this.settings);
    log.info(
      `${this.media.id}: ${this.segments.length} segment(s) from ${response.sources.join(', ') || 'no source'}, ` +
        `${plan.length} to skip with current settings`,
    );
    if (this.segments.length === 0) return;

    this.attach();
    this.poll = setInterval(() => this.attach(), ELEMENT_POLL_MS);
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
    const categories = event.run.windows.map((w) => w.segment.category);
    log.info(
      `skipped ${categories.join(' + ')} ${formatTime(event.fromTime)} -> ${formatTime(event.toTime)}` +
        (event.paused ? ' and paused' : ''),
    );
    if (!this.settings.toast.enabled) return;
    const label = describe(categories);
    const message = event.paused
      ? `Skipped ${label} and paused`
      : `Skipped ${label} (${formatTime(event.toTime - event.fromTime)})`;
    const controller = this.controller;
    this.toast.show(this.adapter.overlayHost(), message, controller ? () => controller.undo(event) : null);
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

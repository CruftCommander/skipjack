// One Session per media item the user opens. It looks up segments, waits for the media element, and
// runs a SkipController on it until the user moves to other media.

import type { BrowserShell } from '../browser/shell';
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

export class Session {
  private segments: Segment[] = [];
  private controller: SkipController | null = null;
  private element: HTMLMediaElement | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Segments the user undid. Kept here so a replaced media element does not forget them. */
  private readonly undone = new Set<string>();
  private destroyed = false;

  constructor(
    private readonly media: MediaRef,
    private readonly adapter: PlatformAdapter,
    private readonly shell: BrowserShell,
    private settings: Settings,
    private readonly toast: Toast,
  ) {
    void this.start();
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.controller?.update(planSkips(this.segments, settings), settings);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.retry) clearTimeout(this.retry);
    this.controller?.destroy();
    this.controller = null;
    this.toast.hide();
  }

  private async start(attempt = 0): Promise<void> {
    if (this.destroyed || !this.shell.isAlive()) return;
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
      if (delay) this.retry = setTimeout(() => void this.start(attempt + 1), delay);
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
      canAct: () => this.shell.isAlive() && this.adapter.canSkipNow(mediaId),
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

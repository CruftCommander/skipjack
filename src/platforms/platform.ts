// Plug-in point 1 of 4: platform adapters.
// Everything specific to one media site lives behind this interface. Adding a site means adding one adapter.

import type { ChannelRef } from '../core/channels';
import type { DetectionInput } from '../llm/provider';

export type TranscriptResult =
  | { ok: true; input: DetectionInput }
  /** `retry` is true when trying again later, for example once the video plays, might work. */
  | { ok: false; reason: string; retry: boolean };

export interface PlatformCapabilities {
  /** A community segment database (SponsorBlock) covers this platform. */
  communitySegments: boolean;
  /** A transcript can be read. Used by detection in step 3. */
  transcript: boolean;
}

export interface PlatformAdapter {
  /** Stable ID used in MediaRef.platform and segment keys, for example `youtube`. */
  readonly id: string;
  readonly capabilities: PlatformCapabilities;

  /** True when this adapter handles the page at `url`. */
  matches(url: URL): boolean;

  /** The media ID for `url`, or null when the page plays no supported media. */
  mediaIdFromUrl(url: URL): string | null;

  /**
   * Calls `onChange` with the current media ID now and whenever it changes, including in-site
   * navigation that does not reload the page. Returns a function that stops watching.
   */
  watchMedia(onChange: (mediaId: string | null) => void): () => void;

  /** The element playing the main media, or null if it is not in the page yet. */
  findMediaElement(): HTMLMediaElement | null;

  /**
   * False while a skip must not happen: the platform is playing its own ad in the same element,
   * or the player still holds a different media item than `mediaId`.
   */
  canSkipNow(mediaId: string): boolean;

  /** Where to mount overlays such as the toast, so they show in fullscreen. */
  overlayHost(): HTMLElement;

  /**
   * The channel that published `mediaId`, or null while it is not known yet (the player has not
   * loaded the media, or the page still shows the previous media after in-site navigation).
   */
  channelOf(mediaId: string): ChannelRef | null;

  /**
   * Reads the media's transcript and the signals detection uses. `allowToggle` permits switching
   * captions on for a moment, hidden, to make the platform load them. Absent on platforms without
   * transcripts.
   */
  readTranscript?(mediaId: string, options: { allowToggle: boolean }): Promise<TranscriptResult>;

  /** Stops any transcript read in progress, for example when the viewer moves to other media. */
  cancelTranscript?(): void;

  /**
   * The media's length in seconds from the platform's own data, not the media element, which may
   * be playing an ad. Infinity for live streams; null while not known.
   */
  lengthOf?(mediaId: string): number | null;
}

/**
 * Channel parsing and links, kept apart from PlatformAdapter because the settings page and popup
 * use them without a page to adapt.
 */
export interface ChannelSyntax {
  readonly platform: string;
  /** Reads a channel from what a user pastes: a channel URL, a handle, or an ID. */
  parseChannel(input: string): ChannelRef | null;
  /** A link to the channel's page. */
  channelUrl(channel: ChannelRef): string | null;
}

// Plug-in point 1 of 4: platform adapters.
// Everything specific to one media site lives behind this interface. Adding a site means adding one adapter.

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
}

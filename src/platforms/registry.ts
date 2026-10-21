import type { PlatformAdapter } from './platform';
import { createYouTubeAdapter } from './youtube';

/** Every platform adapter. Add new ones here. */
export function platformAdapters(): PlatformAdapter[] {
  return [createYouTubeAdapter()];
}

export function adapterFor(url: URL): PlatformAdapter | null {
  return platformAdapters().find((a) => a.matches(url)) ?? null;
}

// Content script entry point. Picks the platform adapter for this page, follows the media the user
// opens, and keeps each Session's settings current.

import { createWebExtShell } from '../browser/shell';
import { normalizeSettings, SETTINGS_KEY } from '../core/settings';
import { adapterFor } from '../platforms/registry';
import { Toast } from '../ui/toast';
import { log } from './log';
import { Session } from './session';

declare const SKIPJACK_VERSION: string;

interface UserAgentData {
  brands?: { brand: string; version: string }[];
}

function browserName(): string {
  const brands = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData?.brands ?? [];
  const named = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? brands[0];
  return named ? `${named.brand} ${named.version}` : navigator.userAgent;
}

async function main(): Promise<void> {
  const adapter = adapterFor(new URL(location.href));
  if (!adapter) return;

  const shell = createWebExtShell();
  let settings = normalizeSettings(await shell.getSynced(SETTINGS_KEY));
  const toast = new Toast();
  let session: Session | null = null;

  log.info(`${SKIPJACK_VERSION} on ${browserName()}, platform ${adapter.id}`);

  shell.onSyncedChanged(SETTINGS_KEY, (value) => {
    settings = normalizeSettings(value);
    session?.updateSettings(settings);
  });

  const stop = adapter.watchMedia((mediaId) => {
    session?.destroy();
    session = null;
    // After the extension is disabled or updated, this script is an orphan: stop following videos.
    if (!shell.isAlive()) {
      queueMicrotask(() => stop());
      toast.destroy();
      return;
    }
    if (mediaId) session = new Session({ platform: adapter.id, id: mediaId }, adapter, shell, settings, toast);
  });
}

main().catch((error: unknown) => log.warn(`failed to start: ${error instanceof Error ? error.message : String(error)}`));

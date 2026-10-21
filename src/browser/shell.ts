// Plug-in point 4 of 4: the browser shell.
// Storage, messaging, and extension UI calls go through this interface, so the rest of the code never
// touches a browser namespace. Chromium (Edge, Chrome) and Firefox share one implementation today,
// because both expose the WebExtensions API with promises in Manifest V3. A browser that differs gets
// its own implementation of BrowserShell.

export interface BrowserShell {
  getSynced(key: string): Promise<unknown>;
  setSynced(key: string, value: unknown): Promise<void>;
  /** Calls `listener` with the new value whenever `key` changes in synced storage. */
  onSyncedChanged(key: string, listener: (value: unknown) => void): void;
  /** Sends a message to the background script and resolves with its reply. */
  sendMessage<T>(message: unknown): Promise<T>;
  /**
   * Handles messages in the background script. Return a promise to reply, or undefined to ignore.
   * Messages from other extensions are dropped before `handler` runs.
   */
  onMessage(handler: (message: unknown) => Promise<unknown> | undefined): void;
  onActionClicked(listener: () => void): void;
  /**
   * False once the extension is disabled, reloaded, or updated. Chromium leaves content scripts
   * running in open tabs when that happens, with their extension APIs cut off.
   */
  isAlive(): boolean;
  openOptionsPage(): Promise<void>;
}

// Minimal typing of the WebExtensions namespace. Firefox exposes it as `browser`, Chromium as `chrome`.
type Api = typeof chrome;

function api(): Api {
  const g = globalThis as unknown as { browser?: Api; chrome?: Api };
  // Check `runtime` on each: in a Chromium isolated world, a page element with id="browser" can
  // appear as a global named `browser`.
  const found = g.browser?.runtime ? g.browser : g.chrome;
  if (!found?.runtime) throw new Error('Skipjack: no WebExtensions API in this context');
  return found;
}

export function createWebExtShell(): BrowserShell {
  const ext = api();
  return {
    async getSynced(key) {
      const items = await ext.storage.sync.get(key);
      return items[key];
    },
    async setSynced(key, value) {
      await ext.storage.sync.set({ [key]: value });
    },
    onSyncedChanged(key, listener) {
      ext.storage.onChanged.addListener((changes, area) => {
        const change = changes[key];
        if (area === 'sync' && change) listener(change.newValue);
      });
    },
    sendMessage<T>(message: unknown) {
      return ext.runtime.sendMessage(message) as Promise<T>;
    },
    onMessage(handler) {
      // sendResponse plus `return true` works in every Chromium and Firefox version we target;
      // returning a promise from the listener does not.
      ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender.id !== ext.runtime.id) return false;
        const reply = handler(message);
        if (!reply) return false;
        reply.then(sendResponse, (error: unknown) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        return true;
      });
    },
    onActionClicked(listener) {
      ext.action.onClicked.addListener(() => listener());
    },
    openOptionsPage() {
      return ext.runtime.openOptionsPage();
    },
    isAlive() {
      try {
        return Boolean(ext.runtime?.id);
      } catch {
        return false;
      }
    },
  };
}

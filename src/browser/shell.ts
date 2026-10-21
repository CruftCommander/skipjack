// Plug-in point 4 of 4: the browser shell.
// Storage, messaging, and extension UI calls go through this interface, so the rest of the code never
// touches a browser namespace. Chromium (Edge, Chrome) and Firefox share one implementation today,
// because both expose the WebExtensions API with promises in Manifest V3. A browser that differs gets
// its own implementation of BrowserShell.

export interface BrowserShell {
  getSynced(key: string): Promise<unknown>;
  setSynced(key: string, value: unknown): Promise<void>;
  /** Local storage stays on this computer and never syncs: API keys and caches live here. */
  getLocal(key: string): Promise<unknown>;
  getAllLocal(): Promise<Record<string, unknown>>;
  setLocalItems(items: Record<string, unknown>): Promise<void>;
  removeLocal(keys: string[]): Promise<void>;
  /** Calls `listener` with the changed keys whenever anything in local storage changes. */
  onLocalKeysChanged(listener: (keys: string[]) => void): void;
  /** Calls `listener` when the user presses one of the extension's keyboard shortcuts. */
  onCommand(listener: (command: string) => void): void;
  /** Every item in synced storage. */
  getAllSynced(): Promise<Record<string, unknown>>;
  setSyncedItems(items: Record<string, unknown>): Promise<void>;
  removeSynced(keys: string[]): Promise<void>;
  /** Calls `listener` with the new value whenever `key` changes in synced storage. */
  onSyncedChanged(key: string, listener: (value: unknown) => void): void;
  /** Calls `listener` with the changed keys whenever anything in synced storage changes. */
  onSyncedKeysChanged(listener: (keys: string[]) => void): void;
  /** Sends a message to the background script and resolves with its reply. */
  sendMessage<T>(message: unknown): Promise<T>;
  /**
   * Handles messages in the background script. Return a promise to reply, or undefined to ignore.
   * Messages from other extensions are dropped before `handler` runs.
   */
  onMessage(handler: (message: unknown) => Promise<unknown> | undefined): void;
  /** Sends a message to the content script in the active tab. Resolves null when none answers. */
  sendToActiveTab<T>(message: unknown): Promise<T | null>;
  /**
   * False once the extension is disabled, reloaded, or updated. Chromium leaves content scripts
   * running in open tabs when that happens, with their extension APIs cut off.
   */
  isAlive(): boolean;
  openOptionsPage(): Promise<void>;
  /**
   * Makes one cheap extension API call. Chromium stops an idle background service worker 30 seconds
   * after its last extension event or API call, and each call resets that timer.
   */
  keepAlive(): Promise<void>;
  /**
   * Hides local storage from content scripts, so only the extension's own pages and background
   * script can read the API key there. Resolves false where the browser can't do this (Firefox).
   */
  restrictLocalStorage(): Promise<boolean>;
  /**
   * Calls `listener` when the browser starts with the extension installed, and when the extension
   * is installed or updated. Registering it also makes the background script start at those times.
   */
  onStartup(listener: () => void): void;
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
    async getLocal(key) {
      return (await ext.storage.local.get(key))[key];
    },
    async getAllLocal() {
      return (await ext.storage.local.get(null)) as Record<string, unknown>;
    },
    async setLocalItems(items) {
      await ext.storage.local.set(items);
    },
    async removeLocal(keys) {
      await ext.storage.local.remove(keys);
    },
    onLocalKeysChanged(listener) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') listener(Object.keys(changes));
      });
    },
    onCommand(listener) {
      ext.commands?.onCommand.addListener((command) => listener(command));
    },
    async getAllSynced() {
      return (await ext.storage.sync.get(null)) as Record<string, unknown>;
    },
    async setSyncedItems(items) {
      await ext.storage.sync.set(items);
    },
    async removeSynced(keys) {
      await ext.storage.sync.remove(keys);
    },
    onSyncedKeysChanged(listener) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') listener(Object.keys(changes));
      });
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
    openOptionsPage() {
      return ext.runtime.openOptionsPage();
    },
    async sendToActiveTab<T>(message: unknown) {
      try {
        const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) return null;
        return ((await ext.tabs.sendMessage(tab.id, message)) as T | undefined) ?? null;
      } catch {
        // No content script in the tab: not a supported page, or it loaded before Skipjack did.
        return null;
      }
    },
    isAlive() {
      try {
        return Boolean(ext.runtime?.id);
      } catch {
        return false;
      }
    },
    async keepAlive() {
      await ext.runtime.getPlatformInfo();
    },
    async restrictLocalStorage() {
      // Chromium 102 and later. Local storage is open to content scripts by default; this limits it
      // to contexts that come from the extension itself.
      const local = ext.storage.local as { setAccessLevel?: (o: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void> };
      if (typeof local.setAccessLevel !== 'function') return false;
      await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      return true;
    },
    onStartup(listener) {
      ext.runtime.onStartup.addListener(() => listener());
      ext.runtime.onInstalled.addListener(() => listener());
    },
  };
}

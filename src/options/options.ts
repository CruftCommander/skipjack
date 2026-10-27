// Settings page. Every control's `name` is a dotted path into Settings; changes save immediately.

import { createWebExtShell } from '../browser/shell';
import { ChannelStore } from '../browser/channel-store';
import type { ChannelRef } from '../core/channels';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, type Settings } from '../core/settings';
import { channelUrl, parseChannel } from '../platforms/registry';
import {
  DETECTION_CACHE_PREFIX,
  DETECTION_STATUS_KEY,
  detectionCacheKeys,
  type ClearLogRequest,
  type ClearLogResponse,
  type DetectionStatus,
} from '../core/messages';
import { appendLog, formatLog, LOG_KEY, logFileName, readLog, type LogEntry } from '../core/logbook';
import { apiKeyStorageKey, llmProviders } from '../llm/registry';

declare const SKIPJACK_VERSION: string;

const shell = createWebExtShell();
const channels = new ChannelStore(shell);
const form = document.getElementById('settings') as HTMLFormElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const reset = document.getElementById('reset') as HTMLButtonElement;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  let o = obj;
  for (const k of keys) {
    if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[last] = value;
}

function controls(): (HTMLInputElement | HTMLSelectElement)[] {
  // Only named inputs are settings; the channel list and API key have their own storage keys.
  return Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]'));
}

function render(settings: Settings): void {
  for (const input of controls()) {
    const value = getPath(settings, input.name);
    if (input.type === 'checkbox') input.checked = value === true;
    else if (input.type === 'radio') input.checked = input.value === value;
    else if (input instanceof HTMLSelectElement) selectValue(input, String(value));
    else input.value = String(value);
  }
  syncDisabled(settings);
}

/**
 * Selects a value, adding it as an option first if the list lacks it. A model saved by a newer
 * version, or one a provider has since dropped, would otherwise show a blank list and be replaced by
 * the default on the next save without the user choosing that.
 */
function selectValue(select: HTMLSelectElement, value: string): void {
  if (!Array.from(select.options).some((o) => o.value === value)) {
    select.append(new Option(`${value} (not offered by this version)`, value));
  }
  select.value = value;
}

/** Greys out controls that have no effect under the current settings. */
function syncDisabled(settings: Settings): void {
  const off = !settings.enabled;
  for (const input of controls()) {
    // The diagnostic log still records while skipping is paused, so it stays available.
    if (input.name === 'enabled' || input.name === 'diagnostics.log') continue;
    input.disabled = off || (input.name === 'minLength.seconds' && !settings.minLength.enabled);
  }
}

function read(): Settings {
  const raw: Record<string, unknown> = {};
  for (const input of controls()) {
    if (input.type === 'checkbox') setPath(raw, input.name, input.checked);
    else if (input.type === 'radio') {
      if (input.checked) setPath(raw, input.name, input.value);
    } else if (input.tagName === 'SELECT') setPath(raw, input.name, input.value);
    else if (input.value.trim() !== '') setPath(raw, input.name, Number(input.value));
  }
  return normalizeSettings(raw);
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function flash(message: string): void {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ''), 2000);
}

/** Saving is debounced: holding a number spinner fires a change per step, and synced storage allows about 120 writes a minute. */
const SAVE_DELAY_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

async function save(): Promise<void> {
  const settings = read();
  syncDisabled(settings);
  try {
    await shell.setSynced(SETTINGS_KEY, settings);
    flash('Saved');
  } catch (error) {
    flash(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DELAY_MS);
}

form.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  // Unnamed inputs, like the channel box, are not settings.
  if (!target.name) return;
  // A number out of range is clamped when read; show the value that will be saved.
  if (target.type === 'number') render(read());
  else syncDisabled(read());
  scheduleSave();
});

reset.addEventListener('click', () => {
  render(normalizeSettings(DEFAULT_SETTINGS));
  clearTimeout(saveTimer);
  void save();
});

void shell.getSynced(SETTINGS_KEY).then((raw) => render(normalizeSettings(raw)));

// Channels the user excluded. Stored under their own key, apart from the settings.

const channelList = document.getElementById('channels') as HTMLUListElement;
const channelEmpty = document.getElementById('channels-empty') as HTMLParagraphElement;
const channelInput = document.getElementById('channel-input') as HTMLInputElement;
const channelAdd = document.getElementById('channel-add') as HTMLButtonElement;
const channelStatus = document.getElementById('channel-status') as HTMLParagraphElement;

function renderChannels(list: ChannelRef[]): void {
  channelList.replaceChildren(
    ...list.map((ch) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      const url = channelUrl(ch);
      const label = ch.name ?? ch.handle ?? ch.id ?? '';
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = label;
        who.append(a);
      } else {
        who.textContent = label;
      }
      const detail = ch.name ? (ch.handle ?? ch.id) : ch.handle && ch.id ? ch.id : undefined;
      if (detail) {
        const small = document.createElement('small');
        small.textContent = detail;
        who.append(small);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Skip segments on ${label} again`);
      remove.addEventListener('click', () => void changeChannels(() => channels.remove(ch), `Skipping on ${label} again.`));
      li.append(who, remove);
      return li;
    }),
  );
  channelEmpty.hidden = list.length > 0;
}

async function changeChannels(change: () => Promise<void>, done: string): Promise<boolean> {
  try {
    await change();
    renderChannels(await channels.list());
    channelStatus.textContent = done;
    return true;
  } catch (error) {
    channelStatus.textContent = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function addChannel(): void {
  const ch = parseChannel(channelInput.value);
  if (!ch) {
    channelStatus.textContent = "That isn't a channel URL, @handle, or channel ID.";
    return;
  }
  // Keep what was typed until the save succeeds.
  void changeChannels(() => channels.add(ch), `Not skipping on ${ch.handle ?? ch.id} any more.`).then((ok) => {
    if (ok) channelInput.value = '';
  });
}

channelAdd.addEventListener('click', addChannel);
channelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addChannel();
  }
});
channels.onChanged(renderChannels);
void channels.list().then(renderChannels);

// Detection: the model list, one API key per provider (local storage only), and the last detection result.

const modelSelect = document.getElementById('model') as HTMLSelectElement;
for (const provider of llmProviders) {
  const group = document.createElement('optgroup');
  group.label = provider.label;
  for (const m of provider.models) group.append(new Option(m.label, m.id));
  modelSelect.append(group);
}

const detectionLast = document.getElementById('detection-last') as HTMLParagraphElement;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One key row per provider: input, Save, Remove, and a status line. Element IDs end in the provider's ID. */
const keyRows = new Map<string, () => Promise<void>>();
const keysBox = document.getElementById('api-keys') as HTMLDivElement;
for (const provider of llmProviders) {
  const storageKey = apiKeyStorageKey(provider.id);
  const row = document.createElement('div');
  row.className = 'row add key';
  const input = document.createElement('input');
  input.type = 'password';
  input.id = `api-key-${provider.id}`;
  input.placeholder = `${provider.label} API key (${provider.keyPlaceholder})`;
  input.setAttribute('aria-label', `${provider.label} API key`);
  input.autocomplete = 'off';
  input.spellcheck = false;
  const save = document.createElement('button');
  save.type = 'button';
  save.id = `api-key-save-${provider.id}`;
  save.textContent = 'Save key';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.id = `api-key-remove-${provider.id}`;
  remove.textContent = 'Remove';
  remove.hidden = true;
  row.append(input, save, remove);
  const status = document.createElement('p');
  status.id = `api-key-status-${provider.id}`;
  status.className = 'hint';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  keysBox.append(row, status);

  const render = async (): Promise<void> => {
    const key = await shell.getLocal(storageKey);
    const set = typeof key === 'string' && key.length > 0;
    remove.hidden = !set;
    // Show only the last four characters, so the key is recognizable but not readable.
    status.textContent = set ? `${provider.label} key ending in ${key.slice(-4)} saved.` : `No ${provider.label} key saved. Its models are off until you add one.`;
  };
  keyRows.set(storageKey, render);

  save.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!provider.isKey(key)) {
      status.textContent = `That doesn't look like an ${provider.label} API key. Keys start with ${provider.keyPlaceholder.replace(/\.\.\.$/, '')}.`;
      return;
    }
    try {
      await shell.setLocalItems({ [storageKey]: key });
    } catch (error) {
      // Keep what was typed, so a retry needs no re-paste.
      status.textContent = `The key was not saved: ${errorText(error)}`;
      return;
    }
    input.value = '';
    await render().catch(() => undefined);
  });

  remove.addEventListener('click', async () => {
    try {
      await shell.removeLocal([storageKey]);
    } catch (error) {
      status.textContent = `The key was not removed: ${errorText(error)}`;
      return;
    }
    await render().catch(() => undefined);
  });
}

const cacheClear = document.getElementById('detection-clear') as HTMLButtonElement;
const cacheStatus = document.getElementById('detection-clear-status') as HTMLParagraphElement;

cacheClear.addEventListener('click', async () => {
  cacheClear.disabled = true;
  try {
    const keys = detectionCacheKeys(await shell.getAllLocal());
    if (keys.length > 0) await shell.removeLocal(keys);
    const videos = keys.filter((k) => k.startsWith(DETECTION_CACHE_PREFIX)).length;
    cacheStatus.textContent =
      videos === 0 ? 'The detection cache was already empty.' : `Cleared saved results for ${videos.toLocaleString()} video${videos === 1 ? '' : 's'}.`;
  } catch (error) {
    cacheStatus.textContent = `The detection cache was not cleared: ${errorText(error)}`;
  } finally {
    cacheClear.disabled = false;
  }
});

async function renderLastDetection(): Promise<void> {
  const st = (await shell.getLocal(DETECTION_STATUS_KEY)) as DetectionStatus | undefined;
  if (!st || typeof st.at !== 'number') {
    detectionLast.textContent = '';
    return;
  }
  const when = new Date(st.at).toLocaleString();
  const tokens = st.inputTokens ? ` (${st.inputTokens.toLocaleString()} input, ${(st.outputTokens ?? 0).toLocaleString()} output tokens)` : '';
  detectionLast.textContent = `Last detection, ${when}: ${st.ok ? '' : 'failed: '}${st.message}${tokens}`;
}

// Diagnostics: the log is written by the background script; this page shows its size, saves it as a
// text file, and asks the background to clear it.

const logSummary = document.getElementById('log-summary') as HTMLParagraphElement;
const logDownload = document.getElementById('log-download') as HTMLButtonElement;
const logClear = document.getElementById('log-clear') as HTMLButtonElement;
const logStatus = document.getElementById('log-status') as HTMLParagraphElement;

/** The saved log, without lines that aged out since it was last written. */
async function savedLog(): Promise<LogEntry[]> {
  return appendLog(readLog(await shell.getLocal(LOG_KEY)), [], Date.now());
}

async function renderLogSummary(): Promise<void> {
  const entries = await savedLog();
  const first = entries[0];
  const last = entries[entries.length - 1];
  logSummary.textContent =
    first && last
      ? `${entries.length.toLocaleString()} line${entries.length === 1 ? '' : 's'} saved, from ${new Date(first.at).toLocaleString()} to ${new Date(last.at).toLocaleString()}.`
      : 'No log saved.';
}

logDownload.addEventListener('click', async () => {
  try {
    const entries = await savedLog();
    if (entries.length === 0) {
      logStatus.textContent = 'The log is empty. Turn on the log, then watch a video.';
      return;
    }
    const now = new Date();
    const text = formatLog(entries, [
      `Skipjack ${SKIPJACK_VERSION} diagnostic log`,
      `Browser: ${navigator.userAgent}`,
      `Saved: ${now.toISOString()}`,
      `${entries.length} lines. Times are UTC.`,
    ]);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = logFileName(now);
    document.body.append(link);
    link.click();
    link.remove();
    // Revoked later, not at once: the browser may still be reading the file.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    logStatus.textContent = `Saving ${entries.length.toLocaleString()} lines as ${link.download} in your downloads folder.`;
  } catch (error) {
    logStatus.textContent = `The log was not saved: ${errorText(error)}`;
  }
});

logClear.addEventListener('click', async () => {
  logClear.disabled = true;
  try {
    const reply = await shell.sendMessage<ClearLogResponse | undefined>({ type: 'clearLog' } satisfies ClearLogRequest);
    if (!reply?.ok) throw new Error(reply?.error ?? 'no answer from the background script');
    logStatus.textContent =
      reply.removed === 0 ? 'The log was already empty.' : `Cleared ${reply.removed.toLocaleString()} line${reply.removed === 1 ? '' : 's'}.`;
  } catch (error) {
    logStatus.textContent = `The log was not cleared: ${errorText(error)}`;
  } finally {
    logClear.disabled = false;
    void renderLogSummary();
  }
});

shell.onLocalKeysChanged((keys) => {
  if (keys.includes(LOG_KEY)) void renderLogSummary();
  if (keys.includes(DETECTION_STATUS_KEY)) void renderLastDetection();
  for (const key of keys) void keyRows.get(key)?.();
});
for (const render of keyRows.values()) void render();
void renderLastDetection();
void renderLogSummary();

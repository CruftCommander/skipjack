// Settings page. Every control's `name` is a dotted path into Settings; changes save immediately.

import { createWebExtShell } from '../browser/shell';
import { ChannelStore } from '../browser/channel-store';
import type { ChannelRef } from '../core/channels';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, type Settings } from '../core/settings';
import { channelUrl, parseChannel } from '../platforms/registry';
import { DETECTION_STATUS_KEY, type DetectionStatus } from '../background/detection';
import { apiKeyStorageKey, llmProviders } from '../llm/registry';

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
    if (input.name === 'enabled') continue;
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

// Detection: the model list, the API key (local storage only), and the last detection result.

const modelSelect = document.getElementById('model') as HTMLSelectElement;
for (const provider of llmProviders) {
  for (const m of provider.models) modelSelect.append(new Option(m.label, m.id));
}

const keyProvider = llmProviders[0];
const keyInput = document.getElementById('api-key') as HTMLInputElement;
const keySave = document.getElementById('api-key-save') as HTMLButtonElement;
const keyRemove = document.getElementById('api-key-remove') as HTMLButtonElement;
const keyStatus = document.getElementById('api-key-status') as HTMLParagraphElement;
const detectionLast = document.getElementById('detection-last') as HTMLParagraphElement;

async function renderKey(): Promise<void> {
  if (!keyProvider) return;
  const key = await shell.getLocal(apiKeyStorageKey(keyProvider.id));
  const set = typeof key === 'string' && key.length > 0;
  keyRemove.hidden = !set;
  // Show only the last four characters, so the key is recognizable but not readable.
  keyStatus.textContent = set ? `A key ending in ${key.slice(-4)} is saved.` : 'No key saved. Detection is off until you add one.';
}

keySave.addEventListener('click', async () => {
  if (!keyProvider) return;
  const key = keyInput.value.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    keyStatus.textContent = "That doesn't look like an Anthropic API key. Keys start with sk-ant-.";
    return;
  }
  await shell.setLocalItems({ [apiKeyStorageKey(keyProvider.id)]: key });
  keyInput.value = '';
  await renderKey();
});

keyRemove.addEventListener('click', async () => {
  if (!keyProvider) return;
  await shell.removeLocal([apiKeyStorageKey(keyProvider.id)]);
  await renderKey();
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

shell.onLocalKeysChanged((keys) => {
  if (keys.includes(DETECTION_STATUS_KEY)) void renderLastDetection();
  if (keyProvider && keys.includes(apiKeyStorageKey(keyProvider.id))) void renderKey();
});
void renderKey();
void renderLastDetection();

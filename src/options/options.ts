// Settings page. Every control's `name` is a dotted path into Settings; changes save immediately.

import { createWebExtShell } from '../browser/shell';
import { ChannelStore } from '../browser/channel-store';
import type { ChannelRef } from '../core/channels';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, type Settings } from '../core/settings';
import { channelUrl, parseChannel } from '../platforms/registry';

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

function controls(): HTMLInputElement[] {
  // Only named inputs are settings; the channel list has its own storage key.
  return Array.from(form.querySelectorAll<HTMLInputElement>('input[name]'));
}

function render(settings: Settings): void {
  for (const input of controls()) {
    const value = getPath(settings, input.name);
    if (input.type === 'checkbox') input.checked = value === true;
    else if (input.type === 'radio') input.checked = input.value === value;
    else input.value = String(value);
  }
  syncDisabled(settings);
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
    } else if (input.value.trim() !== '') setPath(raw, input.name, Number(input.value));
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

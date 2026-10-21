// Settings page. Every control's `name` is a dotted path into Settings; changes save immediately.

import { createWebExtShell } from '../browser/shell';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, type Settings } from '../core/settings';

const shell = createWebExtShell();
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

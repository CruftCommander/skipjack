// Toolbar popup: turns skipping on or off for the open video's channel, and opens settings.

import { createWebExtShell } from '../browser/shell';
import { ChannelStore } from '../browser/channel-store';
import { isExcluded } from '../core/channels';
import type { GetChannelResponse } from '../core/messages';
import { normalizeSettings, SETTINGS_KEY } from '../core/settings';

const shell = createWebExtShell();
const channels = new ChannelStore(shell);
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

el('settings').addEventListener('click', () => {
  void shell.openOptionsPage().then(() => window.close());
});

async function main(): Promise<void> {
  const settings = normalizeSettings(await shell.getSynced(SETTINGS_KEY));
  el('off').hidden = settings.enabled;

  const reply = await shell.sendToActiveTab<GetChannelResponse>({ type: 'getChannel' });
  const channel = reply?.ok ? reply.channel : null;
  if (!channel) {
    el('no-video').hidden = false;
    if (reply?.ok) el('no-video').textContent = "This video's channel isn't known yet. Try again once it starts playing.";
    return;
  }

  el('channel').hidden = false;
  el('channel-name').textContent = channel.name ?? channel.handle ?? channel.id ?? '';
  const box = el<HTMLInputElement>('channel-skip');
  const note = el('channel-note');
  box.checked = !isExcluded(channel, await channels.list());

  box.addEventListener('change', async () => {
    const skip = box.checked;
    try {
      if (skip) await channels.remove(channel);
      else await channels.add(channel);
      note.textContent = skip ? 'Skipping on this channel.' : 'Not skipping on this channel.';
    } catch (error) {
      box.checked = !skip;
      note.textContent = error instanceof Error ? error.message : String(error);
    }
  });
}

void main();

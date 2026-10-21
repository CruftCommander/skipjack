// Background script: answers segment lookups and detection requests from content scripts, and routes
// the undo shortcut to the active tab.
// Network requests to segment sources and LLM providers happen here, under the extension's host
// permissions, rather than in the content script, where the page's CORS rules would apply and where
// the page could see an API key.

import { createWebExtShell } from '../browser/shell';
import { isDetectionStatusRequest, isDetectRequest, isRequest } from '../core/messages';
import { apiKeyStorageKey, providerForModel } from '../llm/registry';
import { createSponsorBlockSource } from '../sources/sponsorblock';
import { DetectionService } from './detection';
import { SegmentService } from './segments';

const shell = createWebExtShell();
const segments = new SegmentService([createSponsorBlockSource()]);
const detection = new DetectionService(shell, providerForModel, async (provider) => {
  const key = await shell.getLocal(apiKeyStorageKey(provider.id));
  return typeof key === 'string' && key.trim() ? key.trim() : null;
});

shell.onMessage((message) => {
  if (isRequest(message)) return segments.get(message.media);
  if (isDetectionStatusRequest(message)) return detection.status(message.media, message.model);
  if (isDetectRequest(message)) return detection.detect(message.input, message.model);
  return undefined;
});

shell.onCommand((command) => {
  if (command === 'undo-skip') void shell.sendToActiveTab({ type: 'undoLastSkip' });
});

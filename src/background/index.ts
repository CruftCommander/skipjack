// Background script: answers segment lookups and detection requests from content scripts, stores the
// diagnostic log when it is on, and routes the undo shortcut to the active tab.
// Network requests to segment sources and LLM providers happen here, under the extension's host
// permissions, rather than in the content script, where the page's CORS rules would apply and where
// the page could see an API key.

import { createWebExtShell } from '../browser/shell';
import { isClearLogRequest, isDetectionStatusRequest, isDetectRequest, isLogRequest, isRequest } from '../core/messages';
import { apiKeyStorageKey, providerForModel } from '../llm/registry';
import { createSponsorBlockSource } from '../sources/sponsorblock';
import { DetectionService } from './detection';
import { DiagnosticLog } from './diagnostics';
import { SegmentService } from './segments';

const shell = createWebExtShell();
const diagnostics = new DiagnosticLog(shell);

// Hide local storage from content scripts. Without this, a compromised YouTube renderer running
// Skipjack's content script could read the API key or reset the hourly detection budget. Nothing in
// the content scripts uses local storage. Applied on every start of the background script, and the
// startup listener makes the script start with the browser, so the restriction is in place before
// a YouTube tab loads whether or not the browser keeps it between sessions.
const restrictLocalStorage = (): void =>
  void shell
    .restrictLocalStorage()
    .catch((error: unknown) => diagnostics.record('warn', `could not restrict local storage: ${error instanceof Error ? error.message : String(error)}`));
restrictLocalStorage();
shell.onStartup(restrictLocalStorage);
shell.onStartup(() => void diagnostics.prune().catch(() => undefined));

const segments = new SegmentService([createSponsorBlockSource()]);
const detection = new DetectionService(shell, providerForModel, async (provider) => {
  const key = await shell.getLocal(apiKeyStorageKey(provider.id));
  return typeof key === 'string' && key.trim() ? key.trim() : null;
});

shell.onMessage((message) => {
  if (isRequest(message)) return segments.get(message.media);
  if (isDetectionStatusRequest(message)) return detection.status(message.media, message.model);
  if (isDetectRequest(message)) return detection.detect(message.input, message.model);
  if (isLogRequest(message)) return diagnostics.append(message.entries);
  if (isClearLogRequest(message)) return diagnostics.clear();
  return undefined;
});

shell.onCommand((command) => {
  if (command === 'undo-skip') void shell.sendToActiveTab({ type: 'undoLastSkip' });
});

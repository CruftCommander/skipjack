// Background script: answers segment lookups for content scripts.
// Network requests to segment sources happen here, under the extension's host permissions, rather
// than in the content script, where the page's CORS rules would apply.

import { createWebExtShell } from '../browser/shell';
import { isRequest } from '../core/messages';
import { createSponsorBlockSource } from '../sources/sponsorblock';
import { SegmentService } from './segments';

const shell = createWebExtShell();
const service = new SegmentService([createSponsorBlockSource()]);

shell.onMessage((message) => {
  if (!isRequest(message)) return undefined;
  return service.get(message.media);
});

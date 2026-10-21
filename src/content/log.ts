// Console logging with a fixed prefix, so `[Skipjack]` filters the DevTools console to this extension.
const PREFIX = '[Skipjack]';

export const log = {
  info: (message: string): void => console.info(PREFIX, message),
  warn: (message: string): void => console.warn(PREFIX, message),
};

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiagnosticLog } from '../src/background/diagnostics';
import { log, LogForwarder, setLogSink } from '../src/content/log';
import {
  appendLog,
  formatLog,
  LOG_KEY,
  LOG_MAX_AGE_MS,
  LOG_MAX_BATCH,
  LOG_MAX_LINES,
  LOG_MAX_TEXT,
  logFileName,
  readLog,
  redact,
  type LogEntry,
} from '../src/core/logbook';
import { isClearLogRequest, isLogRequest } from '../src/core/messages';
import { normalizeSettings, SETTINGS_KEY } from '../src/core/settings';
import { FakeTimers, fakeShell } from './helpers';

const NOW = Date.UTC(2026, 9, 26, 20, 0, 0);
const line = (at: number, text = `line ${at}`, level: LogEntry['level'] = 'info'): LogEntry => ({ at, level, text });

test('the diagnostic log is off by default and read from storage like any setting', () => {
  assert.equal(normalizeSettings(undefined).diagnostics.log, false);
  assert.equal(normalizeSettings({ diagnostics: { log: true } }).diagnostics.log, true);
  assert.equal(normalizeSettings({ diagnostics: { log: 'yes' } }).diagnostics.log, false);
});

test('appendLog keeps the newest lines, drops old and far-future ones, and sorts by time', () => {
  const old = line(NOW - LOG_MAX_AGE_MS - 1);
  const future = line(NOW + 10 * 60_000);
  const out = appendLog([line(NOW - 10), old], [line(NOW - 20), future], NOW);
  assert.deepEqual(out.map((e) => e.at), [NOW - 20, NOW - 10]);

  const many = Array.from({ length: LOG_MAX_LINES + 50 }, (_, i) => line(NOW - LOG_MAX_LINES - 50 + i));
  const capped = appendLog([], many, NOW);
  assert.equal(capped.length, LOG_MAX_LINES);
  assert.equal(capped[0]?.at, many[50]?.at);
});

test('appendLog keeps the order of lines logged in the same millisecond', () => {
  const out = appendLog([], [line(NOW, 'first'), line(NOW, 'second'), line(NOW, 'third')], NOW);
  assert.deepEqual(out.map((e) => e.text), ['first', 'second', 'third']);
});

test('anything shaped like an API key is redacted before it is stored', () => {
  assert.equal(redact('failed: invalid key sk-ant-api03-AbCdEf_123456-xyz'), 'failed: invalid key sk-[redacted]');
  assert.equal(redact('sk-proj-ABCDEFGHIJKLMNOP and sk-short'), 'sk-[redacted] and sk-short');
  const [stored] = appendLog([], [line(NOW, 'echo sk-abcdefghijklmnopqrstuvwx')], NOW);
  assert.equal(stored?.text, 'echo sk-[redacted]');
});

test('readLog keeps only valid entries', () => {
  assert.deepEqual(readLog(undefined), []);
  assert.deepEqual(readLog('x'), []);
  const good = line(NOW);
  const bad = [null, {}, { at: NOW, level: 'debug', text: 'x' }, { at: Number.NaN, level: 'info', text: 'x' }, { at: NOW, level: 'info', text: '' }];
  assert.deepEqual(readLog([good, ...bad]), [good]);
});

test('a log message is accepted only with 1 to LOG_MAX_BATCH valid lines', () => {
  assert.equal(isLogRequest({ type: 'log', entries: [line(NOW)] }), true);
  assert.equal(isLogRequest({ type: 'log', entries: [] }), false);
  assert.equal(isLogRequest({ type: 'log', entries: Array.from({ length: LOG_MAX_BATCH + 1 }, () => line(NOW)) }), false);
  assert.equal(isLogRequest({ type: 'log', entries: [line(NOW, 'x'.repeat(LOG_MAX_TEXT + 1))] }), false);
  assert.equal(isLogRequest({ type: 'log', entries: [{ at: NOW, level: 'error', text: 'x' }] }), false);
  assert.equal(isLogRequest({ type: 'detect', entries: [line(NOW)] }), false);
  assert.equal(isClearLogRequest({ type: 'clearLog' }), true);
  assert.equal(isClearLogRequest({ type: 'log' }), false);
});

test('formatLog writes a header, then one UTC line per entry', () => {
  const text = formatLog([line(NOW, 'abc: 1 segment(s)'), line(NOW + 1500, 'lookup failed', 'warn')], ['Skipjack test', 'Times are UTC.']);
  assert.equal(
    text,
    '# Skipjack test\n# Times are UTC.\n\n2026-10-26T20:00:00.000Z INFO abc: 1 segment(s)\n2026-10-26T20:00:01.500Z WARN lookup failed\n',
  );
});

test('logFileName uses the local date and time', () => {
  assert.equal(logFileName(new Date(2026, 9, 6, 8, 5)), 'skipjack-log-2026-10-06-0805.txt');
});

function store(on: boolean) {
  const shell = fakeShell();
  shell.items[SETTINGS_KEY] = normalizeSettings({ diagnostics: { log: on } });
  return { shell, diag: new DiagnosticLog(shell, () => NOW) };
}

test('the background stores lines only while the setting is on', async () => {
  const off = store(false);
  assert.deepEqual(await off.diag.append([line(NOW)]), { ok: true, stored: false });
  assert.equal(LOG_KEY in off.shell.local, false);

  const on = store(true);
  assert.deepEqual(await on.diag.append([line(NOW, 'a')]), { ok: true, stored: true });
  assert.deepEqual(readLog(on.shell.local[LOG_KEY]).map((e) => e.text), ['a']);
});

test('appends from several tabs at once are all kept, and a clear is not undone by one in flight', async () => {
  const { shell, diag } = store(true);
  // Slow storage, so every append would read the same old log if they were not queued.
  const get = shell.getLocal;
  shell.getLocal = async (k) => {
    await new Promise((r) => setTimeout(r, 5));
    return get(k);
  };
  await Promise.all([diag.append([line(NOW - 3, 'a')]), diag.append([line(NOW - 2, 'b')]), diag.append([line(NOW - 1, 'c')])]);
  assert.deepEqual(readLog(shell.local[LOG_KEY]).map((e) => e.text), ['a', 'b', 'c']);

  const cleared = diag.clear();
  const late = diag.append([line(NOW, 'd')]);
  assert.deepEqual(await cleared, { ok: true, removed: 3 });
  await late;
  assert.deepEqual(readLog(shell.local[LOG_KEY]).map((e) => e.text), ['d']);
  assert.deepEqual(await diag.clear(), { ok: true, removed: 1 });
  assert.deepEqual(await diag.clear(), { ok: true, removed: 0 });
});

test('prune drops lines that aged out, and the key when nothing is left', async () => {
  const { shell, diag } = store(false);
  shell.local[LOG_KEY] = [line(NOW - LOG_MAX_AGE_MS - 5), line(NOW - 5, 'kept')];
  await diag.prune();
  assert.deepEqual(readLog(shell.local[LOG_KEY]).map((e) => e.text), ['kept']);
  shell.local[LOG_KEY] = [line(NOW - LOG_MAX_AGE_MS - 5)];
  await diag.prune();
  assert.equal(LOG_KEY in shell.local, false);
});

test('the content log hands lines to the sink, cut to length, and survives a failing sink', () => {
  const got: LogEntry[] = [];
  setLogSink((e) => got.push(e));
  try {
    log.info('hello');
    log.warn('x'.repeat(LOG_MAX_TEXT + 50));
    assert.deepEqual(got.map((e) => e.level), ['info', 'warn']);
    assert.equal(got[0]?.text, 'hello');
    assert.equal(got[1]?.text.length, LOG_MAX_TEXT);
    setLogSink(() => {
      throw new Error('boom');
    });
    assert.doesNotThrow(() => log.info('still fine'));
    setLogSink(null);
    log.info('not recorded');
    assert.equal(got.length, 2);
  } finally {
    setLogSink(null);
  }
});

test('the forwarder batches lines, sends them after its delay, and splits big batches', async () => {
  const timers = new FakeTimers();
  const sent: LogEntry[][] = [];
  const f = new LogForwarder(async (entries) => void sent.push(entries), 1000, timers);
  f.push(line(NOW, 'a'));
  f.push(line(NOW, 'b'));
  assert.equal(timers.only(), 1000);
  assert.equal(sent.length, 0);
  timers.fire();
  assert.deepEqual(sent.map((b) => b.map((e) => e.text)), [['a', 'b']]);

  for (let i = 0; i < LOG_MAX_BATCH + 5; i++) f.push(line(NOW + i));
  f.flush();
  assert.deepEqual(sent.slice(1).map((b) => b.length), [LOG_MAX_BATCH, 5]);
  assert.equal(timers.pending.size, 0);

  // A send that fails is dropped quietly.
  const failing = new LogForwarder(async () => Promise.reject(new Error('gone')), 1000, timers);
  failing.push(line(NOW));
  assert.doesNotThrow(() => failing.flush());
  const throwing = new LogForwarder(() => {
    throw new Error('Extension context invalidated.');
  }, 1000, timers);
  throwing.push(line(NOW));
  assert.doesNotThrow(() => timers.fire());
});

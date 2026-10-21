import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSkips } from '../src/core/policy';
import { SkipController, type SkipEvent } from '../src/core/skipper';
import { FakeMedia, FakeTimers, seg, settings } from './helpers';

function setup(segments = [seg('sponsor', 10, 40)], s = settings()) {
  const media = new FakeMedia();
  const timers = new FakeTimers();
  const events: SkipEvent[] = [];
  let canAct = true;
  const undone = new Set<string>();
  const controller = new SkipController({
    media,
    plan: planSkips(segments, s),
    settings: s,
    undone,
    canAct: () => canAct,
    onSkip: (e) => events.push(e),
    timers,
  });
  controller.start();
  return { media, timers, events, controller, undone, block: (v: boolean) => (canAct = !v) };
}

test('skips when playback enters a window', () => {
  const { media, events } = setup();
  media.playTo(5);
  assert.equal(events.length, 0);
  media.playTo(10.1);
  assert.deepEqual(media.seeks, [40]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.fromTime, 10.1);
  assert.equal(events[0]?.toTime, 40);
});

test('schedules a check for the next window, scaled by playback rate', () => {
  const { media, timers } = setup();
  media.playTo(0);
  assert.equal(timers.only(), 10_000 - 30);
  media.playbackRate = 2;
  media.emit('ratechange');
  assert.equal(timers.only(), 5_000 - 30);
});

test('the scheduled check fires the skip without waiting for timeupdate', () => {
  const { media, timers, events } = setup();
  media.playTo(9);
  media.currentTimeValue = 10.01; // playback advanced; no timeupdate yet
  timers.fire();
  assert.equal(events.length, 1);
  assert.deepEqual(media.seeks, [40]);
});

test('does nothing while paused or while the platform blocks skipping', () => {
  const { media, events, timers, block } = setup();
  media.paused = true;
  media.playTo(20);
  assert.equal(events.length, 0);
  assert.equal(timers.only(), undefined);

  media.paused = false;
  block(true); // for example, a YouTube ad is playing
  media.playTo(21);
  assert.equal(events.length, 0);

  block(false);
  media.emit('timeupdate');
  assert.equal(events.length, 1);
});

test('undo goes back to the window start and does not skip that segment again', () => {
  const { media, events, controller } = setup();
  media.playTo(12);
  const event = events[0];
  assert.ok(event);
  assert.equal(event.run.from, 10);
  controller.undo(event);
  assert.equal(media.currentTime, 10);
  media.playTo(15);
  assert.equal(events.length, 1);
});

test('overlapping windows are skipped with one seek and undone as one', () => {
  const { media, events, controller } = setup([seg('sponsor', 10, 40), seg('selfpromo', 38, 60)]);
  media.playTo(11);
  media.emit('seeked');
  assert.deepEqual(media.seeks, [60]);
  assert.equal(events.length, 1);
  controller.undo(events[0]!);
  assert.equal(media.currentTime, 10);
  media.emit('seeked');
  media.playTo(20);
  media.playTo(45);
  assert.equal(events.length, 1);
});

test('nothing happens before start(), and a skip during start() can be undone', () => {
  const media = new FakeMedia();
  media.currentTimeValue = 12; // already inside a sponsor when the controller attaches
  const events: SkipEvent[] = [];
  let controller: SkipController | null = null;
  controller = new SkipController({
    media,
    plan: planSkips([seg('sponsor', 10, 40)], settings()),
    settings: settings(),
    undone: new Set(),
    canAct: () => true,
    onSkip: (e) => {
      events.push(e);
      assert.ok(controller, 'controller is assigned before the first skip');
    },
    timers: new FakeTimers(),
  });
  media.emit('timeupdate');
  assert.equal(events.length, 0);
  controller.start();
  assert.equal(events.length, 1);
  controller.undo(events[0]!);
  assert.equal(media.currentTime, 10);
});

test('undo during an ad waits until the ad is over', () => {
  const { media, events, controller, block } = setup();
  media.playTo(12);
  block(true);
  controller.undo(events[0]!);
  assert.deepEqual(media.seeks, [40]);
  block(false);
  media.emit('timeupdate');
  assert.deepEqual(media.seeks, [40, 10]);
  media.playTo(15);
  assert.equal(events.length, 1);
});

test('the undo set is shared, so a new controller for the same media remembers it', () => {
  const first = setup();
  first.media.playTo(12);
  first.controller.undo(first.events[0]!);
  first.controller.destroy();
  const media = new FakeMedia();
  const events: SkipEvent[] = [];
  new SkipController({
    media,
    plan: planSkips([seg('sponsor', 10, 40)], settings()),
    settings: settings(),
    undone: first.undone,
    canAct: () => true,
    onSkip: (e) => events.push(e),
    timers: new FakeTimers(),
  }).start();
  media.playTo(15);
  assert.equal(events.length, 0);
});

test('skip and pause near the end pauses once; pressing play continues', () => {
  const { media, events } = setup([seg('sponsor', 580, 600)]);
  media.playTo(585);
  assert.equal(media.pauses, 1);
  assert.equal(media.paused, true);
  assert.equal(events[0]?.paused, true);
  media.paused = false;
  media.emit('play');
  media.playTo(599.8);
  assert.equal(media.pauses, 1);
});

test('after skip and pause, rewinding before the sponsor re-arms it', () => {
  const { media, events } = setup([seg('sponsor', 580, 600)]);
  media.playTo(585);
  assert.equal(events.length, 1);
  media.paused = false;
  media.currentTime = 500;
  media.emit('seeked');
  media.playTo(581);
  assert.equal(events.length, 2);
  assert.equal(media.pauses, 2);
});

test('update applies new settings', () => {
  const { media, events, controller } = setup([seg('interaction', 10, 40)]);
  const off = settings({ categories: { interaction: false } });
  controller.update(planSkips([seg('interaction', 10, 40)], off), off);
  media.playTo(15);
  assert.equal(events.length, 0);
});

test('update keeps undo state', () => {
  const { media, events, controller } = setup([seg('sponsor', 10, 40)]);
  media.playTo(12);
  controller.undo(events[0]!);
  controller.update(planSkips([seg('sponsor', 10, 40)], settings()), settings());
  media.playTo(15);
  assert.equal(events.length, 1);
});

test('destroy removes every listener and timer', () => {
  const { media, timers, controller } = setup();
  media.playTo(0);
  controller.destroy();
  assert.equal(media.listenerCount(), 0);
  assert.equal(timers.pending.size, 0);
});

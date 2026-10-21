import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime } from '../src/core/format';
import { youtubeMediaIdFromUrl } from '../src/platforms/youtube';

const id = (u: string) => youtubeMediaIdFromUrl(new URL(u));

test('watch and live pages yield the video ID', () => {
  assert.equal(id('https://www.youtube.com/watch?v=wIe3eDfGKUo'), 'wIe3eDfGKUo');
  assert.equal(id('https://www.youtube.com/watch?v=lrbbhhaboy0&t=3227s&list=PL1'), 'lrbbhhaboy0');
  assert.equal(id('https://m.youtube.com/watch?v=4kYyd_hoqUw'), '4kYyd_hoqUw');
  assert.equal(id('https://www.youtube.com/live/5k_YlkT1bjc?feature=share'), '5k_YlkT1bjc');
});

test('other pages, Shorts, other hosts, and malformed IDs yield nothing', () => {
  assert.equal(id('https://www.youtube.com/'), null);
  assert.equal(id('https://www.youtube.com/results?search_query=x'), null);
  assert.equal(id('https://www.youtube.com/shorts/wIe3eDfGKUo'), null);
  assert.equal(id('https://www.youtube.com/watch?v=short'), null);
  assert.equal(id('https://www.youtube.com/watch?v=wIe3eDfGKUo%22'), null);
  assert.equal(id('https://music.youtube.com/watch?v=wIe3eDfGKUo'), null);
  assert.equal(id('https://example.com/watch?v=wIe3eDfGKUo'), null);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(88.4), '1:28');
  assert.equal(formatTime(3256), '54:16');
  assert.equal(formatTime(12339), '3:25:39');
  assert.equal(formatTime(Number.NaN), '0:00');
});

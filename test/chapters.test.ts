import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSponsorChapterTitle, MAX_SPONSOR_CHAPTER_SECONDS, sponsorChapterSegments } from '../src/core/chapters';
import { CHAPTER_SOURCE } from '../src/core/sources';
import { CHAPTERS_MESSAGE_SOURCE, toChapters, type ChaptersReply } from '../src/platforms/youtube';

const creator = (title: string, start: number) => ({ title, start, byCreator: true });

test('sponsor chapter titles: a sponsor or ad label, not a chapter that only mentions one', () => {
  for (const t of ['Sponsor', 'sponsor', 'Sponsor Pax Historia', 'Sponsored by Acme', 'Sponsorship', 'Sponsor: Acme', 'Ad', 'Ad break', 'Ad read', 'Advertisement', 'Advert', 'Paid promotion', '  Sponsor  ']) {
    assert.equal(isSponsorChapterTitle(t), true, t);
  }
  for (const t of ['Sponsors of the war', 'State Sponsored Hacking', 'Thanks to our sponsor', 'Ads in the 1990s', 'Adam', 'Promotion to captain', 'Promo', 'Intro', '']) {
    assert.equal(isSponsorChapterTitle(t), false, t);
  }
});

test('a creator sponsor chapter becomes a sponsor segment up to the next chapter', () => {
  // 4kYyd_hoqUw: the creator's "Sponsor" chapter runs from 7:00 to the next chapter at 8:40.
  const chapters = [creator('Intro', 0), creator('Things In The Woods', 120), creator('Sponsor', 420), creator('The Cabin', 520)];
  assert.deepEqual(sponsorChapterSegments(chapters, 1500), [
    { id: `${CHAPTER_SOURCE}:420`, category: 'sponsor', start: 420, end: 520, source: CHAPTER_SOURCE },
  ]);
});

test('a last sponsor chapter runs to the end, and needs the length to do so', () => {
  // wvA53F5l6vw: "Sponsor Pax Historia" from 10:38 to the end of the video.
  const chapters = [creator('Intro', 0), creator('Sponsor Pax Historia', 638)];
  assert.deepEqual(sponsorChapterSegments(chapters, 700).map((s) => [s.start, s.end]), [[638, 700]]);
  assert.deepEqual(sponsorChapterSegments(chapters, Number.NaN), []);
  assert.deepEqual(sponsorChapterSegments(chapters, Number.POSITIVE_INFINITY), []);
});

test('YouTube auto-chapters, over-long chapters, and chapters past the end are left alone', () => {
  // LtXUoaZcp70: YouTube generated a "Sponsor break" chapter; it confirms detection but skips nothing alone.
  assert.deepEqual(sponsorChapterSegments([{ title: 'Sponsor break', start: 242, byCreator: false }, creator('Next', 298)], 1200), []);
  const long = MAX_SPONSOR_CHAPTER_SECONDS + 1;
  assert.deepEqual(sponsorChapterSegments([creator('Sponsor', 100), creator('Rest', 100 + long)], 5000), []);
  assert.deepEqual(sponsorChapterSegments([creator('Sponsor', 100), creator('Rest', 100 + MAX_SPONSOR_CHAPTER_SECONDS)], 5000).length, 1);
  assert.deepEqual(sponsorChapterSegments([creator('Sponsor', 800)], 700), []);
  // The end is clamped to the media length.
  assert.deepEqual(sponsorChapterSegments([creator('Sponsor', 600), creator('Later', 900)], 650).map((s) => s.end), [650]);
});

test('toChapters keeps well-formed chapters for this video only', () => {
  const reply = (chapters: unknown[], videoId = 'abcdefghijk'): ChaptersReply =>
    ({ source: CHAPTERS_MESSAGE_SOURCE, nonce: 'n', ok: true, videoId, chapters }) as ChaptersReply;
  assert.deepEqual(toChapters(reply([{ title: 'Sponsor', start: 420, byCreator: true }, { title: 'X', start: -1, byCreator: true }, { title: 'Y', start: 'z' }]), 'abcdefghijk'), [
    { title: 'Sponsor', start: 420, byCreator: true },
  ]);
  // Anything but a literal true is not the creator's.
  assert.equal(toChapters(reply([{ title: 'Sponsor', start: 1, byCreator: 'yes' }]), 'abcdefghijk')?.[0]?.byCreator, false);
  assert.equal(toChapters(reply([], 'otherVideo1'), 'abcdefghijk'), null);
  assert.equal(toChapters({ source: CHAPTERS_MESSAGE_SOURCE, nonce: 'n', ok: false, videoId: 'abcdefghijk' }, 'abcdefghijk'), null);
});

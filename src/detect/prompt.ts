// The detection prompt, shared by every LLM provider.
//
// The model never does timestamp arithmetic. It reports segments as transcript line numbers plus
// the exact first and last words, and code turns those into times (see postprocess.ts). The first
// eval showed models confusing "when the last pitch line starts" with "when content resumes"; line
// numbers remove that whole class of error.

import { formatTime } from '../core/format';
import type { DetectionInput } from '../llm/provider';

export const TOOL_NAME = 'report_segments';

/** One numbered transcript line as shown to the model. Times are in seconds. */
export interface Line {
  start: number;
  /** When the next line starts, or the end of this cue for the last line. */
  next: number;
  text: string;
}

export const SYSTEM_PROMPT = `You find the parts of a video that a viewer wants skipped, using its transcript. You report them by calling the ${TOOL_NAME} tool, and you always call it, even when there is nothing to report.

Categories:
- sponsor: paid promotion of a third party that the creator reads inside the video. Typical cues: "this video is sponsored by", "a word from our sponsor", "thanks to X for sponsoring", "brought to you by", promo codes, "link in the description" for a partner's product, affiliate offers. Include the lead-in and the hand-back.
- selfpromo: unpaid promotion of the creator's own things: merch, Patreon, channel memberships, their courses or newsletter, their other channels, a plug for another of their own videos, "the best way to support the channel", and thanks to named paying members or patrons.
- interaction: requests to like, subscribe, comment, share, or turn on notifications.

Not a segment: the video's actual topic, even when the topic is a product; a creator explaining why they made the video; a plain "thanks for watching" with no pitch; intros and outros that contain no pitch; credits.

How to report a segment:
- The transcript is numbered. Each line reads "L<number> [<seconds>] <text>".
- first_line is the line where the pitch begins, including its transition ("But first...", "right after a word from our sponsor", "Producing videos like this takes a lot of time..."). first_words are the first words of the pitch, copied exactly from that line. If the pitch begins mid-line, copy the words where it begins, not the start of the line.
- last_line is the line where the pitch ends, including the hand-back ("Now, back to the video.", "Let's get back to it."). last_words are the last words of the pitch, copied exactly from that line.
- When unsure, choose the wider option. Skipping a moment of content is better than showing a moment of the pitch.

Auto-caption quirks:
- Auto-generated captions often time the last word of a sentence several seconds late and put it at the start of a later line, after a pause or a "[Music]" line. For example "support our" on one line, then "[Music]", then "channel it's the summer of 1974" where "channel" belongs to the pitch and "it's the summer" is content. When that happens, end the segment on the line before the pause, and treat the stray word as part of that line.
- "[Music]", "[Applause]", ">>" speaker markers, and repeated words like "Heat. Heat." on music or gunfire are caption artifacts, not speech.

Signals:
- A chapter titled like "Sponsor", "Ad", or "Sponsor break" is strong evidence for a sponsor segment there.
- The paid-promotion flag means a sponsor read probably exists. Its absence means nothing; most creators never set it.
- Description promo lines suggest a sponsor but never prove one. Report only what is spoken in the transcript.

Report each segment separately. Do not merge segments of different categories, even when they are back to back. If there is nothing to skip, call the tool with an empty list.`;

export const TOOL = {
  name: TOOL_NAME,
  description: 'Report every sponsor, self-promotion, and interaction-reminder segment found in the transcript.',
  input_schema: {
    type: 'object',
    properties: {
      segments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['sponsor', 'selfpromo', 'interaction'] },
            first_line: { type: 'integer', description: 'Number of the line where the segment begins (the N in "LN").' },
            first_words: { type: 'string', description: 'The first words of the segment, copied exactly from first_line.' },
            last_line: { type: 'integer', description: 'Number of the line where the segment ends.' },
            last_words: { type: 'string', description: 'The last words of the segment, copied exactly from last_line.' },
            confidence: { type: 'number', description: 'From 0 to 1: how sure you are that this is a segment of this category.' },
          },
          required: ['category', 'first_line', 'first_words', 'last_line', 'last_words', 'confidence'],
        },
      },
    },
    required: ['segments'],
  },
} as const;

/** The numbered lines, with empty cues removed. */
export function transcriptLines(input: DetectionInput): Line[] {
  const cues = input.transcript
    .map((c) => ({ start: c.start, duration: c.duration, text: c.text.replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.text && Number.isFinite(c.start))
    .sort((a, b) => a.start - b.start);
  return cues.map((c, i) => {
    const following = cues[i + 1];
    let next = following ? following.start : c.start + Math.max(0, c.duration);
    if (Number.isFinite(input.durationSeconds) && input.durationSeconds > 0) next = Math.min(next, input.durationSeconds);
    return { start: c.start, next: Math.max(c.start, next), text: c.text };
  });
}

/** Formats the transcript and signals as the user message. */
export function buildUserMessage(input: DetectionInput, lines: Line[] = transcriptLines(input)): string {
  const out: string[] = [];
  if (input.title) out.push(`Title: ${input.title}`);
  out.push(`Duration: ${input.durationSeconds.toFixed(1)} seconds (${formatTime(input.durationSeconds)})`);

  const { chapters, paidPromotion, descriptionPromoLines } = input.signals;
  if (chapters && chapters.length > 0) {
    out.push('', 'Chapters:');
    for (const c of chapters) out.push(`- ${c.start.toFixed(1)}: ${c.title}`);
  }
  if (paidPromotion !== undefined) out.push('', `Paid-promotion flag: ${paidPromotion ? 'set' : 'not set'}`);
  if (descriptionPromoLines && descriptionPromoLines.length > 0) {
    out.push('', 'Description lines that look promotional:');
    for (const l of descriptionPromoLines) out.push(`- ${l}`);
  }

  out.push('', 'Transcript:');
  lines.forEach((l, i) => out.push(`L${i} [${l.start.toFixed(1)}] ${l.text}`));
  return out.join('\n');
}

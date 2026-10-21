// The detection prompt, shared by every LLM provider. Lessons from the step 1 dry runs are written in
// here: boundaries follow meaning rather than raw cue times, chapters and description timestamps are
// boundary signals, and auto-captions carry known noise.

import { formatTime } from '../core/format';
import type { DetectionInput } from '../llm/provider';

export const TOOL_NAME = 'report_segments';

export const SYSTEM_PROMPT = `You find the parts of a video that a viewer wants skipped, using its transcript. You report them with the ${TOOL_NAME} tool and nothing else.

Categories:
- sponsor: paid promotion of a third party that the creator reads inside the video. Typical cues: "this video is sponsored by", "thanks to X for sponsoring", "brought to you by", promo codes, "link in the description" for a partner's product, affiliate offers. Include the lead-in and the hand-back.
- selfpromo: unpaid promotion of the creator's own things: merch, Patreon, channel memberships, their courses or newsletter, their other channels, a plug for another of their own videos, and thanks to named paying members or patrons.
- interaction: requests to like, subscribe, comment, share, or turn on notifications.

Not a segment: the video's actual topic, even when the topic is a product; a creator explaining why they made the video; intros and outros that contain no pitch; credits.

Boundaries:
- start is the moment the pitch begins, including its transition ("But first...", "Before we continue...", "Producing videos like this takes a lot of time...").
- end is the moment the real content resumes. Include the hand-back ("Now, back to the video.", "Let's get back to it.").
- When unsure where a boundary falls, choose the wider option. Skipping a second of content is better than showing a second of the pitch.
- Each transcript line starts with the cue's start time in seconds. A cue's words are spoken between its start time and the next cue's start time. When a boundary falls inside a cue, estimate its time from the word's position in that span.
- Auto-generated captions often time the last word before a pause several seconds late and attach it to the next line. Place boundaries by meaning, not by where a word happens to sit.
- A segment can run to the very end of the video. If so, set end to the video's duration.

Signals:
- A chapter titled like "Sponsor", "Ad", or "Sponsor break" is strong evidence. When your boundary is within a few seconds of a chapter start, use the chapter start.
- The paid-promotion flag means a sponsor read probably exists. Its absence means nothing; most creators never set it.
- Description promo lines suggest a sponsor but never prove one. Report only what is spoken in the transcript.

Noise: "[Music]", "[Applause]", ">>" speaker markers, and repeated words like "Heat. Heat." on music or gunfire are caption artifacts, not speech.

Report each segment separately. Do not merge segments of different categories, even when they are back to back. If there is nothing to skip, report an empty list.`;

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
            start_seconds: { type: 'number', description: 'When the segment starts, in seconds from the start of the video.' },
            end_seconds: { type: 'number', description: 'When the real content resumes, in seconds.' },
            confidence: { type: 'number', description: 'From 0 to 1: how sure you are that this is a segment of this category.' },
            first_words: { type: 'string', description: 'The first few words of the segment, verbatim from the transcript.' },
            last_words: { type: 'string', description: 'The last few words of the segment, verbatim from the transcript.' },
          },
          required: ['category', 'start_seconds', 'end_seconds', 'confidence', 'first_words', 'last_words'],
        },
      },
    },
    required: ['segments'],
  },
} as const;

/** Formats the transcript and signals as the user message. */
export function buildUserMessage(input: DetectionInput): string {
  const lines: string[] = [];
  if (input.title) lines.push(`Title: ${input.title}`);
  lines.push(`Duration: ${input.durationSeconds.toFixed(1)} seconds (${formatTime(input.durationSeconds)})`);

  const { chapters, paidPromotion, descriptionPromoLines } = input.signals;
  if (chapters && chapters.length > 0) {
    lines.push('', 'Chapters:');
    for (const c of chapters) lines.push(`- ${c.start.toFixed(1)}: ${c.title}`);
  }
  if (paidPromotion !== undefined) lines.push('', `Paid-promotion flag: ${paidPromotion ? 'set' : 'not set'}`);
  if (descriptionPromoLines && descriptionPromoLines.length > 0) {
    lines.push('', 'Description lines that look promotional:');
    for (const l of descriptionPromoLines) lines.push(`- ${l}`);
  }

  lines.push('', 'Transcript:');
  for (const cue of input.transcript) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (text) lines.push(`[${cue.start.toFixed(1)}] ${text}`);
  }
  return lines.join('\n');
}

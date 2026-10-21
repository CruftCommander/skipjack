// Reads a step 1 probe report ("Download + transcript") into the DetectionInput the live extension
// will build in step 3, so the eval exercises the same prompt the extension sends.

import type { DetectionInput } from '../src/llm/provider';

interface ProbeReport {
  videoId?: string;
  title?: string;
  lengthSeconds?: number | string;
  chapters?: { items?: { title?: string; startMs?: number }[] };
  paidPromotion?: { flag?: boolean };
  description?: { promoLines?: string[] };
  transcript?: { cues?: [number, number, string][] };
}

export function reportToInput(raw: unknown): DetectionInput {
  const r = raw as ProbeReport;
  const id = r.videoId;
  const cues = r.transcript?.cues;
  if (!id || !Array.isArray(cues) || cues.length === 0) throw new Error('report has no video ID or no transcript cues');
  const input: DetectionInput = {
    media: { platform: 'youtube', id },
    durationSeconds: Number(r.lengthSeconds),
    transcript: cues.map(([startMs, durMs, text]) => ({ start: startMs / 1000, duration: durMs / 1000, text })),
    signals: {
      chapters: (r.chapters?.items ?? [])
        .filter((c) => typeof c.startMs === 'number')
        .map((c) => ({ title: c.title ?? '', start: (c.startMs as number) / 1000 })),
      descriptionPromoLines: r.description?.promoLines ?? [],
    },
  };
  if (r.title) input.title = r.title;
  if (typeof r.paidPromotion?.flag === 'boolean') input.signals.paidPromotion = r.paidPromotion.flag;
  return input;
}

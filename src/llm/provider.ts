// Plug-in point 3 of 4: LLM providers. Interface only in step 2; step 3 adds the Anthropic provider.
// The core hands a provider the transcript and signals and gets back labeled segments in one fixed
// format. Users bring their own provider and key. Adding a provider means adding one module.

import type { Category, MediaRef } from '../core/types';

/** One caption cue. Times are in seconds. */
export interface Cue {
  start: number;
  duration: number;
  text: string;
}

export interface DetectionInput {
  media: MediaRef;
  durationSeconds: number;
  transcript: Cue[];
  /** Optional hints from the platform adapter. Each one can confirm a detection but never replace it. */
  signals: {
    chapters?: { title: string; start: number }[];
    paidPromotion?: boolean;
    descriptionPromoLines?: string[];
  };
}

export interface DetectedSegment {
  category: Category;
  start: number;
  end: number;
  /** 0 to 1. */
  confidence: number;
}

export interface LlmProvider {
  /** Stable ID, for example `anthropic`. */
  readonly id: string;
  /** Name shown in settings. */
  readonly label: string;
  detect(input: DetectionInput, apiKey: string, signal?: AbortSignal): Promise<DetectedSegment[]>;
}

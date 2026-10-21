// Plug-in point 3 of 4: LLM providers.
// The core hands a provider the transcript and signals and gets back labeled segments in one fixed
// format. Users bring their own provider and key. Adding a provider means adding one module.

import type { Category, MediaRef } from '../core/types';

/** One caption cue. Times are in seconds. */
export interface Cue {
  start: number;
  duration: number;
  text: string;
}

export interface Chapter {
  title: string;
  /** Seconds. */
  start: number;
}

export interface DetectionInput {
  media: MediaRef;
  title?: string;
  durationSeconds: number;
  transcript: Cue[];
  /** Optional hints from the platform adapter. Each one can confirm a detection but never replace it. */
  signals: {
    chapters?: Chapter[];
    paidPromotion?: boolean;
    descriptionPromoLines?: string[];
  };
}

export interface DetectedSegment {
  category: Category;
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  /** 0 to 1. */
  confidence: number;
  /** The first and last words of the segment as spoken, for checking a detection by eye. */
  firstWords?: string;
  lastWords?: string;
}

export interface DetectionResult {
  segments: DetectedSegment[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DetectOptions {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** Stable ID, for example `anthropic`. */
  readonly id: string;
  /** Name shown in settings. */
  readonly label: string;
  /** Models offered in settings, cheapest first. */
  readonly models: readonly { id: string; label: string }[];
  detect(input: DetectionInput, options: DetectOptions): Promise<DetectionResult>;
}

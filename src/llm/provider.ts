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
  /**
   * Called whenever the provider receives something: the response headers, then each chunk of a
   * streamed body. The caller uses it to reset an idle timeout.
   */
  onActivity?: () => void;
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

/**
 * Detection failed after the provider accepted the request, so tokens were (or may have been) spent.
 * The caller remembers the failure for a while instead of paying again on the next visit.
 */
export class SpentError extends Error {}

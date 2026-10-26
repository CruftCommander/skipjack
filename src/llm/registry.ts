import { createAnthropicProvider } from './anthropic';
import { createOpenAiProvider } from './openai';
import type { LlmProvider } from './provider';

/** Every LLM provider. Add new ones here. Each needs a host permission in scripts/build.mjs. */
export const llmProviders: readonly LlmProvider[] = [createAnthropicProvider(), createOpenAiProvider()];

export function providerForModel(model: string): LlmProvider | null {
  return llmProviders.find((p) => p.models.some((m) => m.id === model)) ?? null;
}

/** Where a provider's API key is kept, in local storage only. */
export function apiKeyStorageKey(providerId: string): string {
  return `apiKey:${providerId}`;
}

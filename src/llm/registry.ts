import { createAnthropicProvider } from './anthropic';
import type { LlmProvider } from './provider';

/** Every LLM provider. Add new ones here. */
export const llmProviders: readonly LlmProvider[] = [createAnthropicProvider()];

export function providerForModel(model: string): LlmProvider | null {
  return llmProviders.find((p) => p.models.some((m) => m.id === model)) ?? null;
}

/** Where a provider's API key is kept, in local storage only. */
export function apiKeyStorageKey(providerId: string): string {
  return `apiKey:${providerId}`;
}

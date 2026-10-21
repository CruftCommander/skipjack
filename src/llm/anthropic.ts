// Anthropic provider. Calls the Messages API directly with the user's own key, which is the
// bring-your-own-key case Anthropic's direct-browser-access header exists for.
// Docs: https://platform.claude.com/docs/en/api/messages

import { buildUserMessage, SYSTEM_PROMPT, TOOL, TOOL_NAME } from '../detect/prompt';
import { parseToolInput, refine } from '../detect/postprocess';
import type { DetectionInput, DetectionResult, DetectOptions, LlmProvider } from './provider';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 4096;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function buildRequest(input: DetectionInput, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: buildUserMessage(input) }],
  };
}

export function createAnthropicProvider(fetchFn: FetchFn = (i, init) => fetch(i, init)): LlmProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ],
    async detect(input: DetectionInput, options: DetectOptions): Promise<DetectionResult> {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(buildRequest(input, options.model)),
      };
      if (options.signal) init.signal = options.signal;
      const response = await fetchFn(ANTHROPIC_URL, init);
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const message = (body?.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
        throw new Error(`Anthropic: ${message}`);
      }
      const content = Array.isArray(body?.content) ? (body.content as Record<string, unknown>[]) : [];
      const call = content.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME);
      if (!call) throw new Error(`Anthropic: no ${TOOL_NAME} call in the response (stop_reason ${String(body?.stop_reason)})`);
      const usage = (body?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      return {
        segments: refine(parseToolInput(call.input), input.durationSeconds, input.signals.chapters),
        model: typeof body?.model === 'string' ? body.model : options.model,
        usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
      };
    },
  };
}

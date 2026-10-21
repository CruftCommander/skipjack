// Anthropic provider. Calls the Messages API directly with the user's own key, which is the
// bring-your-own-key case Anthropic's direct-browser-access header exists for.
// Docs: https://platform.claude.com/docs/en/api/messages

import { buildUserMessage, SYSTEM_PROMPT, TOOL, TOOL_NAME, transcriptLines } from '../detect/prompt';
import { parseToolInput, refine, toTimed } from '../detect/postprocess';
import type { DetectionInput, DetectionResult, DetectOptions, LlmProvider } from './provider';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Room for the model's own reasoning on models that think before answering. */
const MAX_OUTPUT_TOKENS = 16000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type ToolChoice = { type: 'tool'; name: string } | { type: 'auto' };

const FORCED: ToolChoice = { type: 'tool', name: TOOL_NAME };
const AUTO: ToolChoice = { type: 'auto' };

export function buildRequest(input: DetectionInput, model: string, toolChoice: ToolChoice = FORCED): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: toolChoice,
    messages: [{ role: 'user', content: buildUserMessage(input) }],
  };
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createAnthropicProvider(fetchFn: FetchFn = (i, init) => fetch(i, init)): LlmProvider {
  // Some models refuse a forced tool call (for example ones that always think first). Remember
  // which, so each one costs at most one rejected request per session.
  const noForcedTool = new Set<string>();

  async function call(input: DetectionInput, options: DetectOptions, toolChoice: ToolChoice): Promise<Record<string, unknown>> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequest(input, options.model, toolChoice)),
    };
    if (options.signal) init.signal = options.signal;
    const response = await fetchFn(ANTHROPIC_URL, init);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = (body?.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
      throw new ApiError(`Anthropic: ${message}`, response.status);
    }
    return body ?? {};
  }

  return {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ],
    async detect(input: DetectionInput, options: DetectOptions): Promise<DetectionResult> {
      let body: Record<string, unknown>;
      if (noForcedTool.has(options.model)) {
        body = await call(input, options, AUTO);
      } else {
        try {
          body = await call(input, options, FORCED);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 400 && /tool_choice/i.test(error.message))) throw error;
          noForcedTool.add(options.model);
          body = await call(input, options, AUTO);
        }
      }

      const content = Array.isArray(body.content) ? (body.content as Record<string, unknown>[]) : [];
      const toolCall = content.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME);
      if (!toolCall) throw new Error(`Anthropic: no ${TOOL_NAME} call in the response (stop_reason ${String(body.stop_reason)})`);
      const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      const lines = transcriptLines(input);
      return {
        segments: refine(toTimed(parseToolInput(toolCall.input), lines), input.durationSeconds, input.signals.chapters),
        model: typeof body.model === 'string' ? body.model : options.model,
        usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
      };
    },
  };
}

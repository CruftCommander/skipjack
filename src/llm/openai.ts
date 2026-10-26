// OpenAI provider. Calls the Responses API directly with the user's own key. OpenAI's docs say to
// keep keys server-side rather than in browsers; here the key is the user's own, stays in the
// extension's local storage, and goes only to api.openai.com from the background script, which is
// the same bring-your-own-key arrangement as the Anthropic provider. OpenAI has no opt-in header for
// it, and api.openai.com serves CORS headers (with the odd outage). Extension requests under a host
// permission are not subject to CORS anyway.
// Docs: https://developers.openai.com/api/docs/guides/function-calling
//       https://developers.openai.com/api/docs/guides/latest-model (GPT-6)
//
// The Responses API is used because, on GPT-6, Chat Completions does not support tool calling (Luna
// and Sol allow it only with reasoning off). The response is streamed for the same reason as the
// Anthropic provider: a non-streamed response sends nothing until the model is done, and Chromium
// stops an extension's service worker when a fetch() takes more than 30 seconds to answer.

import { buildUserMessage, SYSTEM_PROMPT, TOOL, TOOL_NAME, transcriptLines } from '../detect/prompt';
import { parseToolInput, refine, toTimed } from '../detect/postprocess';
import { ApiError, SpentError, type DetectionInput, type DetectionResult, type DetectOptions, type LlmProvider } from './provider';
import { parseEvent, readSse } from './sse';

export const OPENAI_URL = 'https://api.openai.com/v1/responses';
/** Room for the model's own reasoning, where it reasons. */
const MAX_OUTPUT_TOKENS = 16000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type Effort = 'none' | 'low' | 'medium' | 'high';

/**
 * Models offered, cheapest first, with how much they should think before answering. Both run at
 * low, the least Sol allows. Luna supports none, but the eval on 2026-10-26 (15 verified segments)
 * found 13 of 15 with 21 of 26 boundaries passing at low against 12 of 15 and 17 of 24 at none,
 * for the same 2 cents. Prices from https://developers.openai.com/api/docs/pricing, 2026-10-26:
 * Luna $0.10 in / $0.50 out per million tokens, 6.1 Sol $2 / $10.
 */
export const OPENAI_MODELS: readonly { id: string; label: string; effort: Effort }[] = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', effort: 'low' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: 'low' },
];

const effortFor = (model: string): Effort | null => OPENAI_MODELS.find((m) => m.id === model)?.effort ?? null;

/**
 * The tool's JSON schema in the strict form the Responses API checks: every object lists its
 * properties as required (ours already do) and forbids others.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = strictSchema(v);
  if (out.type === 'object' && out.properties) out.additionalProperties = false;
  return out;
}

export function buildRequest(input: DetectionInput, model: string, effort: Effort | null = effortFor(model)): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model,
    stream: true,
    // Nothing is kept on OpenAI's side for later retrieval.
    store: false,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions: SYSTEM_PROMPT,
    input: [{ role: 'user', content: buildUserMessage(input) }],
    tools: [{ type: 'function', name: TOOL_NAME, description: TOOL.description, parameters: strictSchema(TOOL.input_schema), strict: true }],
    // One report only.
    tool_choice: { type: 'function', name: TOOL_NAME },
    parallel_tool_calls: false,
  };
  if (effort) request.reasoning = { effort };
  return request;
}

interface Streamed {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The response's final status: completed, incomplete, or failed. */
  status: string | null;
  /** Why an incomplete response stopped, for example max_output_tokens. */
  incompleteReason: string | null;
  /** The tool call's arguments, assembled from its deltas; the done event's full copy wins. */
  toolJson: string | null;
}

/**
 * Reads a Responses API event stream into the parts detection needs. Calls `onChunk` for every
 * chunk received, and releases the stream however reading ends.
 */
export async function readStream(body: ReadableStream<Uint8Array>, onChunk?: () => void): Promise<Streamed> {
  const out: Streamed = { model: null, inputTokens: 0, outputTokens: 0, status: null, incompleteReason: null, toolJson: null };
  let toolIndex: number | null = null;

  const readResponse = (e: Record<string, unknown>): void => {
    const r = e.response as
      | { model?: string; status?: string; usage?: { input_tokens?: number; output_tokens?: number }; incomplete_details?: { reason?: string }; error?: { message?: string } }
      | undefined;
    if (!r) return;
    if (r.model) out.model = r.model;
    if (r.status) out.status = r.status;
    if (typeof r.usage?.input_tokens === 'number') out.inputTokens = r.usage.input_tokens;
    if (typeof r.usage?.output_tokens === 'number') out.outputTokens = r.usage.output_tokens;
    if (r.incomplete_details?.reason) out.incompleteReason = r.incomplete_details.reason;
  };

  const handle = (data: string): void => {
    const e = parseEvent(data);
    if (!e) return;
    switch (e.type) {
      case 'response.output_item.added': {
        const item = e.item as { type?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === 'function_call' && item.name === TOOL_NAME && toolIndex === null) {
          toolIndex = Number(e.output_index);
          out.toolJson = item.arguments ?? '';
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        if (Number(e.output_index) === toolIndex && typeof e.delta === 'string') out.toolJson += e.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        if (Number(e.output_index) === toolIndex && typeof e.arguments === 'string') out.toolJson = e.arguments;
        break;
      }
      case 'response.created':
      case 'response.completed':
      case 'response.incomplete':
        readResponse(e);
        break;
      case 'response.failed': {
        // A server-side failure after the request was accepted. Transient, so not cached.
        readResponse(e);
        const err = (e.response as { error?: { message?: string } } | undefined)?.error;
        throw new ApiError(`OpenAI: ${err?.message ?? 'response failed'}`, 0);
      }
      case 'error': {
        throw new ApiError(`OpenAI: ${typeof e.message === 'string' ? e.message : 'stream error'}`, 0);
      }
    }
  };

  await readSse(body, handle, { onChunk });
  return out;
}

/** True for the error fetch() and stream reads throw when their AbortSignal fires. */
const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

export function createOpenAiProvider(fetchFn: FetchFn = (i, init) => fetch(i, init)): LlmProvider {
  // A model may reject the reasoning effort chosen for it (a newer snapshot with a different floor,
  // say). Remember which, so each one costs at most one rejected request per session, and leave the
  // effort to the model's default after that.
  const noEffort = new Set<string>();

  async function call(input: DetectionInput, options: DetectOptions, effort: Effort | null): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(buildRequest(input, options.model, effort)),
    };
    if (options.signal) init.signal = options.signal;
    const response = await fetchFn(OPENAI_URL, init);
    options.onActivity?.();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string; param?: string | null } } | null;
      throw new ApiError(`OpenAI: ${body?.error?.message ?? `HTTP ${response.status}`}`, response.status, body?.error?.param ?? null);
    }
    return response;
  }

  return {
    id: 'openai',
    label: 'OpenAI',
    models: OPENAI_MODELS.map(({ id, label }) => ({ id, label })),
    keyPlaceholder: 'sk-...',
    keysUrl: 'https://platform.openai.com/api-keys',
    // Project keys start with sk-proj-, service account keys with sk-svcacct-, older ones with sk-.
    // Anthropic's start with sk-ant-, so those are turned away here.
    isKey: (key) => /^sk-(?!ant-)[A-Za-z0-9_-]{20,}$/.test(key),
    async detect(input: DetectionInput, options: DetectOptions): Promise<DetectionResult> {
      let response: Response;
      const effort = effortFor(options.model);
      if (!effort || noEffort.has(options.model)) {
        response = await call(input, options, null);
      } else {
        try {
          response = await call(input, options, effort);
        } catch (error) {
          const aboutEffort = error instanceof ApiError && error.status === 400 && (error.param?.startsWith('reasoning') || /reasoning|effort/i.test(error.message));
          if (!aboutEffort) throw error;
          noEffort.add(options.model);
          response = await call(input, options, null);
        }
      }

      // From here the request was accepted, so tokens are being spent; see the Anthropic provider
      // for the reasoning behind SpentError versus ApiError.
      try {
        if (!response.body) throw new Error('empty response');
        const streamed = await readStream(response.body, options.onActivity);
        const ending = streamed.incompleteReason ? `${streamed.status}: ${streamed.incompleteReason}` : String(streamed.status);
        if (streamed.toolJson === null) throw new Error(`no ${TOOL_NAME} call in the response (status ${ending})`);
        let toolInput: unknown;
        try {
          toolInput = JSON.parse(streamed.toolJson || '{}');
        } catch (error) {
          // A max_output_tokens cut otherwise shows only as "Unterminated string in JSON".
          throw new Error(`unreadable ${TOOL_NAME} call (status ${ending}): ${error instanceof Error ? error.message : String(error)}`);
        }
        const lines = transcriptLines(input);
        return {
          segments: refine(toTimed(parseToolInput(toolInput), lines), input.durationSeconds, input.signals.chapters),
          model: streamed.model ?? options.model,
          usage: { inputTokens: streamed.inputTokens, outputTokens: streamed.outputTokens },
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isAbort(error) || options.signal?.aborted) throw new SpentError('OpenAI: timed out while the response was streaming');
        throw new SpentError(`OpenAI: ${error instanceof Error ? error.message.replace(/^OpenAI: /, '') : String(error)}`);
      }
    },
  };
}

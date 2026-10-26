// Anthropic provider. Calls the Messages API directly with the user's own key, which is the
// bring-your-own-key case Anthropic's direct-browser-access header exists for.
// Docs: https://platform.claude.com/docs/en/api/messages
//
// The response is streamed. A non-streamed response sends nothing until the model has finished, and
// Chromium stops an extension's service worker when a fetch() response takes more than 30 seconds to
// arrive; the tokens would be billed and the result lost. Streaming covers only that wait for the
// first byte. Chromium can still stop a service worker that has made no extension API call for 30
// seconds while a long stream is being read, so DetectionService keeps the worker alive while a
// detection runs.

import { buildUserMessage, SYSTEM_PROMPT, TOOL, TOOL_NAME, transcriptLines } from '../detect/prompt';
import { parseToolInput, refine, toTimed } from '../detect/postprocess';
import { ApiError, SpentError, type DetectionInput, type DetectionResult, type DetectOptions, type LlmProvider } from './provider';
import { parseEvent, readSse } from './sse';

export { ApiError };

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Room for the model's own reasoning on models that think before answering. */
const MAX_OUTPUT_TOKENS = 16000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type ToolChoice = { type: 'tool'; name: string } | { type: 'auto'; disable_parallel_tool_use: true };

const FORCED: ToolChoice = { type: 'tool', name: TOOL_NAME };
// Unforced, the model could call the tool more than once; only one report is read.
const AUTO: ToolChoice = { type: 'auto', disable_parallel_tool_use: true };

export function buildRequest(input: DetectionInput, model: string, toolChoice: ToolChoice = FORCED): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: toolChoice,
    messages: [{ role: 'user', content: buildUserMessage(input) }],
  };
}

interface Streamed {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** The tool call's input, assembled from its JSON deltas. */
  toolJson: string | null;
}

/**
 * Reads a Messages API event stream (server-sent events) into the parts detection needs. Calls
 * `onChunk` for every chunk received, and releases the stream however reading ends.
 */
export async function readStream(body: ReadableStream<Uint8Array>, onChunk?: () => void): Promise<Streamed> {
  const out: Streamed = { model: null, inputTokens: 0, outputTokens: 0, stopReason: null, toolJson: null };
  let toolIndex: number | null = null;

  const handle = (data: string): void => {
    const e = parseEvent(data);
    if (!e) return;
    switch (e.type) {
      case 'message_start': {
        const m = e.message as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
        out.model = m?.model ?? null;
        out.inputTokens = m?.usage?.input_tokens ?? 0;
        out.outputTokens = m?.usage?.output_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const block = e.content_block as { type?: string; name?: string } | undefined;
        if (block?.type === 'tool_use' && block.name === TOOL_NAME && toolIndex === null) {
          toolIndex = Number(e.index);
          out.toolJson = '';
        }
        break;
      }
      case 'content_block_delta': {
        const delta = e.delta as { type?: string; partial_json?: string } | undefined;
        if (Number(e.index) === toolIndex && delta?.type === 'input_json_delta') out.toolJson += delta.partial_json ?? '';
        break;
      }
      case 'message_delta': {
        // Counts here are cumulative, and input_tokens can appear here too.
        const usage = e.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const delta = e.delta as { stop_reason?: string } | undefined;
        if (typeof usage?.input_tokens === 'number') out.inputTokens = usage.input_tokens;
        if (usage?.output_tokens !== undefined) out.outputTokens = usage.output_tokens;
        if (delta?.stop_reason) out.stopReason = delta.stop_reason;
        break;
      }
      case 'error': {
        // A server-side condition such as overload, reported mid-stream. Transient, so not cached.
        const err = e.error as { message?: string } | undefined;
        throw new ApiError(`Anthropic: ${err?.message ?? 'stream error'}`, 0);
      }
    }
  };

  await readSse(body, handle, { onChunk });
  return out;
}

/** True for the error fetch() and stream reads throw when their AbortSignal fires. */
const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

export function createAnthropicProvider(fetchFn: FetchFn = (i, init) => fetch(i, init)): LlmProvider {
  // Some models refuse a forced tool call (for example ones that always think first). Remember
  // which, so each one costs at most one rejected request per session.
  const noForcedTool = new Set<string>();

  async function call(input: DetectionInput, options: DetectOptions, toolChoice: ToolChoice): Promise<Response> {
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
    options.onActivity?.();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new ApiError(`Anthropic: ${body?.error?.message ?? `HTTP ${response.status}`}`, response.status);
    }
    return response;
  }

  return {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ],
    keyPlaceholder: 'sk-ant-...',
    keysUrl: 'https://platform.claude.com/settings/keys',
    isKey: (key) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key),
    async detect(input: DetectionInput, options: DetectOptions): Promise<DetectionResult> {
      let response: Response;
      if (noForcedTool.has(options.model)) {
        response = await call(input, options, AUTO);
      } else {
        try {
          response = await call(input, options, FORCED);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 400 && /tool_choice/i.test(error.message))) throw error;
          noForcedTool.add(options.model);
          response = await call(input, options, AUTO);
        }
      }

      // From here the request was accepted, so tokens are being spent. Anything that then stops the
      // result from arriving or being used is a SpentError, which the caller remembers so the same
      // video is not paid for again: a response that can't be used, a dropped connection, and a
      // timeout (the caller aborting the signal) while the response streams. The one exception is an
      // error event the API sends mid-stream, such as overload, which is transient and not held.
      // Errors before this point (fetch() rejecting, an HTTP error, a timeout before the response
      // arrived) mean nothing was accepted, so the next visit tries again.
      try {
        if (!response.body) throw new Error('empty response');
        const streamed = await readStream(response.body, options.onActivity);
        if (streamed.toolJson === null) throw new Error(`no ${TOOL_NAME} call in the response (stop_reason ${String(streamed.stopReason)})`);
        let toolInput: unknown;
        try {
          toolInput = JSON.parse(streamed.toolJson || '{}');
        } catch (error) {
          // A max_tokens cut otherwise shows only as "Unterminated string in JSON".
          throw new Error(`unreadable ${TOOL_NAME} call (stop_reason ${String(streamed.stopReason)}): ${error instanceof Error ? error.message : String(error)}`);
        }
        const lines = transcriptLines(input);
        return {
          segments: refine(toTimed(parseToolInput(toolInput), lines), input.durationSeconds, input.signals.chapters),
          model: streamed.model ?? options.model,
          usage: { inputTokens: streamed.inputTokens, outputTokens: streamed.outputTokens },
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isAbort(error) || options.signal?.aborted) throw new SpentError('Anthropic: timed out while the response was streaming');
        throw new SpentError(`Anthropic: ${error instanceof Error ? error.message.replace(/^Anthropic: /, '') : String(error)}`);
      }
    },
  };
}

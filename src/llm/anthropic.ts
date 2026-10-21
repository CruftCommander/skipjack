// Anthropic provider. Calls the Messages API directly with the user's own key, which is the
// bring-your-own-key case Anthropic's direct-browser-access header exists for.
// Docs: https://platform.claude.com/docs/en/api/messages
//
// The response is streamed. A non-streamed response sends nothing until the model has finished, and
// Chromium may stop an extension's service worker that waits more than 30 seconds for a response to
// start; the tokens would be billed and the result lost.

import { buildUserMessage, SYSTEM_PROMPT, TOOL, TOOL_NAME, transcriptLines } from '../detect/prompt';
import { parseToolInput, refine, toTimed } from '../detect/postprocess';
import { SpentError, type DetectionInput, type DetectionResult, type DetectOptions, type LlmProvider } from './provider';

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
    stream: true,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: toolChoice,
    messages: [{ role: 'user', content: buildUserMessage(input) }],
  };
}

/** An error the API returned before generating anything, so nothing was spent. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Streamed {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** The tool call's input, assembled from its JSON deltas. */
  toolJson: string | null;
}

/** Reads a Messages API event stream (server-sent events) into the parts detection needs. */
export async function readStream(body: ReadableStream<Uint8Array>): Promise<Streamed> {
  const out: Streamed = { model: null, inputTokens: 0, outputTokens: 0, stopReason: null, toolJson: null };
  let toolIndex: number | null = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = body.getReader();

  const handle = (data: string): void => {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
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
        const usage = e.usage as { output_tokens?: number } | undefined;
        const delta = e.delta as { stop_reason?: string } | undefined;
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

  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    // Events are separated by a blank line; each has "event:" and "data:" lines.
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) handle(data);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (data) handle(data);
  }
  return out;
}

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

      // From here the request was accepted, so tokens are being spent. A response that arrives but
      // can't be used is a SpentError, which the caller caches so the same video is not paid for
      // again; an error the API reports mid-stream (overload, for example) and a timeout are not.
      try {
        if (!response.body) throw new Error('empty response');
        const streamed = await readStream(response.body);
        if (streamed.toolJson === null) throw new Error(`no ${TOOL_NAME} call in the response (stop_reason ${String(streamed.stopReason)})`);
        const toolInput = JSON.parse(streamed.toolJson || '{}');
        const lines = transcriptLines(input);
        return {
          segments: refine(toTimed(parseToolInput(toolInput), lines), input.durationSeconds, input.signals.chapters),
          model: streamed.model ?? options.model,
          usage: { inputTokens: streamed.inputTokens, outputTokens: streamed.outputTokens },
        };
      } catch (error) {
        if (error instanceof ApiError || (error instanceof Error && error.name === 'AbortError')) throw error;
        throw new SpentError(`Anthropic: ${error instanceof Error ? error.message.replace(/^Anthropic: /, '') : String(error)}`);
      }
    },
  };
}

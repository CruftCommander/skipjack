import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL } from '../src/detect/prompt';
import { buildRequest, createOpenAiProvider, OPENAI_MODELS, OPENAI_URL, readStream, strictSchema } from '../src/llm/openai';
import { SpentError } from '../src/llm/provider';
import type { DetectionInput } from '../src/llm/provider';
import { apiKeyStorageKey, llmProviders, providerForModel } from '../src/llm/registry';

const input: DetectionInput = {
  media: { platform: 'youtube', id: 'wIe3eDfGKUo' },
  title: 'Has AI Solved Reverse Engineering?',
  durationSeconds: 815,
  transcript: [
    { start: 222.4, duration: 3.6, text: "has some functionality. Today's video\nis brought to you by Sentry" },
    { start: 310.1, duration: 4, text: "Let's get back to it." },
    { start: 314.2, duration: 3, text: '   ' },
  ],
  signals: { chapters: [{ title: 'Sponsor', start: 420 }], paidPromotion: false, descriptionPromoLines: ['20% off'] },
};

/** A streamed Responses API response, cut into small chunks so events straddle reads. */
function sse(events: Record<string, unknown>[], chunkSize = 7): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const event = (e: Record<string, unknown>): Uint8Array => new TextEncoder().encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
const created = { type: 'response.created', response: { id: 'r1', model: 'gpt-6-luna', status: 'in_progress' } };

/** The events a model sends when it reasons briefly, then calls the tool, with the arguments split in two. */
function toolStream(toolInput: unknown, model = 'gpt-6-luna'): Record<string, unknown>[] {
  const json = JSON.stringify(toolInput);
  const half = Math.floor(json.length / 2);
  return [
    { ...created, response: { ...created.response, model } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs1', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: TOOL.name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc1', delta: json.slice(0, half) },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc1', delta: json.slice(half) },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc1', arguments: json },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: TOOL.name, arguments: json } },
    { type: 'response.completed', response: { id: 'r1', model, status: 'completed', usage: { input_tokens: 1200, output_tokens: 80 } } },
  ];
}

test('the registry offers OpenAI models under their own key', () => {
  assert.deepEqual(llmProviders.map((p) => p.id), ['anthropic', 'openai']);
  assert.equal(providerForModel('gpt-6-luna')?.id, 'openai');
  assert.equal(providerForModel('claude-haiku-5-5')?.id, 'anthropic');
  assert.equal(apiKeyStorageKey('openai'), 'apiKey:openai');
  const [anthropic, openai] = llmProviders;
  assert.equal(openai!.isKey('sk-proj-abcdefghijklmnopqrstuvwxyz0123'), true);
  assert.equal(openai!.isKey('sk-svcacct-abcdefghijklmnopqrstuvwxyz0123'), true);
  // Each provider turns the other's key away.
  assert.equal(openai!.isKey('sk-ant-abcdefghijklmnopqrstuvwxyz0123'), false);
  assert.equal(anthropic!.isKey('sk-proj-abcdefghijklmnopqrstuvwxyz0123'), false);
  assert.equal(openai!.isKey('sk-short'), false);
});

test('the request uses the Responses API with a forced strict tool, no storage, and the model reasoning floor', () => {
  const luna = buildRequest(input, 'gpt-6-luna');
  assert.equal(luna.stream, true);
  assert.equal(luna.store, false);
  assert.equal(luna.parallel_tool_calls, false);
  assert.deepEqual(luna.tool_choice, { type: 'function', name: TOOL.name });
  assert.deepEqual(luna.reasoning, { effort: 'none' });
  assert.deepEqual(buildRequest(input, 'gpt-6.1-sol').reasoning, { effort: 'low' });
  // An unknown model gets no reasoning setting, so the API applies its default.
  assert.equal('reasoning' in buildRequest(input, 'gpt-7-unknown'), false);
  const [tool] = luna.tools as { type: string; name: string; strict: boolean; parameters: { additionalProperties?: boolean; properties: { segments: { items: { additionalProperties?: boolean } } } } }[];
  assert.equal(tool!.type, 'function');
  assert.equal(tool!.name, TOOL.name);
  assert.equal(tool!.strict, true);
  assert.equal(tool!.parameters.additionalProperties, false);
  assert.equal(tool!.parameters.properties.segments.items.additionalProperties, false);
  assert.equal(typeof luna.instructions, 'string');
  const [message] = luna.input as { role: string; content: string }[];
  assert.equal(message!.role, 'user');
  assert.match(message!.content, /L0 \[/);
  assert.deepEqual(OPENAI_MODELS.map((m) => m.id), ['gpt-6-luna', 'gpt-6.1-sol']);
});

test('strictSchema leaves non-object schemas alone and does not touch the original', () => {
  assert.equal((TOOL.input_schema as { additionalProperties?: boolean }).additionalProperties, undefined);
  assert.deepEqual(strictSchema({ type: 'string', enum: ['a'] }), { type: 'string', enum: ['a'] });
  assert.deepEqual(strictSchema([{ type: 'object', properties: {} }]), [{ type: 'object', properties: {}, additionalProperties: false }]);
});

test('the provider streams the Responses API with a bearer key and parses the tool call', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const provider = createOpenAiProvider(async (url, init) => {
    seen = { url, init: init ?? {} };
    return sse(toolStream({ segments: [{ category: 'sponsor', first_line: 0, first_words: "Today's video", last_line: 1, last_words: 'back to it.', confidence: 0.9 }] }));
  });
  const r = await provider.detect(input, { apiKey: 'sk-proj-test', model: 'gpt-6-luna' });
  assert.equal(seen!.url, OPENAI_URL);
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-proj-test');
  assert.equal(JSON.parse(String(seen!.init.body)).stream, true);
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 80 });
  assert.equal(r.model, 'gpt-6-luna');
  assert.deepEqual(r.segments.map((s) => s.category), ['sponsor']);
  assert.equal(r.segments[0]?.end, 314.1);
});

test('readStream takes the done event over the deltas, reads usage from response.completed, and ignores other items', async () => {
  const events = toolStream({ segments: [] });
  // A delta that was lost in transit: the done event still carries the whole arguments string.
  const r = await readStream(sse(events.filter((e) => e.type !== 'response.function_call_arguments.delta')).body!);
  assert.equal(r.toolJson, '{"segments":[]}');
  assert.equal(r.status, 'completed');
  assert.deepEqual([r.inputTokens, r.outputTokens], [1200, 80]);

  const text = events.map((e) => `event: ${String(e.type)}\r\ndata: ${JSON.stringify(e)}`).join('\r\n\r\n');
  assert.equal((await readStream(new Response(text).body!)).toolJson, '{"segments":[]}');

  // A second function call is ignored; only the first report is read.
  const twice = [...events];
  twice.splice(-1, 0, { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc2', call_id: 'c2', name: TOOL.name, arguments: '{"segments":[1]}' } });
  assert.equal((await readStream(sse(twice).body!)).toolJson, '{"segments":[]}');
});

test('the provider falls back to the default reasoning effort when a model refuses the chosen one', async () => {
  const efforts: unknown[] = [];
  const provider = createOpenAiProvider(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    efforts.push(body.reasoning);
    if (body.reasoning) {
      return new Response(JSON.stringify({ error: { message: "Unsupported value: 'none' is not supported with this model. Supported values are: 'low', 'medium'.", type: 'invalid_request_error', param: 'reasoning.effort' } }), { status: 400 });
    }
    return sse(toolStream({ segments: [] }));
  });
  const opts = { apiKey: 'k', model: 'gpt-6-luna' };
  assert.deepEqual((await provider.detect(input, opts)).segments, []);
  await provider.detect(input, opts);
  // The refusal is remembered: the second video goes straight to the default.
  assert.deepEqual(efforts, [{ effort: 'none' }, undefined, undefined]);
});

test('the provider separates errors before the request is accepted from failures after', async () => {
  const err = createOpenAiProvider(async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }), { status: 401 }));
  const unauthorized = await err.detect(input, { apiKey: 'bad', model: 'gpt-6-luna' }).catch((e: unknown) => e);
  assert.ok(unauthorized instanceof Error && !(unauthorized instanceof SpentError));
  assert.match((unauthorized as Error).message, /OpenAI: Incorrect API key/);

  const none = createOpenAiProvider(async () =>
    sse([
      created,
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'hi' },
      { type: 'response.completed', response: { ...created.response, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
    ]),
  );
  await assert.rejects(none.detect(input, { apiKey: 'k', model: 'gpt-6-luna' }), (e: unknown) => e instanceof SpentError && /no report_segments call in the response \(status completed\)/.test(e.message));

  // Failures the API reports mid-stream are transient, so they are not treated as spent.
  const failed = createOpenAiProvider(async () => sse([created, { type: 'response.failed', response: { ...created.response, status: 'failed', error: { code: 'server_error', message: 'The server had an error' } } }]));
  await assert.rejects(failed.detect(input, { apiKey: 'k', model: 'gpt-6-luna' }), (e: unknown) => e instanceof Error && !(e instanceof SpentError) && /server had an error/.test(e.message));
  const errored = createOpenAiProvider(async () => sse([created, { type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached' }]));
  await assert.rejects(errored.detect(input, { apiKey: 'k', model: 'gpt-6-luna' }), (e: unknown) => e instanceof Error && !(e instanceof SpentError) && /Rate limit reached/.test(e.message));
});

test('a connection that drops mid-stream is a SpentError, a timeout after acceptance too, and an error event stops the download', async () => {
  const dropped = createOpenAiProvider(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(event(created));
          },
          pull(c) {
            c.error(new TypeError('network error'));
          },
        }),
      ),
  );
  await assert.rejects(dropped.detect(input, { apiKey: 'k', model: 'gpt-6-luna' }), (e: unknown) => e instanceof SpentError && /network error/.test(e.message));

  /** A response whose body never ends, and errors the way fetch() does when its signal fires. */
  let cancelled = false;
  const hanging = (signal: AbortSignal | null | undefined, first: Record<string, unknown>[]): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const e of first) c.enqueue(event(e));
          signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const accepted = createOpenAiProvider(async (_u, init) => hanging(init?.signal, [created]));
  const late = new AbortController();
  setTimeout(() => late.abort(), 20);
  await assert.rejects(accepted.detect(input, { apiKey: 'k', model: 'gpt-6-luna', signal: late.signal }), (e: unknown) => e instanceof SpentError && /timed out/.test(e.message));

  const errored = createOpenAiProvider(async (_u, init) => hanging(init?.signal, [created, { type: 'error', code: 'server_error', message: 'Overloaded' }]));
  await assert.rejects(errored.detect(input, { apiKey: 'k', model: 'gpt-6-luna' }), /Overloaded/);
  assert.equal(cancelled, true);
});

test('a tool call cut off by max_output_tokens names the reason', async () => {
  const provider = createOpenAiProvider(async () =>
    sse([
      created,
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: TOOL.name, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"segments":[{"category":"spon' },
      { type: 'response.incomplete', response: { ...created.response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1200, output_tokens: 16000 } } },
    ]),
  );
  await assert.rejects(provider.detect(input, { apiKey: 'k', model: 'gpt-6-luna' }), (e: unknown) => e instanceof SpentError && /status incomplete: max_output_tokens/.test(e.message));
});

test('the provider reports activity on the response and on every chunk', async () => {
  let activity = 0;
  const provider = createOpenAiProvider(async () => sse(toolStream({ segments: [] }), 50));
  await provider.detect(input, { apiKey: 'k', model: 'gpt-6-luna', onActivity: () => activity++ });
  assert.ok(activity > 3, `only ${activity} activity calls`);
});

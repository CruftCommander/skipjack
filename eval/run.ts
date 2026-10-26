// Model eval: runs detection on every probe report that has ground truth and scores it.
// Run with `npm run eval`. Needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment, for the
// providers of the models being run. See eval/README.md.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatTime } from '../src/core/format';
import type { DetectedSegment, DetectionInput, LlmProvider } from '../src/llm/provider';
import { providerForModel } from '../src/llm/registry';
import { reportToInput } from './report';
import { scoreVideo, type TruthSegment, type VideoScore } from './score';

/**
 * Dollars per million tokens, from https://platform.claude.com/docs/en/models/overview (2026-10-21)
 * and https://developers.openai.com/api/docs/pricing (2026-10-26).
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-astra': { input: 10, output: 50 },
};

/** The environment variable that holds each provider's key. */
const KEY_VARS: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const reportsDir = arg('reports') ?? 'probe/reports';
const models = (arg('models') ?? 'claude-haiku-5-5,claude-sonnet-5-5').split(',').map((m) => m.trim()).filter(Boolean);
const only = arg('video');

/** Each model's provider and key, checked before anything is spent. */
const runners = new Map<string, { provider: LlmProvider; apiKey: string }>();
for (const model of models) {
  const provider = providerForModel(model);
  if (!provider) {
    console.error(`No provider offers the model ${model}.`);
    process.exit(2);
  }
  const keyVar = KEY_VARS[provider.id] ?? `${provider.id.toUpperCase()}_API_KEY`;
  const apiKey = process.env[keyVar]?.trim();
  if (!apiKey) {
    console.error(`${keyVar} is not set or is empty; ${model} needs it. See eval/README.md.`);
    process.exit(2);
  }
  runners.set(model, { provider, apiKey });
}

const truthPath = join(reportsDir, 'ground-truth.json');
if (!existsSync(truthPath)) {
  console.error(`No ${truthPath}. See eval/README.md for its format.`);
  process.exit(2);
}
const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, TruthSegment[] | { segments: TruthSegment[] }>;
const truthFor = (id: string): TruthSegment[] | undefined => {
  const t = truth[id];
  return Array.isArray(t) ? t : t?.segments;
};

const reports: { file: string; input: DetectionInput }[] = [];
// Browsers name repeat downloads "...-transcript (1).json", so match those too.
for (const file of readdirSync(reportsDir).filter((f) => /-transcript( \(\d+\))?\.json$/.test(f))) {
  let input: DetectionInput;
  try {
    input = reportToInput(JSON.parse(readFileSync(join(reportsDir, file), 'utf8')));
  } catch (error) {
    // For example, the probe could not capture a transcript for this video.
    console.warn(`Skipping ${file}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (!truthFor(input.media.id) || (only && input.media.id !== only)) continue;
  // A video saved more than once ("... (1).json"): keep the report with the most transcript.
  const existing = reports.findIndex((r) => r.input.media.id === input.media.id);
  if (existing < 0) reports.push({ file, input });
  else if (input.transcript.length > (reports[existing]?.input.transcript.length ?? 0)) reports[existing] = { file, input };
}

if (reports.length === 0) {
  console.error('No transcript report has an entry in ground-truth.json.');
  process.exit(2);
}

const t = formatTime;
const s1 = (n: number): string => n.toFixed(1);

interface Totals {
  truth: number;
  matched: number;
  boundaries: number;
  passed: number;
  pitchShown: number;
  contentLost: number;
  falsePositives: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  errors: number;
}

const results: Record<string, unknown> = {};
const summary: Record<string, Totals> = {};

for (const model of models) {
  const { provider, apiKey } = runners.get(model)!;
  const tot: Totals = { truth: 0, matched: 0, boundaries: 0, passed: 0, pitchShown: 0, contentLost: 0, falsePositives: 0, inputTokens: 0, outputTokens: 0, ms: 0, errors: 0 };
  summary[model] = tot;
  console.log(`\n=== ${model} ===`);

  for (const { input } of reports) {
    const id = input.media.id;
    const expected = truthFor(id) ?? [];
    tot.truth += expected.length;
    const began = Date.now();
    let detected: DetectedSegment[];
    try {
      const result = await provider.detect(input, { apiKey, model });
      detected = result.segments;
      tot.inputTokens += result.usage.inputTokens;
      tot.outputTokens += result.usage.outputTokens;
    } catch (error) {
      tot.errors++;
      console.log(`${id}  ERROR ${error instanceof Error ? error.message : String(error)}`);
      continue;
    } finally {
      tot.ms += Date.now() - began;
    }

    const score: VideoScore = scoreVideo(expected, detected);
    results[`${model}/${id}`] = { detected, score };
    tot.matched += score.matches.length;
    tot.falsePositives += score.falsePositives.length;

    console.log(`${id}  ${(input.title ?? '').slice(0, 60)}`);
    for (const m of score.matches) {
      for (const [side, b] of [['start', m.start], ['end', m.end]] as const) {
        tot.boundaries++;
        if (b.pass) tot.passed++;
        tot.pitchShown += b.pitchShown;
        tot.contentLost += b.contentLost;
      }
      const flag = (b: { pass: boolean; pitchShown: number; contentLost: number }): string =>
        `${b.pass ? 'ok ' : 'BAD'} ${b.pitchShown > 0 ? `pitch +${s1(b.pitchShown)}s` : `content -${s1(b.contentLost)}s`}`;
      console.log(
        `  ${m.truth.category.padEnd(11)} truth ${t(m.truth.start)}-${t(m.truth.end)}  got ${s1(m.detected.start)}-${s1(m.detected.end)}` +
          `  start ${flag(m.start)}  end ${flag(m.end)}`,
      );
    }
    for (const m of score.missed) {
      const wrong = score.wrongCategory.find((w) => w.truth === m);
      console.log(`  MISSED ${m.category} ${t(m.start)}-${t(m.end)}${wrong ? ` (found as ${wrong.detected.category})` : ''}`);
    }
    for (const f of score.falsePositives) {
      if (score.wrongCategory.some((w) => w.detected === f)) continue;
      console.log(`  EXTRA  ${f.category} ${s1(f.start)}-${s1(f.end)}  "${(f as DetectedSegment).firstWords ?? ''}"`);
    }
  }
}

console.log('\n=== Summary ===');
console.log('model               found     boundaries ok   pitch shown  content lost  extra  errors  tokens in/out     cost     time');
for (const [model, x] of Object.entries(summary)) {
  const price = PRICES[model];
  const cost = price ? (x.inputTokens * price.input + x.outputTokens * price.output) / 1e6 : NaN;
  console.log(
    `${model.padEnd(18)}  ${`${x.matched}/${x.truth}`.padEnd(8)}  ${`${x.passed}/${x.boundaries}`.padEnd(15)}` +
      `${`${s1(x.pitchShown)}s`.padEnd(13)}${`${s1(x.contentLost)}s`.padEnd(14)}${String(x.falsePositives).padEnd(7)}` +
      `${String(x.errors).padEnd(8)}${`${x.inputTokens}/${x.outputTokens}`.padEnd(18)}` +
      `${Number.isFinite(cost) ? `$${cost.toFixed(4)}` : 'n/a'}`.padEnd(9) +
      `${(x.ms / 1000).toFixed(0)}s`,
  );
}

const outDir = join(reportsDir, 'eval');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify({ models, summary, results }, null, 2));
console.log(`\nFull results: ${outFile}`);

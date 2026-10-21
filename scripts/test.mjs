// Runs the unit tests with Node's built-in test runner. esbuild compiles each test/*.test.ts to
// .cache/test first, so the tests need no test framework.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, '.cache', 'test');
const files = (await readdir(join(root, 'test'))).filter((f) => f.endsWith('.test.ts'));

await rm(outdir, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: files.map((f) => join('test', f)),
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  define: { SKIPJACK_VERSION: '"test"' },
  logLevel: 'warning',
});

const built = files.map((f) => join(outdir, f.replace(/\.ts$/, '.mjs')));
const result = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
process.exit(result.status ?? 1);

// Compiles eval/run.ts with esbuild and runs it, passing arguments through.
//   npm run eval
//   npm run eval -- --models claude-haiku-5-5 --video wIe3eDfGKUo

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, '.cache', 'eval', 'run.mjs');

await build({
  absWorkingDir: root,
  entryPoints: ['eval/run.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);

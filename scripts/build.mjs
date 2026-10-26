// Builds the extension for each browser target into dist/<target>.
//   node scripts/build.mjs           build every target
//   node scripts/build.mjs --watch   rebuild on change
// Load dist/chromium unpacked in Edge or Chrome; load dist/firefox/manifest.json as a temporary
// add-on in Firefox.

import { context, build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

const YOUTUBE = ['https://www.youtube.com/*', 'https://m.youtube.com/*'];

/** PNGs rendered from src/icons/icon.svg by `npm run icons`. Keep in step with scripts/icons.mjs. */
const ICON_SIZES = [16, 32, 48, 128];
const iconSet = (sizes) => Object.fromEntries(sizes.map((size) => [String(size), `icons/icon-${size}.png`]));

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Skipjack',
    version: pkg.version,
    description: 'Skip the pitch. Skips sponsor reads, interaction reminders, and self-promotion in videos.',
    icons: iconSet(ICON_SIZES),
    permissions: ['storage'],
    // SponsorBlock for community segments; the LLM providers for detection with the user's own key.
    host_permissions: ['https://sponsor.ajay.app/*', 'https://api.anthropic.com/*', 'https://api.openai.com/*'],
    commands: {
      'undo-skip': { suggested_key: { default: 'Alt+Shift+U' }, description: 'Undo the last skip' },
    },
    action: { default_title: 'Skipjack', default_popup: 'popup.html', default_icon: iconSet([16, 32]) },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_scripts: [
      // Isolated world: the extension's own logic.
      { matches: YOUTUBE, js: ['content.js'], run_at: 'document_idle' },
      // Page world: answers "which video does the player hold" for the YouTube adapter.
      { matches: YOUTUBE, js: ['youtube-main.js'], run_at: 'document_start', world: 'MAIN' },
    ],
  };
  if (target === 'chromium') {
    m.minimum_chrome_version = '111';
    m.background = { service_worker: 'background.js' };
  } else {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'skipjack@cruftcommander.github.io',
        // 140 is the first version that reads data_collection_permissions (142 on Android).
        strict_min_version: '140.0',
        // Firefox shows this at install. With a key, detection sends a video's captions to the
        // user's LLM provider, which Mozilla classes as website content. Declared as required,
        // decided by Jeff on 2026-10-25, although users without a key send none.
        data_collection_permissions: { required: ['websiteContent'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  }
  return m;
}

const TARGETS = ['chromium', 'firefox'];

async function buildTarget(target) {
  const out = join(root, 'dist', target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const options = {
    absWorkingDir: root,
    entryPoints: {
      background: 'src/background/index.ts',
      content: 'src/content/index.ts',
      'youtube-main': 'src/platforms/youtube-main.ts',
      options: 'src/options/options.ts',
      popup: 'src/popup/popup.ts',
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: target === 'chromium' ? 'chrome111' : 'firefox140',
    define: { SKIPJACK_VERSION: JSON.stringify(pkg.version) },
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'info',
  };

  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2) + '\n');
  for (const [dir, file] of [['options', 'options.html'], ['options', 'options.css'], ['popup', 'popup.html'], ['popup', 'popup.css']]) {
    await copyFile(join(root, 'src', dir, file), join(out, file));
  }
  await mkdir(join(out, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) {
    await copyFile(join(root, 'src', 'icons', `icon-${size}.png`), join(out, 'icons', `icon-${size}.png`));
  }

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}

for (const target of TARGETS) await buildTarget(target);
if (watch) console.log('Watching for changes. Static files (HTML, CSS, manifest) need a full build.');

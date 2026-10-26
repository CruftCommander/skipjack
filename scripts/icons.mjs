// Renders src/icons/icon.svg to the PNG sizes the manifests use, written next to it as
// icon-<size>.png. The PNGs are committed, so only run this after changing the SVG:
//   npm run icons
// It needs Playwright and its Chromium build, which are not dependencies (as for the e2e checks):
//   npm install --no-save playwright@1.56.0
//   npx playwright install chromium

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep in step with ICON_SIZES in scripts/build.mjs. */
const ICON_SIZES = [16, 32, 48, 128];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src', 'icons');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (error) {
  console.error('Could not load Playwright. From the repository root, run:\n  npm install --no-save playwright@1.56.0\n  npx playwright install chromium');
  throw error;
}

const svg = await readFile(join(dir, 'icon.svg'));
const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
const browser = await chromium.launch();
try {
  for (const size of ICON_SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html, body { margin: 0; background: transparent; }</style><img src="${src}" width="${size}" height="${size}">`);
    await page.locator('img').evaluate((img) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(join(dir, `icon-${size}.png`), png);
    await page.close();
    console.log(`src/icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}

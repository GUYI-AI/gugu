import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const electron = process.env.GUGU_BROWSER_REAL_ELECTRON;
let temporary = '';
type Preview = { width: number; height: number; contentHeight: number; consoleMessages: { level: string; text: string }[]; picture: { width: number; height: number; corner: number[]; bar: number[] } };
let results: Record<string, Preview | { error: string }>;

// html_preview in a real Electron: the page drawn in its hidden window, measured and pictured. No account or model.
describe.skipIf(!electron)('html_preview with real Electron', () => {
  beforeAll(async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-html-preview-'));
    const repo = process.cwd();
    const entry = path.join(temporary, 'entry.ts');
    // A 300 px page (316 with the base sheet's padding): a bar in the first chart colour, a console line, and a try at
    // leaving for another page, which the window refuses.
    fs.writeFileSync(entry, `
import { app, nativeImage } from 'electron';
import { previewHtmlRender } from ${JSON.stringify(path.join(repo, 'apps/desktop/electron/html-render-preview'))};
const PAGE = '<div style="height:300px"><div id="bar" style="width:200px;height:40px;background:var(--c1)"></div></div><script>console.error("page says hi"); setTimeout(() => { location.href = "https://example.org/"; }, 0);</script>';
const pixel = (image, x, y) => { const bitmap = image.toBitmap(); const at = (y * image.getSize().width + x) * 4; return [bitmap[at + 2], bitmap[at + 1], bitmap[at]]; };
app.on('window-all-closed', () => {}); // the fixture's windows come and go; it exits itself
app.whenReady().then(async () => {
  const results = {};
  for (const appearance of ['light', 'dark']) {
    try {
      const preview = await previewHtmlRender({ html: PAGE, width: 560, appearance }, new AbortController().signal);
      const image = nativeImage.createFromBuffer(Buffer.from(preview.picture.data, 'base64'));
      results[appearance] = { ...preview, picture: { ...image.getSize(), corner: pixel(image, 400, 200), bar: pixel(image, 100, 28) } };
    } catch (error) {
      results[appearance] = { error: String(error && error.stack || error) };
    }
  }
  console.log('PREVIEW_RESULT=' + JSON.stringify(results));
  app.exit(0);
});
`);
    const shared = { name: 'shared', setup(builder: import('esbuild').PluginBuild) {
      builder.onResolve({ filter: /^@shared\// }, ({ path: imported }) => ({ path: path.join(repo, 'apps/desktop/src/session/shared', `${imported.slice(8)}.ts`) }));
      builder.onResolve({ filter: /^@main\/lib\/logger$/ }, () => ({ path: 'logger', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const log={warn(){},info(){},error(){}}' }));
    } };
    await build({ entryPoints: [entry], outfile: path.join(temporary, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [shared], logLevel: 'silent' });
    const env: NodeJS.ProcessEnv = { ...process.env, GUGU_HOME: path.join(temporary, 'home'), GUGU_USER_DATA_DIR: path.join(temporary, 'user-data') };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = process.platform === 'linux' ? ['--no-sandbox', path.join(temporary, 'main.cjs')] : [path.join(temporary, 'main.cjs')];
    const child = spawn(electron!, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code, stdout + '\n' + stderr).toBe(0);
    const line = stdout.split('\n').find(line => line.startsWith('PREVIEW_RESULT='));
    expect(line, stdout + '\n' + stderr).toBeDefined();
    results = JSON.parse(line!.slice('PREVIEW_RESULT='.length));
  }, 120_000);
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

  it.each([
    ['light', [255, 255, 255], [0x2a, 0x78, 0xd6]],
    ['dark', [0x0f, 0x0f, 0x0f], [0x39, 0x87, 0xe5]],
  ] as const)('measures and pictures the page in %s, on its own page', (appearance, background, bar) => {
    const preview = results[appearance] as Preview;
    expect(preview, JSON.stringify(results[appearance])).not.toHaveProperty('error');
    expect(preview.contentHeight).toBe(316);
    expect(preview.height).toBe(316);
    expect({ width: preview.picture.width, height: preview.picture.height }).toEqual({ width: 560, height: 316 });
    // Near the theme's background (a dark page's canvas is Chromium's own #121212) and its first chart colour, in a
    // JPEG: the page stayed on itself, themed.
    preview.picture.corner.forEach((channel, index) => expect(Math.abs(channel - background[index]!)).toBeLessThanOrEqual(4));
    preview.picture.bar.forEach((channel, index) => expect(Math.abs(channel - bar[index]!)).toBeLessThanOrEqual(4));
    expect(preview.consoleMessages).toContainEqual({ level: 'error', text: 'page says hi' });
  });
});

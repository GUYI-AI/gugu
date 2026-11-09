/**
 * 「从链接导入」:用户贴一个 Open VSX 扩展页或一个 Obsidian 主题的 GitHub 仓库,本机拉下来、只取颜色、存在本机。
 * 咕咕不打包、不上传、不转发 —— 这是用户自己拉的(owner 11-07 拍板)。许可证照样读出来,写在卡片上;没声明的写「—」。
 *
 * ❌ VS Code Marketplace:它的使用条款只许微软自家产品用,链接贴进来直接说明白,让人去 Open VSX 找同名扩展。
 * ❌ 第三方 CSS 进咕咕的文档:Obsidian 的 theme.css 只在一个沙盒 iframe 里算一次变量(不许脚本、CSP 禁掉一切外链),
 *    读完就拆。
 */
import { pickVariants, readVsix } from './theme-pack-vsix';
import { modeOfBackground, OBSIDIAN_VARIABLES, packModes, paletteFromObsidian, paletteIsReadable, type ThemeMode, type ThemePack } from './theme-packs';

export type ThemeImportErrorCode = 'unsupported-url' | 'marketplace' | 'not-found' | 'no-themes' | 'unreadable' | 'network' | 'obsidian-incomplete';

export class ThemeImportError extends Error {
  constructor(readonly code: ThemeImportErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type ThemeLink =
  | { kind: 'vscode'; namespace: string; name: string }
  | { kind: 'obsidian'; owner: string; repo: string };

/** 认得的链接:open-vsx.org/extension/<ns>/<name>[/<version>]、github.com/<owner>/<repo>[/…]。 */
export function parseThemeLink(input: string): ThemeLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ThemeImportError('unsupported-url');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'marketplace.visualstudio.com') throw new ThemeImportError('marketplace');
  if (host === 'open-vsx.org' && parts[0] === 'extension' && parts[1] && parts[2]) {
    return { kind: 'vscode', namespace: parts[1], name: parts[2] };
  }
  if (host === 'github.com' && parts[0] && parts[1]) {
    return { kind: 'obsidian', owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  }
  throw new ThemeImportError('unsupported-url');
}

async function fetchOk(url: string, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    // 调用方自己撤的(关了导入框):原样抛出,让它认得出来,❌ 包成「网络失败」。
    if (signal?.aborted) throw error;
    throw new ThemeImportError('network', String(error));
  }
  if (response.status === 404) throw new ThemeImportError('not-found', url);
  if (!response.ok) throw new ThemeImportError('network', `${response.status} ${url}`);
  return response;
}

async function importOpenVsx(link: Extract<ThemeLink, { kind: 'vscode' }>, signal?: AbortSignal): Promise<ThemePack> {
  const meta = (await (await fetchOk(`https://open-vsx.org/api/${link.namespace}/${link.name}`, signal)).json()) as {
    displayName?: string; version?: string; license?: string; files?: { download?: string }; namespace?: string; name?: string;
  };
  if (!meta.files?.download) throw new ThemeImportError('not-found', 'download');
  const contents = await readVsix(await (await fetchOk(meta.files.download, signal)).arrayBuffer());
  const picked = pickVariants(contents.themes);
  const modes: ThemePack['modes'] = {};
  const variants: Partial<Record<ThemeMode, string>> = {};
  for (const mode of ['dark', 'light'] as const) {
    const variant = picked[mode];
    if (variant?.palette) {
      modes[mode] = variant.palette;
      variants[mode] = variant.label;
    }
  }
  if (!modes.dark && !modes.light) throw new ThemeImportError('no-themes');
  return {
    id: `vscode:${link.namespace}.${link.name}`.toLowerCase(),
    name: meta.displayName || contents.displayName || link.name,
    modes,
    source: {
      kind: 'vscode',
      url: `https://open-vsx.org/extension/${link.namespace}/${link.name}`,
      author: contents.publisher || link.namespace,
      license: meta.license || contents.license || '',
      version: meta.version || contents.version,
      variants,
    },
  };
}

/** 颜色字符串(rgb()/hsl()/color()…,浏览器认得的都行)→ `#rrggbbaa`。借 canvas 让浏览器自己解析。 */
function normalizeColor(ctx: CanvasRenderingContext2D, value: string): string | null {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'transparent';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === 0) return null;
  return `#${[r, g, b, a].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 在沙盒 iframe 里套上 `body.theme-dark` / `body.theme-light`,读出 Obsidian 的那批变量的实际颜色。
 * `sandbox` 只给 allow-same-origin(父页面要读它的计算样式),不给脚本;CSP 只许内联样式,@import 与 url() 都拉不到东西。
 */
export async function evaluateObsidianCss(css: string): Promise<Partial<Record<ThemeMode, Record<string, string>>>> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;border:0;visibility:hidden';
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${safeCss}</style></head><body><div id="probe"></div></body></html>`;
  const loaded = new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
  document.body.appendChild(iframe);
  try {
    await loaded;
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    const probe = doc?.getElementById('probe');
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!doc || !win || !probe || !ctx) throw new ThemeImportError('obsidian-incomplete', 'sandbox');
    const out: Partial<Record<ThemeMode, Record<string, string>>> = {};
    for (const mode of ['dark', 'light'] as const) {
      doc.body.className = `theme-${mode}`;
      const vars: Record<string, string> = {};
      for (const name of OBSIDIAN_VARIABLES) {
        if (!win.getComputedStyle(probe).getPropertyValue(name).trim()) continue;
        probe.style.color = `var(${name})`;
        const color = normalizeColor(ctx, win.getComputedStyle(probe).color);
        if (color) vars[name] = color;
      }
      out[mode] = vars;
    }
    return out;
  } finally {
    iframe.remove();
  }
}

async function importObsidian(link: Extract<ThemeLink, { kind: 'obsidian' }>, signal?: AbortSignal): Promise<ThemePack> {
  const repo = (await (await fetchOk(`https://api.github.com/repos/${link.owner}/${link.repo}`, signal)).json()) as {
    default_branch?: string; license?: { spdx_id?: string } | null; html_url?: string; owner?: { login?: string };
  };
  const raw = (path: string) => `https://raw.githubusercontent.com/${link.owner}/${link.repo}/${repo.default_branch ?? 'main'}/${path}`;
  const manifest = (await (await fetchOk(raw('manifest.json'), signal)).json()) as { name?: string; version?: string; author?: string };
  const css = await (await fetchOk(raw('theme.css'), signal)).text();
  const computed = await evaluateObsidianCss(css);
  const modes: ThemePack['modes'] = {};
  for (const mode of ['dark', 'light'] as const) {
    const palette = computed[mode] ? paletteFromObsidian(computed[mode]) : null;
    // 只给了一种明暗的主题,另一种套上去算出来的底色还是原来那种:按底色判,对不上的不收。
    if (palette && modeOfBackground(palette.bg) === mode) modes[mode] = palette;
  }
  // 只调了强调色、底色靠 Obsidian 自带那套的主题,单拿出来没有完整的底色:说清楚,❌ 拿咕咕的底色硬凑。
  if (!modes.dark && !modes.light) throw new ThemeImportError('obsidian-incomplete');
  const spdx = repo.license?.spdx_id;
  return {
    id: `obsidian:${link.owner}/${link.repo}`.toLowerCase(),
    name: manifest.name || link.repo,
    modes,
    source: {
      kind: 'obsidian',
      url: repo.html_url ?? `https://github.com/${link.owner}/${link.repo}`,
      author: manifest.author || repo.owner?.login || link.owner,
      license: spdx && spdx !== 'NOASSERTION' ? spdx : '',
      version: manifest.version,
    },
  };
}

export async function importThemeFromLink(input: string, signal?: AbortSignal): Promise<ThemePack> {
  const link = parseThemeLink(input);
  const pack = await (link.kind === 'vscode' ? importOpenVsx(link, signal) : importObsidian(link, signal));
  for (const mode of packModes(pack)) if (!paletteIsReadable(pack.modes[mode]!, mode)) delete pack.modes[mode];
  if (packModes(pack).length === 0) throw new ThemeImportError('unreadable');
  return pack;
}

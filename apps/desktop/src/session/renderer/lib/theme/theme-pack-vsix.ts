/**
 * 读一个 VS Code 扩展包(.vsix,就是 zip)里的颜色主题:`package.json` 的 `contributes.themes[]` → 每套主题文件的 `colors`。
 * 主题文件是 JSONC(行尾注释、尾逗号都合法,JSON.parse 会炸),可能用 `include` 继承另一份,跟着读过去。
 * 只读数据,❌ 执行扩展里的任何代码。内置主题的生成脚本(scripts/theme-packs/)与「从链接导入」共用这一份。
 */
import JSZip from 'jszip';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { modeOfBackground, modeOfUiTheme, paletteFromVSCode, type RawPalette, type ThemeMode } from './theme-packs';

export type VsixTheme = { label: string; uiTheme: string; mode: ThemeMode | null; palette: RawPalette | null };

export type VsixContents = {
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  license: string;
  themes: VsixTheme[];
};

function normalizePath(base: string, relative: string): string {
  const parts = `${base}/${relative}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

async function readJsonc(zip: JSZip, path: string): Promise<Record<string, unknown>> {
  const file = zip.file(path);
  if (!file) throw new Error(`扩展包里没有 ${path}`);
  const errors: ParseError[] = [];
  const value = parseJsonc(await file.async('string'), errors, { allowTrailingComma: true });
  if (!value || typeof value !== 'object') throw new Error(`${path} 不是 JSON 对象`);
  return value as Record<string, unknown>;
}

/** 主题文件的 colors,`include` 链从远到近合并(近的覆盖远的);链最多走 8 层,防环。 */
async function readThemeColors(zip: JSZip, path: string, depth = 0): Promise<Record<string, string>> {
  const theme = await readJsonc(zip, path);
  const inherited = typeof theme.include === 'string' && depth < 8
    ? await readThemeColors(zip, normalizePath(path.split('/').slice(0, -1).join('/'), theme.include), depth + 1)
    : {};
  const own = theme.colors && typeof theme.colors === 'object' ? (theme.colors as Record<string, unknown>) : {};
  const colors: Record<string, string> = { ...inherited };
  for (const [key, value] of Object.entries(own)) if (typeof value === 'string') colors[key] = value;
  return colors;
}

export async function readVsix(bytes: ArrayBuffer | Uint8Array): Promise<VsixContents> {
  const zip = await JSZip.loadAsync(bytes);
  const manifest = await readJsonc(zip, 'extension/package.json');
  const contributes = (manifest.contributes ?? {}) as { themes?: Array<{ label?: string; uiTheme?: string; path?: string }> };
  const themes: VsixTheme[] = [];
  for (const entry of contributes.themes ?? []) {
    if (!entry.path) continue;
    const colors = await readThemeColors(zip, normalizePath('extension', entry.path));
    const palette = paletteFromVSCode(colors);
    const declared = modeOfUiTheme(entry.uiTheme);
    themes.push({
      label: entry.label ?? entry.path,
      uiTheme: entry.uiTheme ?? '',
      // 高对比两档不收;其余以实际底色为准(标的与底色不符时按底色)。
      mode: declared && palette ? modeOfBackground(palette.bg) : null,
      palette,
    });
  }
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    name: str(manifest.name),
    displayName: str(manifest.displayName) || str(manifest.name),
    publisher: str(manifest.publisher),
    version: str(manifest.version),
    license: str(manifest.license),
    themes,
  };
}

/**
 * 一个扩展常带好几套(Tokyo Night:Night / Storm / Light)。v1 每个模式取**第一套**,与 VS Code 主题列表里的顺序一致;
 * `prefer` 可以按名字点名某一套(内置表就是这样挑的)。
 */
export function pickVariants(
  themes: VsixTheme[],
  prefer: Partial<Record<ThemeMode, string>> = {},
): Partial<Record<ThemeMode, VsixTheme>> {
  const picked: Partial<Record<ThemeMode, VsixTheme>> = {};
  for (const mode of ['dark', 'light'] as const) {
    const usable = themes.filter((t) => t.mode === mode && t.palette);
    const named = prefer[mode] ? usable.find((t) => t.label === prefer[mode]) : undefined;
    if (prefer[mode] && !named) throw new Error(`扩展里没有名为「${prefer[mode]}」的${mode === 'dark' ? '深色' : '浅色'}主题`);
    const chosen = named ?? usable[0];
    if (chosen) picked[mode] = chosen;
  }
  return picked;
}

/**
 * 生成 apps/desktop/src/session/renderer/lib/theme/builtin-theme-packs.json —— 内置七族主题的上游配色(一族一行头、一个模式一行)。
 *
 * 用法:先从 Open VSX 下载下面 FAMILIES 里写明版本的 .vsix 放进一个目录(文件名 <namespace>.<name>.vsix),再
 *   pnpm exec tsx scripts/theme-packs/generate-builtin-theme-packs.ts <vsix 目录>
 * 与「从链接导入」走同一个 readVsix → paletteFromVSCode,只是数据落成仓里的数据文件(首帧前就要有、离线也要有)。
 * 每族的许可证都要先核过上游 LICENSE(MIT / Apache-2.0 才收),原文进仓根 THIRD_PARTY_NOTICES.md。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pickVariants, readVsix } from '../../apps/desktop/src/session/renderer/lib/theme/theme-pack-vsix';
import type { ThemeMode, ThemePack } from '../../apps/desktop/src/session/renderer/lib/theme/theme-packs';

const FAMILIES: Array<{ id: string; name: string; extension: string; version: string; author: string; prefer: Partial<Record<ThemeMode, string>> }> = [
  { id: 'tokyo-night', name: 'Tokyo Night', extension: 'enkia.tokyo-night', version: '1.1.2', author: 'enkia', prefer: { dark: 'Tokyo Night', light: 'Tokyo Night Light' } },
  { id: 'catppuccin', name: 'Catppuccin', extension: 'Catppuccin.catppuccin-vsc', version: '3.19.0', author: 'Catppuccin', prefer: { dark: 'Catppuccin Mocha', light: 'Catppuccin Latte' } },
  { id: 'github', name: 'GitHub', extension: 'GitHub.github-vscode-theme', version: '6.3.5', author: 'GitHub', prefer: { dark: 'GitHub Dark Default', light: 'GitHub Light Default' } },
  { id: 'gruvbox', name: 'Gruvbox', extension: 'jdinhlife.gruvbox', version: '1.29.2', author: 'jdinhlife', prefer: { dark: 'Gruvbox Dark Medium', light: 'Gruvbox Light Medium' } },
  { id: 'everforest', name: 'Everforest', extension: 'sainnhe.everforest', version: '0.3.0', author: 'sainnhe', prefer: { dark: 'Everforest Dark', light: 'Everforest Light' } },
  { id: 'rose-pine', name: 'Rosé Pine', extension: 'mvllow.rose-pine', version: '2.15.2', author: 'Rosé Pine', prefer: { dark: 'Rosé Pine', light: 'Rosé Pine Dawn' } },
  { id: 'dracula', name: 'Dracula', extension: 'dracula-theme.theme-dracula', version: '2.25.1', author: 'Dracula Theme', prefer: { dark: 'Dracula Theme' } },
];

const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0']);

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: generate-builtin-theme-packs.ts <vsix dir>');
  const packs: ThemePack[] = [];
  for (const family of FAMILIES) {
    const contents = await readVsix(readFileSync(join(dir, `${family.extension}.vsix`)));
    if (contents.version !== family.version) throw new Error(`${family.extension}: 期望 ${family.version},拿到 ${contents.version}`);
    if (!ALLOWED_LICENSES.has(contents.license)) throw new Error(`${family.extension}: 许可证 ${contents.license} 不在允许再分发的名单里`);
    const variants = pickVariants(contents.themes, family.prefer);
    const modes: ThemePack['modes'] = {};
    const labels: Partial<Record<ThemeMode, string>> = {};
    for (const mode of ['dark', 'light'] as const) {
      if (!family.prefer[mode]) continue;
      const variant = variants[mode];
      if (!variant?.palette) throw new Error(`${family.extension}: 缺 ${mode}`);
      modes[mode] = variant.palette;
      labels[mode] = variant.label;
    }
    const [namespace, name] = family.extension.split('.');
    packs.push({
      id: family.id,
      name: family.name,
      modes,
      source: {
        kind: 'builtin',
        url: `https://open-vsx.org/extension/${namespace}/${name}`,
        author: family.author,
        license: contents.license,
        version: contents.version,
        variants: labels,
      },
    });
  }
  const out = resolve(__dirname, '../../apps/desktop/src/session/renderer/lib/theme/builtin-theme-packs.json');
  const line = (value: unknown) => JSON.stringify(value);
  const rows = packs.map(({ modes, ...head }) => {
    const modeRows = Object.entries(modes).map(([mode, palette]) => `    ${line(mode)}: ${line(palette)}`);
    return `  ${line(head).slice(0, -1)},"modes":{\n${modeRows.join(',\n')}}}`;
  });
  writeFileSync(out, `[\n${rows.join(',\n')}\n]\n`);
  console.log(`wrote ${packs.length} packs → ${out}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

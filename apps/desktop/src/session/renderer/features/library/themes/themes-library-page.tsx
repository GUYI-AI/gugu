import { useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { Plus, Trash2 } from '@/lib/icons';
import { PageHeader } from '@renderer/lib/components/page-header';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import {
  chooseThemePack,
  removeImportedThemePack,
  resetThemePacks,
  restoreThemePackChoice,
  type ThemePackChoice,
} from '@renderer/lib/theme/theme-pack-store';
import {
  GUGU_DEFAULT_SWATCH,
  packModes,
  resolvePalette,
  type ResolvedPalette,
  type ThemeMode,
  type ThemePack,
  type ThemeSwatch,
} from '@renderer/lib/theme/theme-packs';
import { useThemePacks } from '@renderer/lib/theme/use-theme-packs';
import { readEffectiveHostTheme, readThemePreference, subscribeToHostTheme } from '@renderer/lib/theme/host-theme';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

function kindOf(pack: ThemePack): 'dual' | ThemeMode {
  const modes = packModes(pack);
  return modes.length === 2 ? 'dual' : modes[0];
}

function resolvedModes(pack: ThemePack): Partial<Record<ThemeMode, ResolvedPalette>> {
  const out: Partial<Record<ThemeMode, ResolvedPalette>> = {};
  for (const mode of packModes(pack)) out[mode] = resolvePalette(pack.modes[mode]!, mode);
  return out;
}

/** 一张小咕咕:最左栏、会话列表、内容区里一来一回两个气泡和输入框,全用这族自己的颜色画。 */
function ThemeThumb({ colors, translate }: { colors: ThemeSwatch; translate: Translate }) {
  const vars = {
    '--t-page': colors.page, '--t-bg': colors.bg, '--t-card': colors.card,
    '--t-fg': colors.fg, '--t-muted-fg': colors.mutedFg, '--t-live': colors.live,
  } as CSSProperties;
  return (
    <div aria-hidden className="flex h-28 overflow-hidden rounded-md bg-[var(--t-page)]" style={vars}>
      <div className="flex w-4 flex-col gap-1 px-[3px] py-2">
        {[0, 1, 2].map((i) => <span key={i} className="h-2 rounded-sm bg-[color-mix(in_oklab,var(--t-fg)_10%,transparent)]" />)}
      </div>
      <div className="flex w-14 flex-col gap-2 px-1 py-2">
        {[12, 6, 6, 6].map((amount, i) => (
          <span key={i} className="h-3 rounded-sm" style={{ background: `color-mix(in oklab, var(--t-fg) ${amount}%, transparent)` }} />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 bg-[var(--t-bg)] p-2 text-[9px] leading-3">
        <div className="max-w-[85%] self-start rounded-md bg-[color-mix(in_oklab,var(--t-bg),var(--t-fg)_6%)] px-2 py-1 text-[var(--t-fg)]">
          {translate('themes.preview.sample')}
          <span className="block text-[var(--t-muted-fg)]">Kip · 13:05</span>
        </div>
        <div className="self-end rounded-md bg-[color-mix(in_oklab,var(--t-bg),var(--t-fg)_11%)] px-2 py-1 text-[var(--t-live)]">
          {translate('themes.preview.reply')}
        </div>
        <div className="mt-auto h-4 rounded-[5px] bg-[var(--t-card)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--t-fg)_10%,transparent)]" />
      </div>
    </div>
  );
}

function ThemeCard({
  pack,
  resolved,
  previewMode,
  selected,
  onChoose,
  onRemove,
  translate,
}: {
  pack: ThemePack | null;
  resolved: Partial<Record<ThemeMode, ResolvedPalette>>;
  previewMode: ThemeMode;
  selected: boolean;
  onChoose: () => void;
  onRemove?: () => void;
  translate: Translate;
}) {
  const name = pack?.name ?? translate('themes.default');
  const kind = pack ? kindOf(pack) : 'dual';
  const shownMode = pack && !resolved[previewMode] ? packModes(pack)[0] : previewMode;
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onChoose}
        aria-pressed={selected}
        className={cn(
          'flex w-full flex-col gap-2 rounded-lg border border-border bg-background-1 p-2 text-left text-foreground transition-all hover:state-hover-layer active:state-press-layer',
          selected && 'border-[var(--live)] shadow-[0_0_0_1px_var(--live)]'
        )}
      >
        <ThemeThumb colors={resolved[shownMode] ?? GUGU_DEFAULT_SWATCH[shownMode]} translate={translate} />
        <div className="flex min-w-0 items-center gap-2 px-1">
          <span className="truncate text-sm font-medium">{name}</span>
          <Badge variant="secondary">{translate(`themes.mode.${kind}`)}</Badge>
        </div>
        <div className="truncate px-1 pb-1 text-xs text-foreground-muted">
          {pack ? `${pack.source.author} · ${pack.source.license || '—'}` : 'Gugu'}
        </div>
      </button>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-3 right-3 bg-background/70 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={onRemove}
          aria-label={translate('themes.removeNamed', { name })}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

/**
 * 资源库「主题」(owner 2026-11-07)。点卡片 = 立即换,底下一条可撤销的提示。导入的主题卡片上有删除。
 * 这一格只作用于这台电脑(别的格分机器,这一格不分):页头不挂机器范围。
 */
export function ThemesLibraryPage() {
  const { translate } = useSessionMessages();
  const { packs, slots } = useThemePacks();
  const effective = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, readEffectiveHostTheme);
  const showImport = useShowModal('themeImportModal');
  const resolved = useMemo(() => new Map(packs.map((pack) => [pack.id, resolvedModes(pack)])), [packs]);
  const nameOf = (id?: string) => packs.find((pack) => pack.id === id)?.name ?? translate('themes.default');

  const offerUndo = (title: string, before: ThemePackChoice) =>
    toast({
      key: 'theme-pack-choice',
      title,
      action: { label: translate('themes.undo'), onClick: () => restoreThemePackChoice(before) },
      duration: 6000,
    });

  const choose = (pack: ThemePack) => {
    const before = chooseThemePack(pack.id);
    const modes = packModes(pack);
    const switched = modes.length === 1 && modes[0] !== effective;
    offerUndo(
      switched ? translate(modes[0] === 'dark' ? 'themes.appliedDark' : 'themes.appliedLight', { name: pack.name }) : translate('themes.applied', { name: pack.name }),
      before
    );
  };

  const reset = () => {
    const before = { slots, preference: readThemePreference() };
    resetThemePacks();
    offerUndo(translate('themes.reset'), before);
  };

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        sticky
        scope={null}
        title={translate('themes.title')}
        description={translate('themes.description')}
        aside={(
          <Button onClick={() => showImport({})}>
            <Plus className="size-4" />
            <span>{translate('themes.import')}</span>
          </Button>
        )}
      >
        <span className="text-sm text-foreground-muted">
          {translate('themes.current', { dark: nameOf(slots.dark), light: nameOf(slots.light) })}
        </span>
      </PageHeader>
      <div className="grid gap-4 py-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        <ThemeCard
          pack={null}
          resolved={{}}
          previewMode={effective}
          selected={!slots[effective]}
          onChoose={reset}
          translate={translate}
        />
        {packs.map((pack) => (
          <ThemeCard
            key={pack.id}
            pack={pack}
            resolved={resolved.get(pack.id) ?? {}}
            previewMode={effective}
            selected={slots[effective] === pack.id}
            onChoose={() => choose(pack)}
            onRemove={pack.source.kind === 'builtin' ? undefined : () => {
              removeImportedThemePack(pack.id);
              toast({ title: translate('themes.removed', { name: pack.name }) });
            }}
            translate={translate}
          />
        ))}
      </div>
    </div>
  );
}

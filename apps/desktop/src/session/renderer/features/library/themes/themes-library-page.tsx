import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Info, Plus } from '@/lib/icons';
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@renderer/lib/ui/sheet';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { cn } from '@renderer/utils/utils';

type Filter = 'all' | 'dual' | 'dark' | 'light';
type Translate = ReturnType<typeof useSessionMessages>['translate'];


function kindOf(pack: ThemePack): Exclude<Filter, 'all'> {
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
  onDetails,
  translate,
}: {
  pack: ThemePack | null;
  resolved: Partial<Record<ThemeMode, ResolvedPalette>>;
  previewMode: ThemeMode;
  selected: boolean;
  onChoose: () => void;
  onDetails?: () => void;
  translate: Translate;
}) {
  const name = pack?.name ?? translate('themes.default');
  const adjusted = Object.values(resolved).reduce((n, p) => n + (p?.adjustments.length ?? 0), 0);
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
          {adjusted > 0 && (
            <Badge variant="outline" title={translate('themes.adjustedHint')}>
              {translate('themes.adjusted', { count: adjusted })}
            </Badge>
          )}
        </div>
        <div className="truncate px-1 pb-1 text-xs text-foreground-muted">
          {pack ? `${pack.source.author} · ${pack.source.license || '—'}` : 'Gugu'}
        </div>
      </button>
      {onDetails && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-3 right-3 bg-background/70 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={onDetails}
          aria-label={translate('themes.details', { name })}
        >
          <Info />
        </Button>
      )}
    </div>
  );
}

function ThemeDetail({ pack, onApply, onRemove, translate }: {
  pack: ThemePack;
  onApply: () => void;
  onRemove?: () => void;
  translate: Translate;
}) {
  const resolved = resolvedModes(pack);
  const rows = packModes(pack).flatMap((mode) => (resolved[mode]?.adjustments ?? []).map((a) => ({ mode, ...a })));
  const variants = Object.values(pack.source.variants ?? {}).filter(Boolean).join(' · ');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
      <div className="grid grid-cols-2 gap-3">
        {packModes(pack).map((mode) => (
          <div key={mode} className="flex flex-col gap-1">
            <span className="text-xs text-foreground-muted">{translate(`themes.preview.${mode}`)}</span>
            <ThemeThumb colors={resolved[mode]!} translate={translate} />
          </div>
        ))}
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{translate('themes.readability')}</h3>
        <p className="text-xs text-foreground-muted">{translate('themes.readabilityNote')}</p>
        {rows.length === 0 ? (
          <p className="text-sm text-foreground-muted">{translate('themes.readabilityNone')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.mode}-${row.role}`} className="border-b border-border">
                  <td className="py-2 pr-2 text-foreground-muted">{translate(`themes.preview.${row.mode}`)}</td>
                  <td className="py-2 pr-2">{translate(`themes.role.${row.role}` as SessionMessageKey)}</td>
                  <td className="py-2 pr-2 font-mono">
                    <Swatch color={row.from} /> {row.before.toFixed(2)} → <Swatch color={row.to} /> {row.after.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="flex flex-col gap-1 text-sm">
        <h3 className="font-medium">{translate('themes.source')}</h3>
        <span className="text-foreground-muted">{translate('themes.author', { author: pack.source.author })}</span>
        <span className="text-foreground-muted">
          {pack.source.license ? translate('themes.license', { license: pack.source.license }) : translate('themes.licenseNone')}
        </span>
        {variants && <span className="text-foreground-muted">{translate('themes.variants', { variants })}</span>}
        <a className="truncate text-[var(--text-link)]" href={pack.source.url} target="_blank" rel="noreferrer">
          {pack.source.url}
        </a>
        {pack.source.kind !== 'builtin' && <span className="text-xs text-foreground-muted">{translate('themes.importedNote')}</span>}
      </section>
      <div className="mt-auto flex gap-2">
        <Button onClick={onApply}>{translate('themes.apply')}</Button>
        {onRemove && <Button variant="outline" onClick={onRemove}>{translate('themes.remove')}</Button>}
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block size-3 rounded-[3px] align-[-1px] shadow-[inset_0_0_0_1px_var(--border-strong)]" style={{ background: color }} />;
}

/**
 * 资源库「主题」(owner 2026-11-07)。点卡片 = 立即换,底下一条可撤销的提示;ⓘ 看两种明暗的预览、可读性兜底改了什么、来源与许可。
 * 这一格只作用于这台电脑(别的格分机器,这一格不分):页头不挂机器范围。
 */
export function ThemesLibraryPage() {
  const { translate } = useSessionMessages();
  const { packs, slots } = useThemePacks();
  const effective = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, readEffectiveHostTheme);
  const showImport = useShowModal('themeImportModal');
  const [filter, setFilter] = useState<Filter>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const resolved = useMemo(() => new Map(packs.map((pack) => [pack.id, resolvedModes(pack)])), [packs]);
  const detail = packs.find((pack) => pack.id === detailId) ?? null;
  const shown = packs.filter((pack) => filter === 'all' || kindOf(pack) === filter);
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
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            size="sm"
            spacing={2}
            variant="outline"
            aria-label={translate('themes.title')}
            value={[filter]}
            onValueChange={([value]) => {
              if (value) setFilter(value as Filter);
            }}
          >
            {(['all', 'dual', 'dark', 'light'] as const).map((f) => (
              <ToggleGroupItem key={f} value={f}>{translate(`themes.filter.${f}`)}</ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-sm text-foreground-muted">
            {translate('themes.current', { dark: nameOf(slots.dark), light: nameOf(slots.light) })}
          </span>
        </div>
      </PageHeader>
      <div className="grid gap-4 py-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {(filter === 'all' || filter === 'dual') && (
          <ThemeCard
            key="gugu-default"
            pack={null}
            resolved={{}}
            previewMode={effective}
            selected={!slots[effective]}
            onChoose={reset}
            translate={translate}
          />
        )}
        {shown.map((pack) => (
          <ThemeCard
            key={pack.id}
            pack={pack}
            resolved={resolved.get(pack.id) ?? {}}
            previewMode={effective}
            selected={slots[effective] === pack.id}
            onChoose={() => choose(pack)}
            onDetails={() => setDetailId(pack.id)}
            translate={translate}
          />
        ))}
      </div>
      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent>
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle className="text-lg">{detail.name}</SheetTitle>
              </SheetHeader>
              <ThemeDetail
                pack={detail}
                translate={translate}
                onApply={() => {
                  choose(detail);
                  setDetailId(null);
                }}
                onRemove={detail.source.kind === 'builtin' ? undefined : () => {
                  removeImportedThemePack(detail.id);
                  setDetailId(null);
                  toast({ title: translate('themes.removed', { name: detail.name }) });
                }}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

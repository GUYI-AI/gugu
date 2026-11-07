import type { ChatCommands } from '../commands';
import { unitContainsItem, type RenderUnit } from '../core/units';

/** Stable display identity only. It never enters the transcript or a read receipt. */
export const fragmentAnchor = (key: string): string => `source-fragment:${key}`;

export function projectSourceFragments(
  canonical: RenderUnit[], window: ChatCommands['sourceWindow'], previous: readonly RenderUnit[],
): RenderUnit[] {
  if (!window) return canonical;
  const owners = new Map(window.resolvedFragmentOwners?.map(owner => [owner.fragmentKey, owner]));
  const fragments = new Map(window.sourceFragments?.map(fragment => [fragment.key, fragment]));
  for (const row of previous) {
    const fragment = row.sourceFragment;
    if (!fragment) continue;
    const owner = owners.get(fragment.key) ?? row.sourceOwner;
    if (owner && canonical.some(unit => unitContainsItem(unit, owner.itemId))) {
      fragments.set(fragment.key, fragments.get(fragment.key) ?? fragment);
      owners.set(fragment.key, { ...owner, fragmentKey: fragment.key });
    }
  }
  const replacements = new Map<string, RenderUnit[]>();
  const claimed = new Set<RenderUnit>();
  const aliases = new Map<string, string[]>();
  for (const fragment of [...fragments.values()].sort((a, b) => a.sourceRange.start - b.sourceRange.start)) {
    const owner = owners.get(fragment.key);
    const rows = owner ? canonical.filter(unit => unitContainsItem(unit, owner.itemId)) : [];
    const anchor = fragmentAnchor(fragment.key);
    // Several source fragments may resolve to the same canonical row. Render it once.
    if (rows.length && rows.some(row => claimed.has(row))) {
      const first = rows[0];
      aliases.set(first.id, [...aliases.get(first.id) ?? [], anchor]);
      continue;
    }
    if (rows.length) {
      rows.forEach(row => claimed.add(row));
      const retained = previous.filter(row => row.sourceOwner?.itemId === owner!.itemId)
        .flatMap(row => row.anchorIds ?? []);
      replacements.set(fragment.key, rows.map((row, i) => ({ ...row,
        ...(i === 0 ? { id: anchor, anchorIds: [...new Set([anchor, ...retained])], sourceFragment: fragment, sourceOwner: owner } : {}),
      })));
    } else if (fragment.text) {
      replacements.set(fragment.key, [{ id: anchor, itemId: anchor, groupId: anchor,
        kind: 'source-fragment', data: fragment, sourceFragment: fragment,
        groupRole: 'solo', gapBefore: 8, chrome: { insetX: 0 } }]);
    }
  }
  const result = canonical.filter(row => !claimed.has(row));
  for (const [key, rows] of replacements) {
    // Keep the old source slot relative to its next surviving row, even when
    // canonical history arrives in a different order or prepends older turns.
    const oldIndex = previous.findIndex(row => row.sourceFragment?.key === key);
    let at = result.length;
    if (oldIndex >= 0) {
      const next = previous.slice(oldIndex + 1).find(row => result.some(value => value.id === row.id));
      if (next) at = result.findIndex(row => row.id === next.id);
    }
    result.splice(at, 0, ...rows);
  }
  return result.map(row => {
    const extra = aliases.get(canonical.find(value => value.itemId === row.itemId)?.id ?? '');
    return extra ? { ...row, anchorIds: [...row.anchorIds ?? [], ...extra] } : row;
  });
}

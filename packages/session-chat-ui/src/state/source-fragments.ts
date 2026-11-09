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
  if (window.beforeLive) {
    result.unshift(...[...replacements.values()].flat());
  } else {
    const resultIds = new Set(result.map(row => row.id));
    const previousSlot = new Map<string, number>();
    previous.forEach((row, index) => {
      const key = row.sourceFragment?.key;
      if (key !== undefined && !previousSlot.has(key)) previousSlot.set(key, index);
    });
    for (const [key, rows] of replacements) {
      // Keep the old source slot relative to its next surviving row, even when
      // canonical history arrives in a different order or prepends older turns.
      const oldIndex = previousSlot.get(key) ?? -1;
      let at = result.length;
      if (oldIndex >= 0) {
        let next: RenderUnit | undefined;
        for (let i = oldIndex + 1; i < previous.length && !next; i++) if (resultIds.has(previous[i].id)) next = previous[i];
        if (next) at = result.findIndex(row => row.id === next.id);
      }
      result.splice(at, 0, ...rows);
      for (const row of rows) resultIds.add(row.id);
    }
  }
  if (!aliases.size) return result;
  const canonicalIdByItem = new Map<string, string>();
  for (const unit of canonical) if (!canonicalIdByItem.has(unit.itemId)) canonicalIdByItem.set(unit.itemId, unit.id);
  return result.map(row => {
    const extra = aliases.get(canonicalIdByItem.get(row.itemId) ?? '');
    return extra ? { ...row, anchorIds: [...row.anchorIds ?? [], ...extra] } : row;
  });
}

/**
 * Whether an incremental append may skip projection. True once every fragment of
 * the window has the same owner as in the previous build and that owner's item is
 * already in it (so it was already replaced there), with the same lineage and fragment set. A window that is still
 * locating or resolving keeps the full rebuild; a settled one does not cost every
 * later message a rebuild.
 */
export function sourceWindowSettled(
  window: ChatCommands['sourceWindow'], previous: ChatCommands['sourceWindow'], hasItem: (itemId: string) => boolean,
): boolean {
  if (!window && !previous) return true;
  if (!window || !previous || window.sourceLineage !== previous.sourceLineage) return false;
  const fragments = window.sourceFragments ?? [];
  const previousKeys = new Set((previous.sourceFragments ?? []).map(fragment => fragment.key));
  if (fragments.length !== previousKeys.size || fragments.some(fragment => !previousKeys.has(fragment.key))) return false;
  const owners = new Map(window.resolvedFragmentOwners?.map(owner => [owner.fragmentKey, owner.itemId]));
  const previousOwners = new Map(previous.resolvedFragmentOwners?.map(owner => [owner.fragmentKey, owner.itemId]));
  // An owner that resolves now must be projected once, even if its item is already on screen.
  return fragments.every(fragment => {
    const itemId = owners.get(fragment.key);
    return itemId !== undefined && previousOwners.get(fragment.key) === itemId && hasItem(itemId);
  });
}

import type { SessionTranslate } from '@renderer/localization/use-session-messages';

export function getBranchTooltipText(
  headDisplay: string | null,
  headKind: 'branch' | 'detached' | 'unborn',
  t: SessionTranslate,
): string {
  if (headKind === 'detached') return t('git.detachedAt', { ref: headDisplay ?? '?' });
  if (headKind === 'unborn') return t('git.initialCommitFirst');
  return headDisplay ?? '';
}

export function getPublishTooltipText({
  isPublishing,
  headDisplay,
  headKind,
  shouldOfferAddRemote,
}: {
  isPublishing: boolean;
  headDisplay: string | null;
  headKind: 'branch' | 'detached' | 'unborn';
  shouldOfferAddRemote: boolean;
}, t: SessionTranslate): string {
  if (isPublishing) return t('git.publishing');
  if (headKind === 'detached') return t('git.publishDetached');
  if (headKind === 'unborn' || !headDisplay) return t('git.initialCommitFirst');
  if (shouldOfferAddRemote) return t('git.publishNeedsRemote');
  return t('git.publishBranch');
}

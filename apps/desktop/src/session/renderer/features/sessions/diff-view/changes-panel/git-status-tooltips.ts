import { translateSessionMessage as t } from '@renderer/localization/locale-store';

export function getBranchTooltipText(
  headDisplay: string | null,
  headKind: 'branch' | 'detached' | 'unborn'
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
}): string {
  if (isPublishing) return t('git.publishing');
  if (headKind === 'detached') return t('git.publishDetached');
  if (headKind === 'unborn' || !headDisplay) return t('git.initialCommitFirst');
  if (shouldOfferAddRemote) return t('git.publishNeedsRemote');
  return t('git.publishBranch');
}

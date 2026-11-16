import { permissionModeSupportsBillingRoute, type ProviderPermissionModeMap } from './permissions';

export type ReviewModeRequirements = { minimumCliVersion: string; modelPattern: string };

/** A host version and a main model are both required; SDK/bridge versions are never inputs. */
export function meetsReviewModeRequirements(
  requirements: ReviewModeRequirements | undefined,
  facts: { cliVersion?: string; model?: string | null },
): boolean {
  if (!requirements) return true;
  const version = facts.cliVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const floor = requirements.minimumCliVersion.split('.').map(Number);
  if (!version || floor.length !== 3) return false;
  const comparison = version.findIndex((part, index) => part !== floor[index]);
  if (comparison !== -1 && version[comparison]! < floor[comparison]!) return false;
  return new RegExp(requirements.modelPattern, 'i').test((facts.model ?? '').replace(/\[.*\]$/, ''));
}

/** Official login and a platform-model route are separate facts, shared by desktop and phone. */
export function catalogAllowsAutoReview(
  map: ProviderPermissionModeMap | undefined,
  catalog: { kind: string; selected?: string | null; autoReview?: boolean; reviewerAvailable?: boolean; cliVersion?: string },
  route: 'own' | 'platform' | 'unknown',
  model: string | null | undefined,
): boolean {
  const entry = map?.['ai-review'];
  if (!entry || route === 'unknown' || !permissionModeSupportsBillingRoute('ai-review', map, route)) return false;
  if (route === 'own') return catalog.kind === 'ready' && !!model
    && catalog.selected === model && catalog.autoReview === true
    && meetsReviewModeRequirements(entry.reviewRequirements, { cliVersion: catalog.cliVersion, model });
  return (catalog.kind === 'ready' || catalog.kind === 'auth-required')
    && catalog.reviewerAvailable === true && !!model
    && meetsReviewModeRequirements(entry.reviewRequirements, {
      cliVersion: catalog.cliVersion, model: model.replace(/^platform:/, ''),
    });
}

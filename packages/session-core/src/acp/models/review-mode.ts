import { permissionModeSupportsBillingRoute, type ProviderPermissionModeMap } from './permissions';

export type ReviewModeRequirements = { minimumCliVersion: string; modelPattern: string };

export function meetsReviewModeVersion(requirements: ReviewModeRequirements | undefined, cliVersion?: string): boolean {
  if (!requirements) return true;
  const version = cliVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const floor = requirements.minimumCliVersion.split('.').map(Number);
  if (!version || floor.length !== 3) return false;
  const comparison = version.findIndex((part, index) => part !== floor[index]);
  if (comparison !== -1 && version[comparison]! < floor[comparison]!) return false;
  return true;
}

/** A host version and a main model are both required; SDK/bridge versions are never inputs. */
export function meetsReviewModeRequirements(
  requirements: ReviewModeRequirements | undefined,
  facts: { cliVersion?: string; model?: string | null },
): boolean {
  if (!meetsReviewModeVersion(requirements, facts.cliVersion)) return false;
  if (!requirements) return true;
  return new RegExp(requirements.modelPattern, 'i').test((facts.model ?? '').replace(/\[.*\]$/, ''));
}

/**
 * Official login and a platform-model route are separate facts, shared by desktop and phone.
 * `reviewer`: the host's verdict on who reviews a gateway session (platform / custom). When given it replaces the
 * main-model name rule: any model may run Auto mode once a model that can review is resolved for it.
 * Omitted (another harness, an older caller) = the declared requirements decide, unchanged.
 */
export function catalogAllowsAutoReview(
  map: ProviderPermissionModeMap | undefined,
  catalog: { kind: string; selected?: string | null; autoReview?: boolean; reviewerAvailable?: boolean; cliVersion?: string },
  route: 'own' | 'custom' | 'platform' | 'unknown',
  model: string | null | undefined,
  reviewer?: { ok: boolean },
): boolean {
  const entry = map?.['ai-review'];
  if (!entry || route === 'unknown' || !permissionModeSupportsBillingRoute('ai-review', map, route === 'custom' ? 'own' : route)) return false;
  if (route === 'own') return catalog.kind === 'ready' && !!model
    && catalog.selected === model && catalog.autoReview === true
    // autoReview is the native filter's verdict for this exact selection, including
    // any alias resolved from its own choice. Recheck the CLI floor, not the raw alias.
    && meetsReviewModeVersion(entry.reviewRequirements, catalog.cliVersion);
  if (!((catalog.kind === 'ready' || catalog.kind === 'auth-required') && catalog.reviewerAvailable === true && !!model)) return false;
  return reviewer
    ? reviewer.ok && meetsReviewModeVersion(entry.reviewRequirements, catalog.cliVersion)
    : meetsReviewModeRequirements(entry.reviewRequirements, {
      cliVersion: catalog.cliVersion, model: model.replace(/^platform:/, ''),
    });
}

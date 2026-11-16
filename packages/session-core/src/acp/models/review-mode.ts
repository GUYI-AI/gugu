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

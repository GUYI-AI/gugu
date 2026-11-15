import { newlyReachableHosts, type ExtensionCapability, type ExtensionManifest } from './manifest';

/**
 * #6646 (E-05) Where an installed extension came from; none for one installed before origins were kept.
 * `preinstalled` (L3): shipped inside gugu and installed by gugu at every start (preinstalled-apps.ts) — no
 * consent asked, since what it can do was reviewed with gugu itself; never uninstalled or switched off.
 */
export const EXTENSION_ORIGINS = ['market', 'folder', 'attachment', 'preinstalled', 'fork'] as const;
export type ExtensionOrigin = (typeof EXTENSION_ORIGINS)[number];

/**
 * What `candidate` declares that the installed version did not (a resource capability whose domains it widens counts as
 * new); everything it declares on a first install.
 * A withdrawn permission declared again is not new. A host under a declared wildcard is not new while that
 * wildcard is still granted.
 */
export function addedPermissions(
  installed: Pick<ExtensionManifest, 'permissions'> | undefined,
  revokedPermissions: readonly string[],
  candidate: ExtensionManifest
): { capabilities: ExtensionCapability[]; network: string[] } {
  const hadCapabilities = installed?.permissions?.capabilities ?? [];
  const hadNetwork = installed?.permissions?.network ?? [];
  const stillGranted = hadNetwork.filter((host) => !revokedPermissions.includes(host));
  return {
    capabilities: (candidate.permissions?.capabilities ?? []).filter(
      (capability) => !hadCapabilities.includes(capability)
        || (!revokedPermissions.includes(capability) && widensResourceDomains(installed, candidate, capability))
    ),
    network: newlyReachableHosts(stillGranted, candidate).filter((host) => !hadNetwork.includes(host)),
  };
}

/**
 * #1927 (42): a resource capability the installed version had is asked again when this version lists a domain for it
 * the installed one did not — more of the agent's resources is more permission. Fewer, or the same, asks nothing.
 */
function widensResourceDomains(
  installed: Pick<ExtensionManifest, 'permissions'> | undefined,
  candidate: ExtensionManifest,
  capability: ExtensionCapability
): boolean {
  const action = capability === 'chat:resources' ? 'resources' : capability === 'chat:resources:write' ? 'resources:write' : null;
  if (!action) return false;
  const had: readonly string[] = installed?.permissions?.bindings?.[0]?.domains?.[action] ?? [];
  return (candidate.permissions?.bindings?.[0]?.domains?.[action] ?? []).some((domain) => !had.includes(domain));
}

/**
 * One rule for every install (App 市场方案 10-07, owner「按你的来」): an App replaced by one from the same source, asking
 * for nothing new, goes in without asking — a folder by a folder, the market's by the market's, a chat package by one
 * its own publisher sent (摩擦单 F66). The person's press — 「更新到 vX」 in Apps, a card's 「更新」, an agent reinstalling
 * its own folder — is the consent; whatever is newly asked is asked, and only that (`addedPermissions`). Another source
 * is the person's call however little it asks (E-05), a first install replaces nothing, and a preinstalled App is
 * gugu's to replace.
 */
export function replacesWithoutAsking(args: {
  installed: Pick<ExtensionManifest, 'permissions'> | undefined;
  installedOrigin: ExtensionOrigin | undefined;
  /** A chat package's publisher — the installed one's as recorded, and this one's — compared: the same person's update. */
  installedPublisher?: string | null;
  publisher?: string | null;
  revokedPermissions: readonly string[];
  candidate: ExtensionManifest;
  origin: ExtensionOrigin;
}): boolean {
  if (!args.installed || args.installedOrigin !== args.origin || args.origin === 'preinstalled') return false;
  if (args.origin === 'attachment' && (!args.publisher || args.installedPublisher !== args.publisher)) return false;
  const added = addedPermissions(args.installed, args.revokedPermissions, args.candidate);
  return added.capabilities.length === 0 && added.network.length === 0;
}

/**
 * Whether installing `candidate` asks the person, and what it newly declares — one answer for every install that lands
 * an App from a folder or the market, on the desktop (main's installPlan) and the phone (its market installs). A first
 * install asks when it declares anything; replacing one from another source is the person's call even for a bundle asking
 * nothing; the same source asking for nothing new stays quiet (#6646 E-05: `replacesWithoutAsking`).
 */
export function installAsks(args: {
  installed: Pick<ExtensionManifest, 'permissions'> | undefined;
  installedOrigin: ExtensionOrigin | undefined;
  revokedPermissions: readonly string[];
  candidate: ExtensionManifest;
  origin: 'folder' | 'market' | 'fork';
}): { newlyAsked: string[]; asks: boolean } {
  const added = addedPermissions(args.installed, args.revokedPermissions, args.candidate);
  const newlyAsked = [...added.capabilities, ...added.network];
  const switchingVariant = args.origin === 'fork' || args.installedOrigin === 'fork';
  return { newlyAsked, asks: switchingVariant ? newlyAsked.length > 0 : args.installed ? !replacesWithoutAsking(args) : newlyAsked.length > 0 };
}

/** The withdrawals an install keeps: the ones this version still declares. No install restores one. */
export function keptRevocations(revoked: readonly string[], candidate: ExtensionManifest): string[] {
  const declared: readonly string[] = [
    ...(candidate.permissions?.capabilities ?? []),
    ...(candidate.permissions?.network ?? []),
  ];
  return revoked.filter((permission) => declared.includes(permission));
}

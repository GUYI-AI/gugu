// #1931 Compiled market releases on the desktop: the shared check (@shared/extensions/release/release-trust.ts — the
// market's own contract, against the trust table this build ships) and what only main can do with it:
// - before a registered App is unpacked: its signed release verifies, and is for exactly the package the index names
//   (market-catalog.ts);
// - after it is unpacked: the files on disk are exactly the signed ones;
// - whenever the host decides whether to believe the installed App (assistant-rules-trust.ts): the proof kept at install
//   verifies again, and the files that matter are still the signed ones.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MarketCodeSource, MarketInstallRecord, MarketReleaseProof } from '@shared/extensions/market';
// Main has Node, so it runs the mirrored contract itself (the page runs its web copy: release-trust-web.ts).
import { verifyReleaseSignature } from '@shared/extensions/release/release-contract.mjs';
import { releaseChecks, signedFileProblems, withinScope, type FileDigest, type SignedRelease } from '@shared/extensions/release/release-trust';

export {
  firstProblem,
  MAX_RELEASE_MANIFEST_BYTES,
  RELEASE_SIGNATURE_BYTES,
  releaseProof,
  releaseRequired,
  releaseTrustTableSchema,
  SHIPPED_RELEASE_TRUST,
  type ReleaseTrustTable,
  type SignedRelease,
} from '@shared/extensions/release/release-trust';

export const { verifyMarketRelease, verifyReleaseProof } = releaseChecks(verifyReleaseSignature);

/** What a market install records about its bytes (extensions-service `MARKET_SOURCES_FILENAME`): the source, and the verified proof. */
export function marketInstallRecord(prepared: { source: MarketCodeSource; release?: { proof: MarketReleaseProof } }): MarketInstallRecord {
  const { repo, path: folder, commit } = prepared.source;
  return { repo, path: folder, commit, ...(prepared.release ? { release: prepared.release.proof } : {}) };
}

/**
 * How the App's files in `dir` differ from its signed release: anything that is not a regular file, then what
 * `signedFileProblems` finds (a file not signed, a signed file missing or changed). `within` limits both sides to some
 * paths (a folder ends with `/`); none: every file.
 */
export function releaseFileProblems(dir: string, release: SignedRelease, within?: readonly string[]): string[] {
  const found = new Map<string, FileDigest>();
  const problems: string[] = [];
  const walk = (relative: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(child); continue; }
      if (!withinScope(child, within)) continue;
      if (!entry.isFile()) { problems.push(`${child} is not a regular file`); continue; }
      const bytes = fs.readFileSync(path.join(dir, child));
      found.set(child, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
  };
  walk('');
  return [...problems, ...signedFileProblems(found, release, within)];
}

// Types for release-contract.mjs: the gugu-apps market's public release contract, mirrored byte for byte at the commit in
// release-contract.pin.json (release-contract-mirror.test.ts holds it there). Only what the client calls is declared.

export interface SignedReleaseFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SignedReleaseArtifact extends SignedReleaseFile {
  role: 'app' | 'server-rules' | 'hosted';
}

export interface SignedRelease {
  schemaVersion: 1;
  appId: string;
  productId: string;
  version: string;
  keyId: string;
  source: { repo: string; commit: string };
  build: { repo: string; commit: string; workflow: string; runId: string; lockSha256: string; node: string };
  review: { url: string; author: string; reviewer: string; commit: string };
  compatibility: {
    desktop: { min: string; maxExclusive: string };
    server: { min: string; maxExclusive: string };
    api: { min: number; max: number };
    data: { read: { min: number; max: number }; write: { min: number; max: number } };
  };
  rulesVersion: string;
  artifacts: SignedReleaseArtifact[];
  files: SignedReleaseFile[];
}

/** A key as the market's trust table holds it: scoped to one App and its source repository; `revoked` only as a literal boolean. */
export interface ReleaseTrustKey {
  id: string;
  appId: string;
  sourceRepo: string;
  publicKey: string;
  revoked?: boolean;
}

export function digest(bytes: Uint8Array): string;
export const RELEASE_LIMIT: number;
export function releasePath(path: string): string;
/**
 * Bytes as the contract reads them: it calls `raw.toString('utf8')` for the text, as a Node Buffer answers. A plain
 * Uint8Array answers "1,2,3" instead — pass a Buffer, or release-trust.ts's bytes, which answer with the text everywhere.
 */
export type ContractBytes = Uint8Array & { toString(encoding?: 'utf8'): string };
export function compiledFile(path: string, bytes: ContractBytes): void;
export function validateRelease(release: unknown, options?: { reviewed?: boolean }): SignedRelease;
/** Throws `Release: …` unless `raw` is a valid reviewed release of `expected`, signed with the trusted, unrevoked key `keyId`. */
export function verifyReleaseSignature(
  raw: ContractBytes,
  signature: ContractBytes,
  keyId: string,
  trustedKeys: readonly ReleaseTrustKey[],
  expected: { appId: string; version: string },
): SignedRelease;

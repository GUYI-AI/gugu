// Public contract for compiled release directories. No private source or secret is read here.
import { createHash, createPublicKey, verify } from 'node:crypto';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const RELEASE_LIMIT = 50 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const error = (message) => { throw new Error(`Release: ${message}`); };
export function exact(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
    || Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !(key in object))) error(`invalid ${label} fields`);
}
export function releasePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0')
    || path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
    || /[:%?#\x00-\x1f]/.test(path)) error('unsafe relative path');
  return path;
}
export function compiledFile(path, bytes) {
  releasePath(path);
  if (path.split('/').some((part) => /^(node_modules|src|test|tests|fixtures|coverage)$/i.test(part))
    || /\.(tsx?|jsx|map|pem|key|p12|pfx)$/i.test(path)
    || /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path)) error(`source or secret file: ${path}`);
  if (!/\.(js|mjs|cjs|css|html|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|json|md|txt)$/i.test(path)
    && !/(^|\/)(LICENSE(?:-[\w.-]+)?|NOTICE)$/.test(path)) error(`file type is not allowed: ${path}`);
  if (/\.(js|mjs|cjs|css|html|svg|json|md|txt)$/i.test(path)) {
    const text = bytes.toString('utf8');
    if (/sourceMappingURL\s*=|sourceURL\s*=|-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)) error(`source map or private key material: ${path}`);
  }
}
function integerRange(range, label) {
  exact(range, ['min', 'max'], label);
  if (![range.min, range.max].every((n) => Number.isSafeInteger(n) && n >= 1) || range.min > range.max) error(`invalid ${label} range`);
}
function versionRange(range, label) {
  exact(range, ['min', 'maxExclusive'], label);
  if (!VERSION.test(range.min) || !VERSION.test(range.maxExclusive)) error(`invalid ${label} versions`);
  const a = range.min.split('.').map(Number), b = range.maxExclusive.split('.').map(Number);
  if (![...a, ...b].every((n) => Number.isSafeInteger(n) && n >= 0)) error(`invalid ${label} versions`);
  const at = a.findIndex((n, i) => n !== b[i]);
  if (at < 0 || a[at] >= b[at]) error(`empty ${label} range`);
}
export function validateRelease(release, { reviewed = true } = {}) {
  exact(release, ['schemaVersion', 'appId', 'productId', 'version', 'keyId', 'source', 'build', 'review', 'compatibility', 'rulesVersion', 'artifacts', 'files'], 'manifest');
  if (release.schemaVersion !== 1 || !matches(ID, release.appId) || !matches(ID, release.productId)
    || !matches(ID, release.keyId) || !matches(VERSION, release.version) || !matches(VERSION, release.rulesVersion)) error('invalid identity/version');
  exact(release.source, ['repo', 'commit'], 'source');
  if (!/^GUYI-AI\/[A-Za-z0-9._-]+$/.test(release.source.repo) || !COMMIT.test(release.source.commit)) error('invalid source provenance');
  exact(release.build, ['repo', 'commit', 'workflow', 'runId', 'lockSha256', 'node'], 'build');
  if (release.build.repo !== release.source.repo || !COMMIT.test(release.build.commit)
    || !/^\.github\/workflows\/[\w-]+\.ya?ml$/.test(release.build.workflow)
    || !/^\d+$/.test(release.build.runId) || !SHA.test(release.build.lockSha256)
    || !/^v?\d+\.\d+\.\d+$/.test(release.build.node)) error('invalid build provenance');
  if (reviewed || release.review !== null) {
    exact(release.review, ['url', 'author', 'reviewer', 'commit'], 'review');
    const reviewUrl = new RegExp(`^https://github\\.com/${release.source.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[1-9][0-9]*#pullrequestreview-[1-9][0-9]*$`);
    if (!matches(reviewUrl, release.review.url) || !matches(/^[\w-]+$/, release.review.author)
      || !matches(/^[\w-]+$/, release.review.reviewer) || release.review.author === release.review.reviewer
      || release.review.commit !== release.source.commit) error('missing non-author review for the source commit');
  }
  const c = release.compatibility;
  exact(c, ['desktop', 'server', 'api', 'data'], 'compatibility');
  versionRange(c.desktop, 'desktop'); versionRange(c.server, 'server'); integerRange(c.api, 'api');
  exact(c.data, ['read', 'write'], 'data'); integerRange(c.data.read, 'data.read'); integerRange(c.data.write, 'data.write');
  if (!Array.isArray(release.files) || release.files.length < 1 || release.files.length > 2000) error('invalid file inventory');
  const files = new Map();
  const portablePaths = new Set();
  let total = 0;
  for (const file of release.files) {
    exact(file, ['path', 'sha256', 'bytes'], 'file'); releasePath(file.path);
    const portable = file.path.normalize('NFC').toLowerCase();
    if (['release.json', 'release.sig'].includes(file.path) || files.has(file.path)
      || portablePaths.has(portable) || !matches(SHA, file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) error('invalid or duplicate file');
    portablePaths.add(portable);
    total += file.bytes; files.set(file.path, file);
  }
  if (total > RELEASE_LIMIT) error('release exceeds 50 MiB');
  if (!Array.isArray(release.artifacts) || !release.artifacts.length || release.artifacts.length > 3) error('invalid artifacts');
  const roles = new Set();
  for (const item of release.artifacts) {
    exact(item, ['role', 'path', 'sha256', 'bytes'], 'artifact');
    const file = files.get(item.path);
    if (!['app', 'server-rules', 'hosted'].includes(item.role) || roles.has(item.role)
      || !file || file.sha256 !== item.sha256 || file.bytes !== item.bytes) error('artifact inventory mismatch');
    roles.add(item.role);
    if (item.role === 'app' && item.path !== 'app.zip') error('app artifact must be app.zip');
  }
  if (!roles.has('app')) error('missing app artifact');
  for (const name of ['app/manifest.json', 'app/LICENSE', 'app/THIRD_PARTY_NOTICES.md', 'app.zip']) {
    if (!files.has(name)) error(`missing ${name}`);
  }
  return release;
}
export function verifyReleaseSignature(raw, signature, keyId, trustedKeys, expected) {
  if (raw.length > 512 * 1024 || signature.length !== 64) error('invalid signature envelope');
  const release = validateRelease(JSON.parse(raw.toString('utf8')));
  const key = trustedKeys.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && entry.id === keyId && entry.appId === expected.appId && entry.sourceRepo === release.source.repo
    && (!Object.hasOwn(entry, 'revoked') || entry.revoked === false));
  if (!key || release.keyId !== keyId || release.appId !== expected.appId || release.version !== expected.version) error('untrusted release identity or signing key');
  const publicKey = createPublicKey(key.publicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, raw, publicKey, signature)) error('invalid Ed25519 signature');
  return release;
}

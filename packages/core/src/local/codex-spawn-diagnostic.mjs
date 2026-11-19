import { realpathSync } from 'node:fs';

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null;

export function codexVersionFromUserAgent(value) {
  return typeof value === 'string'
    ? value.match(/^[A-Za-z0-9_-]+\/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:[\s(/]|$)/)?.[1] ?? null
    : null;
}

/** Log only selected runtime facts. Never pass argv, environment or raw probe output. */
export function codexSpawnDiagnostic({ executable, nativeVersion, appVersion, mode, phase, versionSource }) {
  let resolved = executable;
  try { resolved = realpathSync(executable); } catch { /* A failed spawn still needs its selected path. */ }
  const safePath = String(resolved)
    .replace(/(\/(?:Users|home)\/)[^/\\]+/g, '$1[user]')
    .replace(/(\\Users\\)[^\\/]+/gi, '$1[user]');
  return {
    providerId: 'codex', mode, phase,
    executable: safePath,
    nativeVersion: version(nativeVersion),
    versionSource: version(nativeVersion) ? versionSource : null,
    appVersion: version(appVersion),
  };
}

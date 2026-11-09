declare const __GUGU_TIER__: string | undefined;

/** One build-time gate for UI, native permission and vault entrypoints. No runtime override. */
export const PASSWORD_BETA_ENABLED = typeof __GUGU_TIER__ === 'string' && __GUGU_TIER__ === 'beta';

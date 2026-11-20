/**
 * Theme registry — the canonical list of available themes.
 *
 * Metadata only. The token values for each theme live in
 * `theme/__generated__/theme.css` and `semantic.css`, keyed by `selector`.
 */

export type ThemeManifestEntry = {
  id: string;
  label: string;
  polarity: 'light' | 'dark';
  selector: string;
};

export const THEME_MANIFEST: readonly ThemeManifestEntry[] = [
  { id: 'light', label: 'Light', polarity: 'light', selector: '.emlight' },
  { id: 'dark', label: 'Dark', polarity: 'dark', selector: '.emdark' },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    polarity: 'light',
    selector: '.emsolarized-light',
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    polarity: 'dark',
    selector: '.emsolarized-dark',
  },
] as const;

export type ThemeId = (typeof THEME_MANIFEST)[number]['id'];

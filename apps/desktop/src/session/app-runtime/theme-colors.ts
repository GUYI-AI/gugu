const STYLE_ID = 'gugu-theme-colors';

/**
 * The person's color theme on this page: the palette names ui.css defines, with the host's current values. Absent when
 * no theme is on, and the build's palette stands. Same layer as ui.css, so a page's own rules still win; doubled attribute
 * so it beats ui.css's per-theme block whichever loads first.
 */
export function applyThemeColors(colors: Readonly<Record<string, string>> | undefined): void {
  const current = document.getElementById(STYLE_ID);
  if (!colors) {
    current?.remove();
    return;
  }
  const style = current ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: STYLE_ID }));
  const body = Object.entries(colors).map(([name, value]) => `${name}: ${value};`).join(' ');
  style.textContent = `@layer gugu { :root[data-gugu-theme][data-gugu-theme] { ${body} } }`;
}

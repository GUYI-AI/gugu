/**
 * The icons the page declares, in document order: what Electron's `page-favicon-updated` reports (`<link rel=icon>`, and the
 * touch icons), as absolute addresses.
 */
export const READ_FAVICONS_SCRIPT = `[...document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel~="apple-touch-icon-precomposed" i]')].map(link => link.href).filter(Boolean)`;

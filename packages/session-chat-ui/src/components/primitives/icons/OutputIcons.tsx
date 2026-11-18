/** @jsxImportSource solid-js */
/**
 * 附件卡片的网页字形(#7193;文件画 `FileTile`)和行尾两枚箭头。
 *
 * 字形取自 Solar(与产品其余地方同一套,`packages/session-ui/src/icon-bodies.ts` 的 `Globe`,原样抄过来)。这个包不能引 `@gugu/session-ui`(那边依赖这边,引过去就成环),所以像这里其它字形一样留一份。
 * 改字形时两边一起改。
 */
const SIZE = { width: '18', height: '18', viewBox: '0 0 24 24', 'aria-hidden': true as const };

export function IconGlobe() {
  return (
    <svg {...SIZE}>
      <g fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 12a10 10 0 1 1-20.001 0A10 10 0 0 1 22 12Z" />
        <path d="M16 12c0 1.313-.104 2.614-.305 3.827c-.2 1.213-.495 2.315-.867 3.244c-.371.929-.812 1.665-1.297 2.168c-.486.502-1.006.761-1.531.761s-1.045-.259-1.53-.761c-.486-.503-.927-1.24-1.298-2.168c-.372-.929-.667-2.03-.868-3.244A23.6 23.6 0 0 1 8 12c0-1.313.103-2.614.304-3.827s.496-2.315.868-3.244c.371-.929.812-1.665 1.297-2.168C10.955 2.26 11.475 2 12 2s1.045.259 1.53.761c.486.503.927 1.24 1.298 2.168c.372.929.667 2.03.867 3.244C15.897 9.386 16 10.687 16 12Z" />
        <path stroke-linecap="round" d="M2 12h20" />
      </g>
    </svg>
  );
}

/** 行尾的「点进去」:`icon-bodies.ts` 的 `ChevronRight`。 */
export function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m9 5l6 7l-6 7" />
    </svg>
  );
}

/** 「打开方式 ▾」的下拉箭头:`icon-bodies.ts` 的 `ChevronDown`。 */
export function IconChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m19 9l-7 6l-7-6" />
    </svg>
  );
}

/**
 * The set's SVG files by id. Explicit `?raw` imports, not `import.meta.glob`: the App runtime's ui.js is bundled by esbuild
 * (vite.config.mts buildAppRuntime), which reads `?raw` but has no glob. Swapping an icon is swapping its file; a new
 * icon is its SVG, its manifest entry and one line here (tests/unit/core/shared/fileFamily.test.ts pins all three).
 */
import svg_archive from './archive.svg?raw';
import svg_audio from './audio.svg?raw';
import svg_c from './c.svg?raw';
import svg_code from './code.svg?raw';
import svg_cpp from './cpp.svg?raw';
import svg_cs from './cs.svg?raw';
import svg_css from './css.svg?raw';
import svg_doc from './doc.svg?raw';
import svg_docker from './docker.svg?raw';
import svg_folder from './folder.svg?raw';
import svg_folder_open from './folder-open.svg?raw';
import svg_go from './go.svg?raw';
import svg_h from './h.svg?raw';
import svg_html from './html.svg?raw';
import svg_image from './image.svg?raw';
import svg_java from './java.svg?raw';
import svg_js from './js.svg?raw';
import svg_json from './json.svg?raw';
import svg_jsx from './jsx.svg?raw';
import svg_kt from './kt.svg?raw';
import svg_lock from './lock.svg?raw';
import svg_md from './md.svg?raw';
import svg_pdf from './pdf.svg?raw';
import svg_php from './php.svg?raw';
import svg_py from './py.svg?raw';
import svg_rb from './rb.svg?raw';
import svg_rs from './rs.svg?raw';
import svg_scss from './scss.svg?raw';
import svg_sh from './sh.svg?raw';
import svg_sheet from './sheet.svg?raw';
import svg_slides from './slides.svg?raw';
import svg_sql from './sql.svg?raw';
import svg_svelte from './svelte.svg?raw';
import svg_swift from './swift.svg?raw';
import svg_text from './text.svg?raw';
import svg_toml from './toml.svg?raw';
import svg_ts from './ts.svg?raw';
import svg_tsx from './tsx.svg?raw';
import svg_unknown from './unknown.svg?raw';
import svg_video from './video.svg?raw';
import svg_vue from './vue.svg?raw';
import svg_yaml from './yaml.svg?raw';

export const FILE_ICON_SVGS: Record<string, string> = {
  'archive': svg_archive,
  'audio': svg_audio,
  'c': svg_c,
  'code': svg_code,
  'cpp': svg_cpp,
  'cs': svg_cs,
  'css': svg_css,
  'doc': svg_doc,
  'docker': svg_docker,
  'folder': svg_folder,
  'folder-open': svg_folder_open,
  'go': svg_go,
  'h': svg_h,
  'html': svg_html,
  'image': svg_image,
  'java': svg_java,
  'js': svg_js,
  'json': svg_json,
  'jsx': svg_jsx,
  'kt': svg_kt,
  'lock': svg_lock,
  'md': svg_md,
  'pdf': svg_pdf,
  'php': svg_php,
  'py': svg_py,
  'rb': svg_rb,
  'rs': svg_rs,
  'scss': svg_scss,
  'sh': svg_sh,
  'sheet': svg_sheet,
  'slides': svg_slides,
  'sql': svg_sql,
  'svelte': svg_svelte,
  'swift': svg_swift,
  'text': svg_text,
  'toml': svg_toml,
  'ts': svg_ts,
  'tsx': svg_tsx,
  'unknown': svg_unknown,
  'video': svg_video,
  'vue': svg_vue,
  'yaml': svg_yaml,
};

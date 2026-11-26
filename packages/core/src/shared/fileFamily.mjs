// @@@file-family - 一个文件归哪一族:文件图标在 manifest 认不出它时(没有后缀、后缀没收、只有 mime 说得清)按族取图标
// (packages/session-shared/src/file-marks.ts)。10 族 + other;后缀说了算,没有后缀或后缀不认识时看 mime。
import { extensionOf, normalizeMimeType } from './imageMime.mjs'

const FAMILIES = [
  ['pdf', /^pdf$/, /pdf/],
  ['word', /^(docx?|odt|rtf|pages)$/, /msword|wordprocessing|opendocument\.text/],
  ['sheet', /^(xlsx?|csv|tsv|ods|numbers)$/, /excel|spreadsheet|csv/],
  ['slides', /^(pptx?|odp|key)$/, /powerpoint|presentation/],
  ['archive', /^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/, /zip|compressed|x-tar|gzip/],
  ['image', /^(a?png|jpe?g|jfif|gif|webp|bmp|svg|heic|heif|tiff?|avif|ico)$/, /^image\//],
  ['video', /^(mp4|mov|webm|mkv|avi|m4v)$/, /^video\//],
  ['audio', /^(mp3|wav|m4a|aac|flac|ogg|opus)$/, /^audio\//],
  ['code', /^(js|mjs|cjs|ts|mts|cts|tsx|jsx|py|go|rs|java|c|cc|cpp|h|hpp|cs|sh|bash|zsh|rb|php|swift|kt|sql|css|scss|sass|less|vue|svelte)$/, /javascript|typescript|x-python|x-sh|x-shellscript/],
  ['text', /^(md|txt|json|ya?ml|xml|html?|log)$/, /^text\/|json/],
]

/** `report.pdf` → `'pdf'`; a name without a known suffix goes by its mime; nothing known → `'other'`. */
export function fileFamily(name, mime) {
  const suffix = extensionOf(name)
  const type = normalizeMimeType(mime)
  return FAMILIES.find(([, bySuffix]) => bySuffix.test(suffix))?.[0]
    ?? FAMILIES.find(([, , byType]) => byType.test(type))?.[0]
    ?? 'other'
}

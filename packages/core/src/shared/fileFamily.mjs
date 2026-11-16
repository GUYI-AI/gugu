// @@@file-family - 一个文件归哪一族:图标和族色都只查这一处(packages/session-shared/src/file-marks.ts 的表)。
// 族就是文件 App `markOf` 的那 10 族 + other;后缀说了算,没有后缀或后缀不认识时看 mime。
// 文件 App 拿不到 core,暂时还留着 list.js 那一份;两份同口径由 tests/unit/core/shared/fileFamily.test.ts 钉住。
import { extensionOf, normalizeMimeType } from './imageMime.mjs'

const FAMILIES = [
  ['pdf', /^pdf$/, /pdf/],
  ['word', /^(docx?|odt|rtf|pages)$/, /msword|wordprocessing|opendocument\.text/],
  ['sheet', /^(xlsx?|csv|tsv|ods|numbers)$/, /excel|spreadsheet|csv/],
  ['slides', /^(pptx?|odp|key)$/, /powerpoint|presentation/],
  ['archive', /^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/, /zip|compressed|x-tar|gzip/],
  ['image', /^(png|jpe?g|gif|webp|bmp|svg|heic|avif|ico)$/, /^image\//],
  ['video', /^(mp4|mov|webm|mkv|avi|m4v)$/, /^video\//],
  ['audio', /^(mp3|wav|m4a|aac|flac|ogg|opus)$/, /^audio\//],
  ['code', /^(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|sh|rb|php|swift|kt|sql)$/, /javascript|typescript|x-python|x-sh/],
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

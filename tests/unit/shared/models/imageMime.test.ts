import { describe, expect, it } from 'vitest'
import {
  isImageMimeType,
  isRenderableImage,
  mimeTypeFromName,
  resolveAttachmentMimeType,
} from '../../../../packages/core/src/shared/imageMime.mjs'
import { inferAttachmentKind, isMpegTsVideo, resolveFileMimeType, sniffFileMimeType } from '../../../../packages/core/src/shared/ui/attachmentModels'
import { attachmentTypeKey } from '../../../../apps/desktop/src/components/chat/attachmentType'

// 「PNG 有时渲染有时不渲染」:agent 发文件时 mime_type 可选、大小写随意,判据必须是 mime ∪ 扩展名。
describe('image mime resolution', () => {
  it('fills a missing or generic mime from the extension, case-insensitively', () => {
    expect(resolveAttachmentMimeType('chart.png', undefined)).toBe('image/png')
    expect(resolveAttachmentMimeType('CHART.PNG', '')).toBe('image/png')
    expect(resolveAttachmentMimeType('photo.jpeg', 'application/octet-stream')).toBe('image/jpeg')
    expect(resolveAttachmentMimeType('notes.bin', undefined)).toBe('application/octet-stream')
    // #6646 扩展包:浏览器报空 type,按后缀补成扩展包的 mime,且不当图片。
    expect(resolveAttachmentMimeType('notes-1.0.0.GUGUEXT', '')).toBe('application/vnd.gugu.extension+zip')
    expect(isRenderableImage('notes-1.0.0.guguext', 'application/octet-stream')).toBe(false)
  })
  it('keeps a declared mime but normalizes its case and parameters', () => {
    expect(resolveAttachmentMimeType('x', 'Image/PNG')).toBe('image/png')
    expect(resolveAttachmentMimeType('a.pdf', 'application/pdf; charset=binary')).toBe('application/pdf')
    expect(isImageMimeType('IMAGE/WEBP')).toBe(true)
  })
  it('treats heic/tiff as images that Chromium cannot draw inline', () => {
    expect(mimeTypeFromName('IMG_1.HEIC')).toBe('image/heic')
    expect(isRenderableImage('IMG_1.HEIC', '')).toBe(false)
    expect(isRenderableImage('scan.tiff', 'image/tiff')).toBe(false)
    expect(isRenderableImage('shot.png', '')).toBe(true)
    // 历史消息:agent 没带 mime 发的 PNG 被记成 file + octet-stream,渲染端据扩展名自愈。
    expect(isRenderableImage('shot.png', 'application/octet-stream')).toBe(true)
  })
  it('classifies a browser File with an empty type by its name', () => {
    expect(inferAttachmentKind({ name: 'drag.png', type: '' })).toBe('image')
    expect(inferAttachmentKind({ name: 'README', type: '' })).toBe('file')
  })
  // 10-07 #6973:agent 不带 mime_type 传进工作区的 .mp4 落成 octet-stream,App 拿到的 Blob 类型就错了。一张表:App 的
  // contentTypeOf 也查它。
  it('fills video, audio and documents from the same table, and none of them is an image', () => {
    expect(resolveAttachmentMimeType('clip.mp4', undefined)).toBe('video/mp4')
    expect(resolveAttachmentMimeType('take.MOV', 'application/octet-stream')).toBe('video/quicktime')
    expect(resolveAttachmentMimeType('vo.mp3', '')).toBe('audio/mpeg')
    expect(resolveAttachmentMimeType('brief.md', '')).toBe('text/markdown')
    expect(mimeTypeFromName('server.ts')).toBe('text/typescript')
    expect(mimeTypeFromName('board.json')).toBe('application/json')
    expect(mimeTypeFromName('notes.bin')).toBeNull()
    expect(inferAttachmentKind({ name: 'clip.mp4', type: '' })).toBe('file')
  })
  // 10-15 #7263:聊天里发来的 HTML 在 `chat-media` 桶里落成 application/octet-stream,浏览器直接开那个 public
  // URL 就只当二进制/文本,下载到本地再打开才渲染。同 #6646(`.guguext`)、#6973(`.mp4`)一格:表里漏了 html,
  // 补上之后按后缀回落的上传路径(桌面 composer、agent 的 message_send_file)才会写 text/html。
  it('names an HTML attachment text/html from its suffix', () => {
    expect(resolveAttachmentMimeType('report.html', '')).toBe('text/html')
    expect(resolveAttachmentMimeType('REPORT.HTM', 'application/octet-stream')).toBe('text/html')
    expect(mimeTypeFromName('报告.html')).toBe('text/html')
    // 还不是图片:HTML 附件照旧画成文件卡片。
    expect(inferAttachmentKind({ name: 'report.html', type: '' })).toBe('file')
    // 声明的类型说了就算 —— 显式的 text/plain 不被后缀抢走。
    expect(resolveAttachmentMimeType('report.html', 'text/plain')).toBe('text/plain')
  })
  // 11-08:桌面发 `.ts` 卡片写「视频」—— file.type 是系统按后缀猜的(macOS/Electron 给 video/mp2t,Linux 给 Qt 的
  // text/vnd.trolltech.linguist,.mts 给 video/mp2t,.cts 给空),不是声明。可 .ts / .mts / .m2ts 也真有视频,看文件头才分得清。
  const packets = (size: number, offset: number) => {
    const bytes = new Uint8Array(size * 2)
    bytes[offset] = 0x47
    bytes[offset + size] = 0x47
    return bytes
  }
  it('tells a TypeScript file from an MPEG-TS video by its first bytes', async () => {
    const source = new TextEncoder().encode('export const adam = (lr: number) => lr\n')
    expect(await sniffFileMimeType(new File([source], 'adam.ts', { type: 'video/mp2t' }))).toBe('text/typescript')
    expect(await sniffFileMimeType(new File([source], 'adam.ts', { type: 'text/vnd.trolltech.linguist' }))).toBe('text/typescript')
    expect(await sniffFileMimeType(new File([source], 'mod.mts', { type: 'video/mp2t' }))).toBe('text/typescript')
    expect(await sniffFileMimeType(new File([packets(188, 0)], 'screen.ts', { type: '' }))).toBe('video/mp2t')
    // AVCHD: 192-byte packets, a 4-byte timestamp before each sync byte.
    expect(await sniffFileMimeType(new File([packets(192, 4)], '00001.MTS', { type: '' }))).toBe('video/mp2t')
    expect(await sniffFileMimeType(new File([packets(192, 4)], '00001.m2ts', { type: '' }))).toBe('video/mp2t')
    // One packet is not enough: a text file can start with "G".
    expect(await sniffFileMimeType(new File([new TextEncoder().encode('G'.repeat(10))], 'g.ts', { type: '' }))).toBe('text/typescript')
    // Opening one reads the same bytes, whatever type it was stored with; other suffixes are never sniffed.
    expect(await isMpegTsVideo('screen.ts', new Blob([packets(188, 0)]))).toBe(true)
    expect(await isMpegTsVideo('adam.ts', new Blob([source]))).toBe(false)
    expect(await isMpegTsVideo('notes.txt', new Blob([packets(188, 0)]))).toBe(false)
    const sniffed = new File([source], 'adam.ts', { type: 'video/mp2t' })
    await sniffFileMimeType(sniffed)
    expect(resolveFileMimeType(sniffed)).toBe('text/typescript')
  })
  it('names other suffixes from the table, and an already-sent file by what it stored', () => {
    expect(resolveFileMimeType({ name: 'mod.cts', type: '' })).toBe('text/typescript')
    expect(resolveFileMimeType({ name: 'notes.md', type: 'application/x-whatever' })).toBe('text/markdown')
    // Not looked at yet: the OS guess, as before.
    expect(resolveFileMimeType({ name: 'adam.ts', type: 'video/mp2t' })).toBe('video/mp2t')
    // A card has only the stored type, so an old .ts stays as it was sent.
    expect(attachmentTypeKey({ fileName: 'adam.ts', mimeType: 'video/mp2t' })).toBe('video')
  })
})

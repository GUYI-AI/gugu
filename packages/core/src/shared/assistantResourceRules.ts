/**
 * What the assistant's 给助理的资料 takes, one rule for every door that puts something there: the assistant's own pages
 * (assistant-files.ts re-exports these) and an App the person lets manage it (#50, app-bound-resources-manage.ts).
 */

/** 上传规矩:单个文件 50MB 以内;视频、音频、压缩包不收(助理读不了)。 */
export const RESOURCE_MAX_BYTES = 50 * 1024 * 1024;
const REJECTED_EXTENSIONS = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|mp3|wav|m4a|aac|flac|ogg|opus|zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;

export type ResourceRejection = 'too_large' | 'unsupported';

export function resourceRejection(file: { name: string; size: number; type?: string }): ResourceRejection | null {
  if (file.size > RESOURCE_MAX_BYTES) return 'too_large';
  const type = file.type ?? '';
  if (REJECTED_EXTENSIONS.test(file.name) || type.startsWith('video/') || type.startsWith('audio/')) return 'unsupported';
  return null;
}

/** 名字只能是一段(新建文件夹、重命名):非空、不含 `/`。 */
export function folderNameProblem(name: string): 'required' | 'slash' | null {
  if (!name.trim()) return 'required';
  if (name.includes('/')) return 'slash';
  return null;
}

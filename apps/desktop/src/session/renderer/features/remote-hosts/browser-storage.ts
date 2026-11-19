/** 这一端的 localStorage;读不到(隐私模式、非浏览器环境)= null,调用方按「没有」处理。 */
export function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
